import { isDeepStrictEqual } from "node:util";
import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import type { CronServiceAgentKeyScope } from "@paperclipai/shared";

type CronIssue = {
  title: string;
  createdByAgentId: string | null;
  executionPolicy: unknown;
};

type CronRequest = {
  method: string;
  path: string;
  query: string;
  body: unknown;
  companyId: string;
  agentId: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function keysAre(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  const data = record(value);
  return data !== null
    && required.every((key) => Object.hasOwn(data, key))
    && Object.keys(data).every((key) => required.includes(key) || optional.includes(key));
}

function withoutMonitor(value: unknown) {
  const policy = record(value);
  if (!policy) return { mode: "normal", stages: [] };
  const { monitor: _monitor, ...rest } = policy;
  return { mode: "normal", stages: [], ...rest };
}

function watchdogMonitorUpdate(body: unknown, existingPolicy: unknown) {
  if (!keysAre(body, ["executionPolicy"])) return false;
  const policy = record(body.executionPolicy);
  const monitor = record(policy?.monitor);
  if (!policy || !monitor) return false;
  if (!keysAre(monitor, ["kind", "serviceName", "recoveryPolicy", "maxAttempts", "nextCheckAt"],
    ["scheduledBy", "notes"])) return false;
  if (monitor.kind !== "external_service" || monitor.serviceName !== "paperclip-board"
    || monitor.recoveryPolicy !== "wake_owner" || monitor.maxAttempts !== 100) return false;
  if (typeof monitor.nextCheckAt !== "string") return false;
  const nextCheckAt = Date.parse(monitor.nextCheckAt);
  if (!Number.isFinite(nextCheckAt) || nextCheckAt < Date.now() - 120_000
    || nextCheckAt > Date.now() + 26 * 60 * 60_000) return false;
  if (monitor.scheduledBy !== undefined && monitor.scheduledBy !== "board") return false;
  if (monitor.notes !== undefined && (typeof monitor.notes !== "string" || monitor.notes.length > 500)) return false;
  return isDeepStrictEqual(withoutMonitor(policy), withoutMonitor(existingPolicy));
}

const UUID_PATH = "[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}";
const ISSUE_PATH = new RegExp(`^/api/issues/(${UUID_PATH})(/comments)?$`);
const AGENT_PATH = new RegExp(`^/api/agents/(${UUID_PATH})$`);
const CREATE_PATH = new RegExp(`^/api/companies/(${UUID_PATH})/issues$`);
const AGENT_LIST_PATH = new RegExp(`^/api/companies/(${UUID_PATH})/agents$`);

/** Additional key boundary. Ordinary route authorization still runs afterwards. */
export async function cronServiceRequestAllowed(
  scope: CronServiceAgentKeyScope,
  request: CronRequest,
  getIssue: (issueId: string) => Promise<CronIssue | null>,
  getAgentStatus: (agentId: string) => Promise<string | null>,
): Promise<boolean> {
  const { method, path, query, body, companyId, agentId } = request;
  if (query) return false;
  const issueMatch = ISSUE_PATH.exec(path);
  const createMatch = CREATE_PATH.exec(path);

  if (scope.service === "agent_watchdog") {
    if (method === "GET" && AGENT_LIST_PATH.exec(path)?.[1] === companyId) return true;
    if (method === "PATCH" && AGENT_PATH.test(path)) {
      const targetId = AGENT_PATH.exec(path)![1]!;
      return keysAre(body, ["status"]) && body.status === "idle"
        && ["error", "offline", "crashed"].includes(await getAgentStatus(targetId) ?? "");
    }
    if (!issueMatch || !scope.alarmIssueIds.includes(issueMatch[1]!)) return false;
    if (method === "POST" && issueMatch[2] === "/comments") {
      return keysAre(body, ["body"]) && typeof body.body === "string" && body.body.length <= 4000;
    }
    if (method !== "PATCH" || issueMatch[2]) return false;
    const issue = await getIssue(issueMatch[1]!);
    return Boolean(issue && watchdogMonitorUpdate(body, issue.executionPolicy));
  }

  if (createMatch?.[1] === companyId && method === "POST") {
    if (scope.service === "quota_rewake") {
      return keysAre(body, ["title", "description", "status", "assigneeAgentId"], ["priority"])
        && typeof body.title === "string" && body.title.startsWith("[quota-rewake] ")
        && body.status === "todo" && typeof body.description === "string"
        && typeof body.assigneeAgentId === "string"
        && (body.priority === undefined || body.priority === "high");
    }
    return keysAre(body, ["title", "description", "priority", "assigneeAgentId", "projectId", "status"])
      && typeof body.title === "string" && body.title.startsWith("🔴 Фронт-деплой:")
      && typeof body.description === "string" && body.priority === "high" && body.status === "todo"
      && body.assigneeAgentId === scope.assigneeAgentId && body.projectId === scope.projectId;
  }

  if (!issueMatch) return false;
  const issue = await getIssue(issueMatch[1]!);
  if (!issue) return false;
  const ownPrefix = scope.service === "quota_rewake" ? "[quota-rewake] " : "🔴 Фронт-деплой:";
  const owned = issue.createdByAgentId === agentId && issue.title.startsWith(ownPrefix);
  if (!owned) return false;
  if (method === "GET" && !issueMatch[2]) return true;
  if (scope.service === "deploy_frontend" && method === "POST" && issueMatch[2] === "/comments") {
    return keysAre(body, ["body"]) && typeof body.body === "string" && body.body.length <= 16000;
  }
  if (method !== "PATCH" || issueMatch[2]) return false;
  if (scope.service === "quota_rewake") {
    return keysAre(body, ["status", "comment"]) && body.status === "cancelled"
      && typeof body.comment === "string";
  }
  return keysAre(body, ["status"], ["comment"]) && (body.status === "done" || body.status === "cancelled")
    && (body.comment === undefined || typeof body.comment === "string");
}

export function cronServiceKeyGuard(db: Db): RequestHandler {
  return async (req, res, next) => {
    const actor = req.actor;
    if (actor.type !== "agent" || actor.keyScope?.kind !== "cron_service") return next();
    if (actor.source !== "agent_key" || !actor.agentId || !actor.companyId) {
      res.status(403).json({ error: "Cron service scope requires an API key" });
      return;
    }
    const url = new URL(req.originalUrl, "http://localhost");
    try {
      const allowed = await cronServiceRequestAllowed(actor.keyScope, {
        method: req.method,
        path: url.pathname,
        query: url.search,
        body: req.body,
        companyId: actor.companyId,
        agentId: actor.agentId,
      }, async (id) => db.select({
        title: issues.title,
        createdByAgentId: issues.createdByAgentId,
        executionPolicy: issues.executionPolicy,
      }).from(issues).where(and(eq(issues.id, id), eq(issues.companyId, actor.companyId!)))
        .then((rows) => rows[0] ?? null), async (id) => db.select({ status: agents.status })
        .from(agents).where(and(eq(agents.id, id), eq(agents.companyId, actor.companyId!)))
        .then((rows) => rows[0]?.status ?? null));
      if (!allowed) {
        res.status(403).json({ error: "API operation is outside this cron service key's scope" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
