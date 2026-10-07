import { and, asc, desc, eq, getTableColumns, gte, isNull, lte, ne, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  documentRevisions,
  documents,
  feedbackExports,
  feedbackVotes,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  instanceGeneralSettingsSchema,
  type FeedbackTargetType,
  type FeedbackTraceBundle,
  type FeedbackTraceBundleCaptureStatus,
  type FeedbackTraceBundleFile,
  type FeedbackTrace,
  type FeedbackTraceStatus,
  type FeedbackTraceTargetSummary,
  type FeedbackVoteValue,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import {
  createFeedbackRedactionState,
  finalizeFeedbackRedactionSummary,
  sha256Digest,
} from "./feedback-redaction.js";
import {
  projectSafeError,
  projectSafeErrorCode,
  projectSafeResultJson,
  projectSafeRunEvent,
  projectSafeUsageJson,
} from "./safe-run-carriers.js";

const FEEDBACK_SCHEMA_VERSION = "paperclip-feedback-envelope-v2";
const FEEDBACK_BUNDLE_VERSION = "paperclip-feedback-bundle-v2";
const FEEDBACK_PAYLOAD_VERSION = "paperclip-feedback-v1";
const FEEDBACK_DESTINATION = "paperclip_labs_feedback_v1";
const DEFAULT_INSTANCE_SETTINGS_SINGLETON_KEY = "default";
const FEEDBACK_EXPORT_BACKEND_NOT_CONFIGURED = "Feedback export backend is not configured";

type FeedbackTraceRow = typeof feedbackExports.$inferSelect & {
  issueIdentifier: string | null;
  issueTitle: string;
};

type PendingFeedbackExportRow = typeof feedbackExports.$inferSelect;

type IssueFeedbackContext = {
  id: string;
  companyId: string;
  projectId: string | null;
  identifier: string | null;
  title: string;
  description: string | null;
};

type FeedbackTargetRecord = {
  targetType: FeedbackTargetType;
  targetId: string;
  label: string;
  body: string;
  createdAt: Date;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorType?: string | null;
  presentation?: unknown;
  metadata?: unknown;
  createdByRunId: string | null;
  documentId: string | null;
  documentKey: string | null;
  documentTitle: string | null;
  revisionNumber: number | null;
  issuePath: string | null;
  targetPath: string | null;
};

type ResolvedFeedbackTarget = FeedbackTargetRecord & {
  payloadTarget: Record<string, unknown>;
};

const feedbackExportColumns = getTableColumns(feedbackExports);

type FeedbackTraceShareClient = {
  uploadTraceBundle(bundle: FeedbackTraceBundle): Promise<{ objectKey: string }>;
};

type FeedbackServiceOptions = {
  shareClient?: FeedbackTraceShareClient;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeInstanceGeneralSettings(raw: unknown) {
  const parsed = instanceGeneralSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  return {
    censorUsernameInLogs: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  };
}

function buildIssuePath(identifier: string | null) {
  if (!identifier) return null;
  const prefix = identifier.split("-")[0]?.trim();
  if (!prefix) return null;
  return `/${prefix}/issues/${identifier}`;
}

function buildTargetSummary(input: {
  label: string;
  excerpt: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date | null;
  documentKey?: string | null;
  documentTitle?: string | null;
  revisionNumber?: number | null;
}): FeedbackTraceTargetSummary {
  return {
    label: input.label,
    excerpt: input.excerpt,
    authorAgentId: input.authorAgentId,
    authorUserId: input.authorUserId,
    createdAt: input.createdAt,
    documentKey: input.documentKey ?? null,
    documentTitle: input.documentTitle ?? null,
    revisionNumber: input.revisionNumber ?? null,
  };
}

function normalizeReason(vote: FeedbackVoteValue, reason: string | null | undefined) {
  if (vote !== "down" || typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildExportId(feedbackVoteId: string, sharedAt: Date) {
  return `fbexp_${sha256Digest(`${feedbackVoteId}:${sharedAt.toISOString()}`).slice(0, 24)}`;
}

function resolveSourceRunId(payloadSnapshot: Record<string, unknown> | null) {
  const targetRunId = asString(asRecord(payloadSnapshot?.target)?.createdByRunId);
  const bundle = asRecord(payloadSnapshot?.bundle);
  const agentContext = asRecord(bundle?.agentContext);
  const runtime = asRecord(agentContext?.runtime);
  const candidate = targetRunId ?? asString(asRecord(runtime?.sourceRun)?.id);
  return candidate && /^[0-9a-fA-F-]{36}$/.test(candidate) ? candidate : null;
}

function makeBundleFile(input: {
  path: string;
  contentType: string;
  source: FeedbackTraceBundleFile["source"];
  contents: string;
}) {
  return {
    path: input.path,
    contentType: input.contentType,
    encoding: "utf8" as const,
    byteLength: Buffer.byteLength(input.contents, "utf8"),
    sha256: sha256Digest(input.contents),
    source: input.source,
    contents: input.contents,
  } satisfies FeedbackTraceBundleFile;
}

function appendNote(notes: string[], note: string) {
  if (note.trim().length === 0 || notes.includes(note)) return;
  notes.push(note);
}

function truncateFailureReason(_error: unknown) {
  return "Feedback export failed";
}

function safeFeedbackSnapshotFromRow(row: FeedbackTraceRow): Record<string, unknown> {
  const sourceRunId = resolveSourceRunId(asRecord(row.payloadSnapshot));
  return {
    schemaVersion: row.schemaVersion,
    bundleVersion: row.bundleVersion,
    sourceApp: "paperclip",
    exportId: row.exportId,
    exportEligible: row.status !== "local_only",
    vote: {
      id: row.feedbackVoteId,
      value: row.vote,
      reason: null,
      authorUserId: row.authorUserId,
      sharedWithLabs: row.status !== "local_only",
    },
    target: { type: row.targetType, id: row.targetId, createdByRunId: sourceRunId },
    bundle: row.status === "local_only" ? null : {
      primaryContent: { type: row.targetType, id: row.targetId, createdByRunId: sourceRunId, body: null, excerpt: null },
      issueContext: { issue: { id: row.issueId }, items: [] },
      agentContext: null,
    },
    redactionSummary: { strategy: "safe_carrier_allowlist_v1", providerRawTraceExcluded: true },
  };
}

function mapTraceRow(row: FeedbackTraceRow, includePayload: boolean): FeedbackTrace {
  const safeSnapshot = safeFeedbackSnapshotFromRow(row);
  return {
    id: row.id,
    companyId: row.companyId,
    feedbackVoteId: row.feedbackVoteId,
    issueId: row.issueId,
    projectId: row.projectId ?? null,
    issueIdentifier: row.issueIdentifier,
    issueTitle: "[content omitted]",
    authorUserId: row.authorUserId,
    targetType: row.targetType as FeedbackTargetType,
    targetId: row.targetId,
    vote: row.vote as FeedbackVoteValue,
    status: row.status as FeedbackTraceStatus,
    destination: row.destination ?? null,
    exportId: row.exportId ?? null,
    consentVersion: row.consentVersion ?? null,
    schemaVersion: row.schemaVersion,
    bundleVersion: row.bundleVersion,
    payloadVersion: row.payloadVersion,
    payloadDigest: sha256Digest(safeSnapshot),
    payloadSnapshot: includePayload ? safeSnapshot : null,
    targetSummary: buildTargetSummary({
      label: row.targetType,
      excerpt: null,
      authorAgentId: null,
      authorUserId: null,
      createdAt: null,
    }),
    redactionSummary: { strategy: "safe_carrier_allowlist_v1", providerRawTraceExcluded: true },
    attemptCount: row.attemptCount,
    lastAttemptedAt: row.lastAttemptedAt ?? null,
    exportedAt: row.exportedAt ?? null,
    failureReason: row.failureReason ? "Feedback export failed" : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function resolveFeedbackTarget(
  db: Pick<Db, "select">,
  issue: IssueFeedbackContext,
  targetType: FeedbackTargetType,
  targetId: string,
): Promise<ResolvedFeedbackTarget> {
  const issuePath = buildIssuePath(issue.identifier);

  if (targetType === "issue_comment") {
    const targetComment = await db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        companyId: issueComments.companyId,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        authorType: issueComments.authorType,
        presentation: issueComments.presentation,
        metadata: issueComments.metadata,
        createdByRunId: issueComments.createdByRunId,
        body: issueComments.body,
        deletedAt: issueComments.deletedAt,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.id, targetId))
      .then((rows) => rows[0] ?? null);

    if (!targetComment || targetComment.issueId !== issue.id || targetComment.companyId !== issue.companyId) {
      throw notFound("Feedback target not found");
    }
    if (targetComment.deletedAt) {
      throw notFound("Feedback target not found");
    }
    if (!targetComment.authorAgentId) {
      throw unprocessable("Feedback voting is only available on agent-authored issue comments");
    }

    const record: ResolvedFeedbackTarget = {
      targetType,
      targetId,
      label: "Comment",
      body: targetComment.body,
      createdAt: targetComment.createdAt,
      authorAgentId: targetComment.authorAgentId,
      authorUserId: targetComment.authorUserId,
      authorType: targetComment.authorType ?? (targetComment.authorAgentId ? "agent" : targetComment.authorUserId ? "user" : "system"),
      presentation: targetComment.presentation ?? null,
      metadata: targetComment.metadata ?? null,
      createdByRunId: targetComment.createdByRunId ?? null,
      documentId: null,
      documentKey: null,
      documentTitle: null,
      revisionNumber: null,
      issuePath,
      targetPath: issuePath ? `${issuePath}#comment-${targetComment.id}` : null,
      payloadTarget: {
        type: targetType,
        id: targetComment.id,
        createdAt: targetComment.createdAt.toISOString(),
        authorAgentId: targetComment.authorAgentId,
        authorUserId: targetComment.authorUserId,
        authorType: targetComment.authorType ?? (targetComment.authorAgentId ? "agent" : targetComment.authorUserId ? "user" : "system"),
        presentation: targetComment.presentation ?? null,
        metadata: targetComment.metadata ?? null,
        createdByRunId: targetComment.createdByRunId ?? null,
        issuePath,
        targetPath: issuePath ? `${issuePath}#comment-${targetComment.id}` : null,
      },
    };
    return record;
  }

  if (targetType === "issue_document_revision") {
    const targetRevision = await db
      .select({
        id: documentRevisions.id,
        companyId: documentRevisions.companyId,
        documentId: documentRevisions.documentId,
        revisionNumber: documentRevisions.revisionNumber,
        body: documentRevisions.body,
        createdByAgentId: documentRevisions.createdByAgentId,
        createdByUserId: documentRevisions.createdByUserId,
        createdByRunId: documentRevisions.createdByRunId,
        createdAt: documentRevisions.createdAt,
        issueId: issueDocuments.issueId,
        key: issueDocuments.key,
        title: documents.title,
      })
      .from(documentRevisions)
      .innerJoin(documents, eq(documentRevisions.documentId, documents.id))
      .innerJoin(issueDocuments, eq(issueDocuments.documentId, documents.id))
      .where(eq(documentRevisions.id, targetId))
      .then((rows) => rows.find((row) => row.issueId === issue.id) ?? null);

    if (!targetRevision || targetRevision.companyId !== issue.companyId) {
      throw notFound("Feedback target not found");
    }
    if (!targetRevision.createdByAgentId) {
      throw unprocessable("Feedback voting is only available on agent-authored document revisions");
    }

    const record: ResolvedFeedbackTarget = {
      targetType,
      targetId,
      label: `${targetRevision.key} rev ${targetRevision.revisionNumber}`,
      body: targetRevision.body,
      createdAt: targetRevision.createdAt,
      authorAgentId: targetRevision.createdByAgentId,
      authorUserId: targetRevision.createdByUserId,
      createdByRunId: targetRevision.createdByRunId ?? null,
      documentId: targetRevision.documentId,
      documentKey: targetRevision.key,
      documentTitle: targetRevision.title ?? null,
      revisionNumber: targetRevision.revisionNumber,
      issuePath,
      targetPath: issuePath ? `${issuePath}#document-${encodeURIComponent(targetRevision.key)}` : null,
      payloadTarget: {
        type: targetType,
        id: targetRevision.id,
        documentId: targetRevision.documentId,
        documentKey: targetRevision.key,
        documentTitle: targetRevision.title ?? null,
        revisionNumber: targetRevision.revisionNumber,
        createdAt: targetRevision.createdAt.toISOString(),
        authorAgentId: targetRevision.createdByAgentId,
        authorUserId: targetRevision.createdByUserId,
        createdByRunId: targetRevision.createdByRunId ?? null,
        issuePath,
        targetPath: issuePath ? `${issuePath}#document-${encodeURIComponent(targetRevision.key)}` : null,
      },
    };
    return record;
  }

  throw unprocessable("Unsupported feedback target type");
}

async function buildPayloadArtifacts(
  _db: Pick<Db, "select">,
  input: {
    issue: IssueFeedbackContext;
    target: ResolvedFeedbackTarget;
    voteId: string;
    vote: FeedbackVoteValue;
    reason: string | null;
    authorUserId: string;
    consentVersion: string | null;
    sharedWithLabs: boolean;
    now: Date;
  },
) {
  // Feedback is a projection of typed control-plane metadata. A vote may be
  // attached to a comment or document, but its body and nearby issue content
  // are never copied into a feedback carrier.
  const state = createFeedbackRedactionState();
  state.notes.add("provider_raw_trace_excluded");
  state.omittedFields.add("bundle.primaryContent.body");
  state.omittedFields.add("bundle.issueContext.items");
  state.omittedFields.add("bundle.agentContext.instructions");
  const sourceRunId = input.target.createdByRunId;
  const targetSummary = buildTargetSummary({
    label: input.target.targetType,
    excerpt: null,
    authorAgentId: input.target.authorAgentId,
    authorUserId: input.target.authorUserId,
    createdAt: input.target.createdAt,
  });
  const payloadSnapshot = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    bundleVersion: FEEDBACK_BUNDLE_VERSION,
    sourceApp: "paperclip",
    capturedAt: input.now.toISOString(),
    consentVersion: input.consentVersion,
    exportId: input.sharedWithLabs ? buildExportId(input.voteId, input.now) : null,
    exportEligible: input.sharedWithLabs,
    vote: {
      id: input.voteId,
      value: input.vote,
      reason: null,
      authorUserId: input.authorUserId,
      sharedWithLabs: input.sharedWithLabs,
      sharedAt: input.sharedWithLabs ? input.now.toISOString() : null,
    },
    target: {
      type: input.target.targetType,
      id: input.target.targetId,
      createdByRunId: sourceRunId,
    },
    bundle: input.sharedWithLabs ? {
      primaryContent: {
        type: input.target.targetType,
        id: input.target.targetId,
        createdByRunId: sourceRunId,
        body: null,
        excerpt: null,
      },
      issueContext: { issue: { id: input.issue.id }, items: [] },
      agentContext: null,
    } : null,
  };
  const redactionSummary = finalizeFeedbackRedactionSummary(state);
  const safeSnapshot = { ...payloadSnapshot, redactionSummary };
  return {
    exportId: payloadSnapshot.exportId,
    targetSummary,
    redactionSummary,
    payloadSnapshot: safeSnapshot,
    payloadDigest: sha256Digest(safeSnapshot),
  };
}

async function buildFeedbackTraceBundleFromRow(
  db: Db,
  row: FeedbackTraceRow,
): Promise<FeedbackTraceBundle> {
  const trace = mapTraceRow(row, true);
  const notes = ["provider_raw_trace_excluded", "run_log_excluded"];
  const files: FeedbackTraceBundleFile[] = [];
  // Existing rows may contain content-bearing snapshots. Use the run pointer
  // only, then construct the bundle from a fresh allowlist projection.
  const sourceRunId = resolveSourceRunId(asRecord(row.payloadSnapshot));
  let paperclipRun: Record<string, unknown> | null = null;
  let adapterType: string | null = null;

  if (sourceRunId) {
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        exitCode: heartbeatRuns.exitCode,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.id, sourceRunId))
      .then((rows) => rows[0] ?? null);

    if (run && run.companyId === row.companyId) {
      adapterType = run.adapterType;
      const events = await db
        .select({
          seq: heartbeatRunEvents.seq,
          eventType: heartbeatRunEvents.eventType,
          stream: heartbeatRunEvents.stream,
          level: heartbeatRunEvents.level,
          message: heartbeatRunEvents.message,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, run.id))
        .orderBy(asc(heartbeatRunEvents.seq));
      const safeEvents = events.map((event) => ({
        seq: event.seq,
        ...projectSafeRunEvent(event),
      }));
      paperclipRun = {
        id: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        adapterType,
        invocationSource: run.invocationSource,
        status: run.status,
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        error: projectSafeError(run.error),
        errorCode: projectSafeErrorCode(run.errorCode),
        exitCode: run.exitCode,
        usage: projectSafeUsageJson(run.usageJson),
        result: projectSafeResultJson(run.resultJson),
        eventCount: safeEvents.length,
      };
      files.push(makeBundleFile({
        path: "paperclip/run.json",
        contentType: "application/json",
        source: "paperclip_run",
        contents: `${JSON.stringify(paperclipRun, null, 2)}\n`,
      }));
      files.push(makeBundleFile({
        path: "paperclip/run-events.json",
        contentType: "application/json",
        source: "paperclip_run_events",
        contents: `${JSON.stringify(safeEvents, null, 2)}\n`,
      }));
    } else {
      notes.push("source_run_unavailable");
    }
  } else {
    notes.push("source_run_missing");
  }

  const envelope = {
    traceId: trace.id,
    exportId: trace.exportId,
    companyId: trace.companyId,
    feedbackVoteId: trace.feedbackVoteId,
    issueId: trace.issueId,
    issueIdentifier: trace.issueIdentifier,
    projectId: trace.projectId,
    authorUserId: trace.authorUserId,
    targetType: trace.targetType,
    targetId: trace.targetId,
    vote: trace.vote,
    status: trace.status,
    destination: trace.destination,
    consentVersion: trace.consentVersion,
    schemaVersion: trace.schemaVersion,
    bundleVersion: trace.bundleVersion,
    payloadVersion: trace.payloadVersion,
    createdAt: trace.createdAt.toISOString(),
    exportedAt: trace.exportedAt?.toISOString() ?? null,
  };
  const surface = {
    target: { type: trace.targetType, id: trace.targetId },
    summary: trace.targetSummary,
  };
  const captureStatus: FeedbackTraceBundleCaptureStatus = files.length > 0 ? "partial" : "unavailable";
  const privacy = {
    strategy: "safe_carrier_allowlist_v1",
    providerRawTraceExcluded: true,
    legacyContentExcluded: true,
  };
  return {
    traceId: trace.id,
    exportId: trace.exportId,
    companyId: trace.companyId,
    issueId: trace.issueId,
    issueIdentifier: trace.issueIdentifier,
    adapterType,
    captureStatus,
    notes,
    envelope,
    surface,
    paperclipRun,
    rawAdapterTrace: null,
    normalizedAdapterTrace: null,
    privacy,
    integrity: {
      payloadDigest: trace.payloadDigest,
      bundleDigest: sha256Digest({
        traceId: trace.id,
        files: files.map((file) => ({ path: file.path, source: file.source, sha256: file.sha256 })),
        captureStatus,
      }),
    },
    files,
  };
}

export function feedbackService(db: Db, options: FeedbackServiceOptions = {}) {
  return {
    listIssueVotesForUser: async (issueId: string, authorUserId: string) =>
      db
        .select()
        .from(feedbackVotes)
        .where(and(eq(feedbackVotes.issueId, issueId), eq(feedbackVotes.authorUserId, authorUserId))),

    listFeedbackTraces: async (input: {
      companyId: string;
      issueId?: string;
      projectId?: string;
      targetType?: FeedbackTargetType;
      vote?: FeedbackVoteValue;
      status?: FeedbackTraceStatus;
      from?: Date;
      to?: Date;
      sharedOnly?: boolean;
      includePayload?: boolean;
    }) => {
      const filters = [eq(feedbackExports.companyId, input.companyId)];
      if (input.issueId) filters.push(eq(feedbackExports.issueId, input.issueId));
      if (input.projectId) filters.push(eq(feedbackExports.projectId, input.projectId));
      if (input.targetType) filters.push(eq(feedbackExports.targetType, input.targetType));
      if (input.vote) filters.push(eq(feedbackExports.vote, input.vote));
      if (input.status) filters.push(eq(feedbackExports.status, input.status));
      if (input.sharedOnly) filters.push(ne(feedbackExports.status, "local_only"));
      if (input.from) filters.push(gte(feedbackExports.createdAt, input.from));
      if (input.to) filters.push(lte(feedbackExports.createdAt, input.to));

      const rows = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(and(...filters))
        .orderBy(desc(feedbackExports.createdAt));

      return rows.map((row) => mapTraceRow(row, input.includePayload === true));
    },

    getFeedbackTraceById: async (traceId: string, includePayload = true) => {
      const row = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(eq(feedbackExports.id, traceId))
        .then((rows) => rows[0] ?? null);
      return row ? mapTraceRow(row, includePayload) : null;
    },

    getFeedbackTraceBundle: async (traceId: string) => {
      const row = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(eq(feedbackExports.id, traceId))
        .then((rows) => rows[0] ?? null);
      return row ? buildFeedbackTraceBundleFromRow(db, row) : null;
    },

    flushPendingFeedbackTraces: async (input?: {
      companyId?: string;
      traceId?: string;
      limit?: number;
      now?: Date;
    }) => {
      const shareClient = options.shareClient;
      if (!shareClient) {
        const filters = [eq(feedbackExports.status, "pending")];
        if (input?.companyId) {
          filters.push(eq(feedbackExports.companyId, input.companyId));
        }
        if (input?.traceId) {
          filters.push(eq(feedbackExports.id, input.traceId));
        }

        const rows = await db
          .select({
            id: feedbackExports.id,
            attemptCount: feedbackExports.attemptCount,
          })
          .from(feedbackExports)
          .where(and(...filters))
          .orderBy(asc(feedbackExports.createdAt), asc(feedbackExports.id))
          .limit(Math.max(1, Math.min(input?.limit ?? 25, 200)));

        const attemptAt = input?.now ?? new Date();
        for (const row of rows) {
          await db
            .update(feedbackExports)
            .set({
              status: "failed",
              attemptCount: row.attemptCount + 1,
              lastAttemptedAt: attemptAt,
              failureReason: FEEDBACK_EXPORT_BACKEND_NOT_CONFIGURED,
              updatedAt: attemptAt,
            })
            .where(eq(feedbackExports.id, row.id));
        }

        return {
          attempted: rows.length,
          sent: 0,
          failed: rows.length,
        };
      }

      const limit = Math.max(1, Math.min(input?.limit ?? 25, 200));
      const filters = [
        or(eq(feedbackExports.status, "pending"), eq(feedbackExports.status, "failed")),
      ];
      if (input?.companyId) {
        filters.push(eq(feedbackExports.companyId, input.companyId));
      }
      if (input?.traceId) {
        filters.push(eq(feedbackExports.id, input.traceId));
      }

      const rows = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(and(...filters))
        .orderBy(asc(feedbackExports.createdAt), asc(feedbackExports.id))
        .limit(limit);

      let attempted = 0;
      let sent = 0;
      let failed = 0;

      for (const row of rows) {
        const attemptAt = input?.now ?? new Date();
        attempted += 1;

        try {
          const bundle = await buildFeedbackTraceBundleFromRow(db, row);
          await shareClient.uploadTraceBundle(bundle);

          await db
            .update(feedbackExports)
            .set({
              status: "sent",
              attemptCount: row.attemptCount + 1,
              lastAttemptedAt: attemptAt,
              exportedAt: attemptAt,
              failureReason: null,
              updatedAt: attemptAt,
            })
            .where(eq(feedbackExports.id, row.id));
          sent += 1;
        } catch (error) {
          await db
            .update(feedbackExports)
            .set({
              status: "failed",
              attemptCount: row.attemptCount + 1,
              lastAttemptedAt: attemptAt,
              failureReason: truncateFailureReason(error),
              updatedAt: attemptAt,
            })
            .where(eq(feedbackExports.id, row.id));
          failed += 1;
        }
      }

      return {
        attempted,
        sent,
        failed,
      };
    },

    saveIssueVote: async (input: {
      issueId: string;
      targetType: FeedbackTargetType;
      targetId: string;
      vote: FeedbackVoteValue;
      authorUserId: string;
      reason?: string | null;
      allowSharing?: boolean;
    }) =>
      db.transaction(async (tx) => {
        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            projectId: issues.projectId,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
          })
          .from(issues)
          .where(eq(issues.id, input.issueId))
          .then((rows) => rows[0] ?? null);
        if (!issue) throw notFound("Issue not found");

        const target = await resolveFeedbackTarget(tx, issue, input.targetType, input.targetId);

        const existingCompany = await tx
          .select({
            feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
            feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
          })
          .from(companies)
          .where(eq(companies.id, issue.companyId))
          .then((rows) => rows[0] ?? null);
        if (!existingCompany) throw notFound("Company not found");

        const now = new Date();
        const normalizedReason = normalizeReason(input.vote, input.reason);
        const sharedWithLabs = input.allowSharing === true;
        let consentEnabledNow = false;
        let consentVersion = existingCompany.feedbackDataSharingTermsVersion ?? null;
        let persistedSharingPreference: "allowed" | "not_allowed" | null = null;

        if (sharedWithLabs && !existingCompany.feedbackDataSharingEnabled) {
          consentEnabledNow = true;
          consentVersion = DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION;
          await tx
            .update(companies)
            .set({
              feedbackDataSharingEnabled: true,
              feedbackDataSharingConsentAt: now,
              feedbackDataSharingConsentByUserId: input.authorUserId,
              feedbackDataSharingTermsVersion: consentVersion,
              updatedAt: now,
            })
            .where(eq(companies.id, issue.companyId));
        }

        const existingInstanceSettings = await tx
          .select({
            id: instanceSettings.id,
            general: instanceSettings.general,
          })
          .from(instanceSettings)
          .where(eq(instanceSettings.singletonKey, DEFAULT_INSTANCE_SETTINGS_SINGLETON_KEY))
          .then((rows) => rows[0] ?? null);

        const currentInstanceSettings =
          existingInstanceSettings ??
          (await tx
            .insert(instanceSettings)
            .values({
              singletonKey: DEFAULT_INSTANCE_SETTINGS_SINGLETON_KEY,
              general: {},
              experimental: {},
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [instanceSettings.singletonKey],
              set: {
                updatedAt: now,
              },
            })
            .returning({
              id: instanceSettings.id,
              general: instanceSettings.general,
            })
            .then((rows) => rows[0] ?? null));

        const currentGeneral = normalizeInstanceGeneralSettings(currentInstanceSettings?.general);
        if (currentInstanceSettings && currentGeneral.feedbackDataSharingPreference === "prompt") {
          const nextSharingPreference = sharedWithLabs ? "allowed" : "not_allowed";
          const currentGeneralRaw = asRecord(currentInstanceSettings.general) ?? {};
          await tx
            .update(instanceSettings)
            .set({
              general: {
                ...currentGeneralRaw,
                censorUsernameInLogs: currentGeneral.censorUsernameInLogs,
                feedbackDataSharingPreference: nextSharingPreference,
              },
              updatedAt: now,
            })
            .where(eq(instanceSettings.id, currentInstanceSettings.id));
          persistedSharingPreference = nextSharingPreference;
        }

        const [savedVote] = await tx
          .insert(feedbackVotes)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            targetType: input.targetType,
            targetId: input.targetId,
            authorUserId: input.authorUserId,
            vote: input.vote,
            reason: normalizedReason,
            sharedWithLabs,
            sharedAt: sharedWithLabs ? now : null,
            consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
            redactionSummary: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              feedbackVotes.companyId,
              feedbackVotes.targetType,
              feedbackVotes.targetId,
              feedbackVotes.authorUserId,
            ],
            set: {
              vote: input.vote,
              reason: normalizedReason,
              sharedWithLabs,
              sharedAt: sharedWithLabs ? now : null,
              consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
              redactionSummary: null,
              updatedAt: now,
            },
          })
          .returning();

        const artifacts = await buildPayloadArtifacts(tx, {
          issue,
          target,
          voteId: savedVote.id,
          vote: input.vote,
          reason: normalizedReason,
          authorUserId: input.authorUserId,
          consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
          sharedWithLabs,
          now,
        });

        await tx
          .update(feedbackVotes)
          .set({
            redactionSummary: artifacts.redactionSummary,
            updatedAt: now,
          })
          .where(eq(feedbackVotes.id, savedVote.id));

        const [savedTrace] = await tx
          .insert(feedbackExports)
          .values({
            companyId: issue.companyId,
            feedbackVoteId: savedVote.id,
            issueId: issue.id,
            projectId: issue.projectId,
            authorUserId: input.authorUserId,
            targetType: input.targetType,
            targetId: input.targetId,
            vote: input.vote,
            status: sharedWithLabs ? "pending" : "local_only",
            destination: sharedWithLabs ? FEEDBACK_DESTINATION : null,
            exportId: artifacts.exportId,
            consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
            schemaVersion: FEEDBACK_SCHEMA_VERSION,
            bundleVersion: FEEDBACK_BUNDLE_VERSION,
            payloadVersion: FEEDBACK_PAYLOAD_VERSION,
            payloadDigest: artifacts.payloadDigest,
            payloadSnapshot: artifacts.payloadSnapshot,
            targetSummary: artifacts.targetSummary,
            redactionSummary: artifacts.redactionSummary,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [feedbackExports.feedbackVoteId],
            set: {
              issueId: issue.id,
              projectId: issue.projectId,
              authorUserId: input.authorUserId,
              targetType: input.targetType,
              targetId: input.targetId,
              vote: input.vote,
              status: sharedWithLabs ? "pending" : "local_only",
              destination: sharedWithLabs ? FEEDBACK_DESTINATION : null,
              exportId: artifacts.exportId,
              consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
              schemaVersion: FEEDBACK_SCHEMA_VERSION,
              bundleVersion: FEEDBACK_BUNDLE_VERSION,
              payloadVersion: FEEDBACK_PAYLOAD_VERSION,
              payloadDigest: artifacts.payloadDigest,
              payloadSnapshot: artifacts.payloadSnapshot,
              targetSummary: artifacts.targetSummary,
              redactionSummary: artifacts.redactionSummary,
              failureReason: null,
              updatedAt: now,
            },
          })
          .returning({
            id: feedbackExports.id,
          });

        return {
          vote: {
            ...savedVote,
            redactionSummary: artifacts.redactionSummary,
          },
          traceId: savedTrace?.id ?? null,
          consentEnabledNow,
          persistedSharingPreference,
          sharingEnabled: sharedWithLabs,
        };
      }),
  };
}
