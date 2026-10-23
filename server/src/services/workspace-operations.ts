import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { workspaceOperations } from "@paperclipai/db";
import type { WorkspaceOperation, WorkspaceOperationPhase, WorkspaceOperationStatus } from "@paperclipai/shared";
import { asc, desc, eq, inArray, isNull, or, and } from "drizzle-orm";
import { notFound } from "../errors.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { getWorkspaceOperationLogStore } from "./workspace-operation-log-store.js";
import {
  createWorkspaceOperationUrlStreamRedactor,
  redactTruncatedWorkspaceOperationOutput,
  redactWorkspaceOperationExcerpt,
  redactWorkspaceOperationUrls,
} from "./workspace-operation-url-redaction.js";

type WorkspaceOperationRow = typeof workspaceOperations.$inferSelect;

function toWorkspaceOperation(row: WorkspaceOperationRow): WorkspaceOperation {
  return redactWorkspaceOperationUrls({
    id: row.id,
    companyId: row.companyId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    issueId: row.issueId ?? null,
    phase: row.phase as WorkspaceOperationPhase,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    status: row.status as WorkspaceOperationStatus,
    exitCode: row.exitCode ?? null,
    logStore: row.logStore ?? null,
    logRef: row.logRef ?? null,
    logBytes: row.logBytes ?? null,
    logSha256: row.logSha256 ?? null,
    logCompressed: row.logCompressed,
    stdoutExcerpt: redactWorkspaceOperationExcerpt(row.stdoutExcerpt ?? null),
    stderrExcerpt: redactWorkspaceOperationExcerpt(row.stderrExcerpt ?? null),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function appendExcerpt(current: string, chunk: string) {
  return `${current}${chunk}`.slice(-4096);
}

function combineMetadata(
  base: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
) {
  if (!base && !patch) return null;
  return {
    ...(base ?? {}),
    ...(patch ?? {}),
  };
}

export interface WorkspaceOperationRecorder {
  attachExecutionWorkspaceId(executionWorkspaceId: string | null): Promise<void>;
  recordOperation(input: {
    phase: WorkspaceOperationPhase;
    command?: string | null;
    cwd?: string | null;
    metadata?: Record<string, unknown> | null;
    run: (reportProgress: (input: {
      stdout?: string | null;
      stderr?: string | null;
      system?: string | null;
    }) => Promise<void>) => Promise<{
      status?: WorkspaceOperationStatus;
      exitCode?: number | null;
      stdout?: string | null;
      stderr?: string | null;
      system?: string | null;
      metadata?: Record<string, unknown> | null;
    }>;
  }): Promise<WorkspaceOperation>;
}

export function workspaceOperationService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const logStore = getWorkspaceOperationLogStore();

  async function getById(id: string) {
    const row = await db
      .select()
      .from(workspaceOperations)
      .where(eq(workspaceOperations.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? toWorkspaceOperation(row) : null;
  }

  return {
    getById,

    createRecorder(input: {
      companyId: string;
      heartbeatRunId?: string | null;
      executionWorkspaceId?: string | null;
      issueId?: string | null;
    }): WorkspaceOperationRecorder {
      let executionWorkspaceId = input.executionWorkspaceId ?? null;
      const createdIds: string[] = [];

      return {
        async attachExecutionWorkspaceId(nextExecutionWorkspaceId) {
          executionWorkspaceId = nextExecutionWorkspaceId ?? null;
          if (!executionWorkspaceId || createdIds.length === 0) return;
          await db
            .update(workspaceOperations)
            .set({
              executionWorkspaceId,
              updatedAt: new Date(),
            })
            .where(inArray(workspaceOperations.id, createdIds));
        },

        async recordOperation(recordInput) {
          const currentUserRedactionOptions = {
            enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
          };
          const startedAt = new Date();
          const id = randomUUID();
          const handle = await logStore.begin({
            companyId: input.companyId,
            operationId: id,
          });

          let stdoutExcerpt = "";
          let stderrExcerpt = "";
          const streamRedactors = {
            stdout: createWorkspaceOperationUrlStreamRedactor(),
            stderr: createWorkspaceOperationUrlStreamRedactor(),
            system: createWorkspaceOperationUrlStreamRedactor(),
          };
          const pendingEvents: Record<"stdout" | "stderr" | "system", { chunk: string; ts: string } | null> = {
            stdout: null,
            stderr: null,
            system: null,
          };
          const writePendingEvent = async (stream: "stdout" | "stderr" | "system") => {
            const event = pendingEvents[stream];
            pendingEvents[stream] = null;
            if (!event?.chunk) return;
            if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, event.chunk);
            if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, event.chunk);
            await logStore.append(handle, { stream, ...event });
          };
          const append = async (stream: "stdout" | "stderr" | "system", chunk: string | null | undefined) => {
            if (!chunk) return;
            const sanitizedChunk = streamRedactors[stream].push(redactTruncatedWorkspaceOperationOutput(
              redactCurrentUserText(chunk, currentUserRedactionOptions),
            ));
            const event = pendingEvents[stream] ?? { chunk: "", ts: new Date().toISOString() };
            event.chunk += sanitizedChunk;
            pendingEvents[stream] = event;
            if (!streamRedactors[stream].hasPending() || event.chunk.length >= 256 * 1024) {
              await writePendingEvent(stream);
            }
          };
          const flushPendingOutput = async () => {
            for (const stream of ["stdout", "stderr", "system"] as const) {
              const event = pendingEvents[stream] ?? { chunk: "", ts: new Date().toISOString() };
              event.chunk += streamRedactors[stream].flush();
              pendingEvents[stream] = event;
              await writePendingEvent(stream);
            }
          };

          await db.insert(workspaceOperations).values({
            id,
            companyId: input.companyId,
            executionWorkspaceId,
            heartbeatRunId: input.heartbeatRunId ?? null,
            issueId: input.issueId ?? null,
            phase: recordInput.phase,
            command: redactWorkspaceOperationUrls(recordInput.command ?? null),
            cwd: redactWorkspaceOperationUrls(recordInput.cwd ?? null),
            status: "running",
            logStore: handle.store,
            logRef: handle.logRef,
            metadata: redactWorkspaceOperationUrls(redactCurrentUserValue(
              recordInput.metadata ?? null,
              currentUserRedactionOptions,
            )) as Record<string, unknown> | null,
            startedAt,
          });
          createdIds.push(id);

          try {
            const result = await recordInput.run(async (progress) => {
              await append("system", progress.system ?? null);
              await append("stdout", progress.stdout ?? null);
              await append("stderr", progress.stderr ?? null);
            });
            await append("system", result.system ?? null);
            await append("stdout", result.stdout ?? null);
            await append("stderr", result.stderr ?? null);
            await flushPendingOutput();
            const finalized = await logStore.finalize(handle);
            const finishedAt = new Date();
            const row = await db
              .update(workspaceOperations)
              .set({
                executionWorkspaceId,
                status: result.status ?? "succeeded",
                exitCode: result.exitCode ?? null,
                stdoutExcerpt: stdoutExcerpt || null,
                stderrExcerpt: stderrExcerpt || null,
                logBytes: finalized.bytes,
                logSha256: finalized.sha256,
                logCompressed: finalized.compressed,
                metadata: redactWorkspaceOperationUrls(redactCurrentUserValue(
                  combineMetadata(recordInput.metadata, result.metadata),
                  currentUserRedactionOptions,
                )) as Record<string, unknown> | null,
                finishedAt,
                updatedAt: finishedAt,
              })
              .where(eq(workspaceOperations.id, id))
              .returning()
              .then((rows) => rows[0] ?? null);
            if (!row) throw notFound("Workspace operation not found");
            return toWorkspaceOperation(row);
          } catch (error) {
            await append("stderr", error instanceof Error ? error.message : String(error));
            await flushPendingOutput();
            const finalized = await logStore.finalize(handle).catch(() => null);
            const finishedAt = new Date();
            await db
              .update(workspaceOperations)
              .set({
                executionWorkspaceId,
                status: "failed",
                stdoutExcerpt: stdoutExcerpt || null,
                stderrExcerpt: stderrExcerpt || null,
                logBytes: finalized?.bytes ?? null,
                logSha256: finalized?.sha256 ?? null,
                logCompressed: finalized?.compressed ?? false,
                finishedAt,
                updatedAt: finishedAt,
              })
              .where(eq(workspaceOperations.id, id));
            throw error;
          }
        },
      };
    },

    listForRun: async (runId: string, executionWorkspaceId?: string | null) => {
      const conditions = [eq(workspaceOperations.heartbeatRunId, runId)];
      if (executionWorkspaceId) {
        const cleanupCondition = and(
          eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId)!,
          isNull(workspaceOperations.heartbeatRunId),
        )!;
        if (cleanupCondition) conditions.push(cleanupCondition);
      }

      const rows = await db
        .select()
        .from(workspaceOperations)
        .where(conditions.length === 1 ? conditions[0]! : or(...conditions)!)
        .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.createdAt), asc(workspaceOperations.id));

      return rows.map(toWorkspaceOperation);
    },

    listForExecutionWorkspace: async (executionWorkspaceId: string) => {
      const rows = await db
        .select()
        .from(workspaceOperations)
        .where(eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId))
        .orderBy(desc(workspaceOperations.startedAt), desc(workspaceOperations.createdAt));
      return rows.map(toWorkspaceOperation);
    },

    readLog: async (operationId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const operation = await getById(operationId);
      if (!operation) throw notFound("Workspace operation not found");
      if (!operation.logStore || !operation.logRef) throw notFound("Workspace operation log not found");

      const result = await logStore.read(
        {
          store: operation.logStore as "local_file",
          logRef: operation.logRef,
        },
        opts,
      );

      return {
        operationId,
        store: operation.logStore,
        logRef: operation.logRef,
        ...result,
        // The store also masks historical byte-range pages without changing offsets.
        content: result.content,
      };
    },
  };
}

export { toWorkspaceOperation };
