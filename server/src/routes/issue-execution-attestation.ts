import { Router, type Request, type Response } from "express";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions, issueWorkProducts, issues } from "@paperclipai/db";
import {
  issueExecutionPolicySchema,
  issueExecutionStateSchema,
  normalizeIssueIdentifier,
} from "@paperclipai/shared";
import { accessService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Read-only attestation projection of an issue's typed review chain.
 *
 * External verifiers (for example a bridge that publishes a GitHub commit status once every
 * review stage approved the exact PR head) need the stage decisions themselves, which are
 * otherwise only written. The projection does not interpret the chain: it returns the current
 * policy stages, the execution state and every recorded decision in order, and the verifier
 * decides fail-closed. Monitor settings and review-request text are left out on purpose.
 */

export const EXECUTION_ATTESTATION_SCHEMA_VERSION = 1;
export const EXECUTION_ATTESTATION_MAX_ISSUES = 20;
/** Comma-separated agent ids allowed to read attestations (the verifier's service identity). */
export const EXECUTION_ATTESTATION_READERS_ENV = "PAPERCLIP_EXECUTION_ATTESTATION_READER_AGENT_IDS";

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PULL_REQUEST_NUMBER = 100_000_000;

type IssueAttestationRow = {
  id: string;
  identifier: string | null;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
  executionPolicy: unknown;
  executionState: unknown;
  completedAt: Date | null;
  updatedAt: Date;
};

const issueAttestationColumns = {
  id: issues.id,
  identifier: issues.identifier,
  companyId: issues.companyId,
  projectId: issues.projectId,
  parentId: issues.parentId,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  status: issues.status,
  executionPolicy: issues.executionPolicy,
  executionState: issues.executionState,
  completedAt: issues.completedAt,
  updatedAt: issues.updatedAt,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function projectPrincipal(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  return {
    type: stringOrNull(record.type),
    agentId: stringOrNull(record.agentId),
    userId: stringOrNull(record.userId),
  };
}

/** Stages exactly as stored. `valid` is false when the stored policy does not parse or a stage has no id. */
function projectExecutionPolicy(raw: unknown) {
  const record = asRecord(raw);
  if (!record) return null;
  const rawStages = Array.isArray(record.stages) ? record.stages : [];
  const stages = rawStages.map((candidate) => {
    const stage = asRecord(candidate) ?? {};
    const participants = Array.isArray(stage.participants) ? stage.participants : [];
    return {
      id: stringOrNull(stage.id),
      type: stringOrNull(stage.type),
      approvalsNeeded: typeof stage.approvalsNeeded === "number" ? stage.approvalsNeeded : null,
      participants: participants.map(projectPrincipal).filter((participant) => participant !== null),
    };
  });
  const valid = issueExecutionPolicySchema.safeParse(raw).success && stages.every((stage) => stage.id !== null);
  return { valid, stages };
}

function projectExecutionState(raw: unknown) {
  const record = asRecord(raw);
  if (!record) return null;
  return {
    valid: issueExecutionStateSchema.safeParse(raw).success,
    status: stringOrNull(record.status),
    currentStageId: stringOrNull(record.currentStageId),
    currentStageIndex: typeof record.currentStageIndex === "number" ? record.currentStageIndex : null,
    currentStageType: stringOrNull(record.currentStageType),
    currentParticipant: projectPrincipal(record.currentParticipant),
    returnAssignee: projectPrincipal(record.returnAssignee),
    completedStageIds: Array.isArray(record.completedStageIds)
      ? record.completedStageIds.filter((value): value is string => typeof value === "string")
      : [],
    lastDecisionId: stringOrNull(record.lastDecisionId),
    lastDecisionOutcome: stringOrNull(record.lastDecisionOutcome),
  };
}

function parseGithubPullRequestUrl(url: string | null) {
  if (!url) return null;
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/i.exec(url.trim());
  if (!match) return null;
  return { repo: match[1]!, number: Number(match[2]) };
}

function parseGithubPullRequestExternalId(externalId: string | null) {
  if (!externalId) return null;
  const match = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(externalId.trim());
  if (!match) return null;
  return { repo: match[1]!, number: Number(match[2]) };
}

export function parseAttestationReaderAgentIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => UUID_PATTERN.test(value));
}

/**
 * Board members read through the regular company and issue read decisions. Agents read only
 * when listed as readers: a verifier runs under a narrow (for example `task_bridge`) key that
 * has no company-wide read grant, and ordinary agent keys have no reason to read the chain.
 */
export function issueExecutionAttestationRoutes(
  db: Db,
  opts: { readerAgentIds?: readonly string[] } = {},
) {
  const router = Router();
  const access = accessService(db);
  const readerAgentIds = new Set(
    (opts.readerAgentIds ?? parseAttestationReaderAgentIds(process.env[EXECUTION_ATTESTATION_READERS_ENV])).map(
      (id) => id.toLowerCase(),
    ),
  );

  function isReaderAgent(req: Request) {
    return req.actor.type === "agent" && !!req.actor.agentId && readerAgentIds.has(req.actor.agentId.toLowerCase());
  }

  function rejectUnlistedAgent(req: Request, res: Response) {
    if (req.actor.type !== "agent" || isReaderAgent(req)) return false;
    res.status(403).json({ error: "Execution attestation is limited to its configured reader agents" });
    return true;
  }

  async function issueReadAllowed(req: Request, issue: IssueAttestationRow) {
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
      scope: {
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
      },
    });
    return decision.allowed;
  }

  async function companyScopeReadAllowed(req: Request, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  }

  async function loadIssueByRef(rawRef: string) {
    const identifier = normalizeIssueIdentifier(rawRef);
    if (!identifier && !UUID_PATTERN.test(rawRef)) return null;
    const condition = identifier ? eq(issues.identifier, identifier) : eq(issues.id, rawRef);
    const rows = await db.select(issueAttestationColumns).from(issues).where(condition).limit(1);
    return (rows[0] as IssueAttestationRow | undefined) ?? null;
  }

  async function buildAttestations(rows: IssueAttestationRow[]) {
    if (rows.length === 0) return [];
    const issueIds = rows.map((row) => row.id);
    const decisions = await db
      .select({
        id: issueExecutionDecisions.id,
        issueId: issueExecutionDecisions.issueId,
        stageId: issueExecutionDecisions.stageId,
        stageType: issueExecutionDecisions.stageType,
        outcome: issueExecutionDecisions.outcome,
        actorAgentId: issueExecutionDecisions.actorAgentId,
        actorUserId: issueExecutionDecisions.actorUserId,
        body: issueExecutionDecisions.body,
        createdAt: issueExecutionDecisions.createdAt,
      })
      .from(issueExecutionDecisions)
      .where(inArray(issueExecutionDecisions.issueId, issueIds))
      .orderBy(asc(issueExecutionDecisions.createdAt), asc(issueExecutionDecisions.id));
    const pullRequests = await db
      .select({
        id: issueWorkProducts.id,
        issueId: issueWorkProducts.issueId,
        externalId: issueWorkProducts.externalId,
        url: issueWorkProducts.url,
        status: issueWorkProducts.status,
        isPrimary: issueWorkProducts.isPrimary,
        metadata: issueWorkProducts.metadata,
        createdAt: issueWorkProducts.createdAt,
        updatedAt: issueWorkProducts.updatedAt,
      })
      .from(issueWorkProducts)
      .where(
        and(
          inArray(issueWorkProducts.issueId, issueIds),
          eq(issueWorkProducts.provider, "github"),
          eq(issueWorkProducts.type, "pull_request"),
        ),
      )
      .orderBy(asc(issueWorkProducts.createdAt), asc(issueWorkProducts.id));

    return rows.map((row) => ({
      issue: {
        id: row.id,
        identifier: row.identifier,
        companyId: row.companyId,
        status: row.status,
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        updatedAt: row.updatedAt.toISOString(),
      },
      executionPolicy: projectExecutionPolicy(row.executionPolicy),
      executionState: projectExecutionState(row.executionState),
      decisions: decisions
        .filter((decision) => decision.issueId === row.id)
        .map(({ issueId: _issueId, createdAt, ...decision }) => ({
          ...decision,
          createdAt: createdAt.toISOString(),
        })),
      githubPullRequests: pullRequests
        .filter((pullRequest) => pullRequest.issueId === row.id)
        .map(({ issueId: _issueId, createdAt, updatedAt, ...pullRequest }) => {
          const parsed =
            parseGithubPullRequestExternalId(pullRequest.externalId) ?? parseGithubPullRequestUrl(pullRequest.url);
          return {
            ...pullRequest,
            repo: parsed?.repo ?? null,
            number: parsed?.number ?? null,
            createdAt: createdAt.toISOString(),
            updatedAt: updatedAt.toISOString(),
          };
        }),
    }));
  }

  router.get("/issues/:id/execution-attestation", async (req: Request, res: Response) => {
    const issue = await loadIssueByRef(req.params.id as string);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (rejectUnlistedAgent(req, res)) return;
    if (!isReaderAgent(req) && !(await issueReadAllowed(req, issue))) {
      res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
      return;
    }
    const [attestation] = await buildAttestations([issue]);
    res.json({
      schemaVersion: EXECUTION_ATTESTATION_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      ...attestation,
    });
  });

  router.get("/companies/:companyId/execution-attestations", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (rejectUnlistedAgent(req, res)) return;
    if (!isReaderAgent(req) && !(await companyScopeReadAllowed(req, companyId))) {
      res.status(403).json({ error: "Company is outside this actor's authorization boundary" });
      return;
    }
    const repo = typeof req.query.repo === "string" ? req.query.repo.trim() : "";
    const prRaw = typeof req.query.pr === "string" ? req.query.pr.trim() : "";
    const pullRequestNumber = /^[1-9]\d*$/.test(prRaw) ? Number(prRaw) : NaN;
    if (!GITHUB_REPO_PATTERN.test(repo) || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber > MAX_PULL_REQUEST_NUMBER) {
      res.status(400).json({ error: "Query must be repo=<owner>/<name>&pr=<positive number>" });
      return;
    }

    const externalId = `${repo}#${pullRequestNumber}`.toLowerCase();
    const url = `https://github.com/${repo}/pull/${pullRequestNumber}`.toLowerCase();
    const linked = await db
      .selectDistinct({ issueId: issueWorkProducts.issueId })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.provider, "github"),
          eq(issueWorkProducts.type, "pull_request"),
          or(
            sql`lower(trim(${issueWorkProducts.externalId})) = ${externalId}`,
            sql`lower(rtrim(trim(${issueWorkProducts.url}), '/')) = ${url}`,
          ),
        ),
      )
      .limit(EXECUTION_ATTESTATION_MAX_ISSUES + 1);

    const truncated = linked.length > EXECUTION_ATTESTATION_MAX_ISSUES;
    const issueIds = linked.slice(0, EXECUTION_ATTESTATION_MAX_ISSUES).map((row) => row.issueId);
    const rows = issueIds.length
      ? ((await db
          .select(issueAttestationColumns)
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)))
          .orderBy(asc(issues.createdAt), asc(issues.id))) as IssueAttestationRow[])
      : [];
    const readable: IssueAttestationRow[] = [];
    let withheld = 0;
    for (const row of rows) {
      if (isReaderAgent(req) || (await issueReadAllowed(req, row))) readable.push(row);
      else withheld += 1;
    }

    res.json({
      schemaVersion: EXECUTION_ATTESTATION_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      repo,
      pullRequestNumber,
      truncated,
      withheld,
      attestations: await buildAttestations(readable),
    });
  });

  return router;
}
