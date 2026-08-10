import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyTransferRuns } from "@paperclipai/db";

// Durable run ledger for chunked company transfers. A run tracks one export
// publish or import apply of a transfer container. Progress is recorded per
// container part (chunk or blob name) as each part finishes processing and
// verification, so an interrupted run — process restart, dropped connection,
// failed part — resumes from the parts it already completed. The transfer
// manifest's content-derived idempotency key ties retries of the same content
// to the same run instead of starting over.

export type CompanyTransferDirection = "export" | "import";
export type CompanyTransferRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Minimal structural view of a transfer manifest's part index: the ledger only
 * ever needs part names and counts, so it stays decoupled from any particular
 * container format. Manifests without this shape (e.g. the chunked zip-upload
 * manifest, which carries its own part list) pass explicit counts to
 * `recordManifest` and track parts by their own names.
 */
export interface CompanyTransferPartsIndex {
  chunks: Array<{ name: string }>;
  blobs: Array<{ name: string }>;
}

function asPartsIndex(manifest: unknown): CompanyTransferPartsIndex | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const { chunks, blobs } = manifest as { chunks?: unknown; blobs?: unknown };
  const named = (value: unknown): value is Array<{ name: string }> =>
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string",
    );
  if (!named(chunks) || !named(blobs)) return null;
  return { chunks, blobs };
}

const RESUMABLE_STATUSES: CompanyTransferRunStatus[] = ["pending", "running", "failed"];

export interface CompanyTransferRunRow {
  id: string;
  companyId: string | null;
  direction: CompanyTransferDirection;
  status: CompanyTransferRunStatus;
  actorKey: string;
  containerRef: unknown;
  idempotencyKey: string;
  manifestSha256: string | null;
  manifest: unknown;
  chunkCount: number;
  blobCount: number;
  completedParts: string[];
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResumeOrCreateTransferRunInput {
  direction: CompanyTransferDirection;
  actorKey: string;
  idempotencyKey: string;
  /** Credential-free container location descriptor. Never put secrets here. */
  containerRef: unknown;
  companyId?: string | null;
}

export interface ResumeOrCreateTransferRunResult {
  run: CompanyTransferRunRow;
  /** True when an existing run for the same content was picked up. */
  resumed: boolean;
  /** True when that existing run already finished — the caller can short-circuit. */
  alreadyCompleted: boolean;
}

function rowFromRecord(record: typeof companyTransferRuns.$inferSelect): CompanyTransferRunRow {
  return {
    ...record,
    direction: record.direction as CompanyTransferDirection,
    status: record.status as CompanyTransferRunStatus,
    manifest: record.manifest ?? null,
    completedParts: Array.isArray(record.completedParts) ? (record.completedParts as string[]) : [],
  };
}

async function getRun(db: Db, runId: string): Promise<CompanyTransferRunRow | null> {
  const [record] = await db
    .select()
    .from(companyTransferRuns)
    .where(eq(companyTransferRuns.id, runId))
    .limit(1);
  return record ? rowFromRecord(record) : null;
}

export const companyTransferRunService = {
  getRun,

  async getRunForActor(db: Db, runId: string, actorKey: string): Promise<CompanyTransferRunRow | null> {
    const run = await getRun(db, runId);
    return run && run.actorKey === actorKey ? run : null;
  },

  /**
   * Find the actor's run for this exact content (same idempotency key and
   * direction) or create a fresh one. A completed prior run is returned with
   * `alreadyCompleted` so the caller can skip the apply outright; a pending,
   * running, or failed prior run is resumed with its part progress intact.
   */
  async resumeOrCreate(db: Db, input: ResumeOrCreateTransferRunInput): Promise<ResumeOrCreateTransferRunResult> {
    const matches = await db
      .select()
      .from(companyTransferRuns)
      .where(
        and(
          eq(companyTransferRuns.idempotencyKey, input.idempotencyKey),
          eq(companyTransferRuns.direction, input.direction),
          eq(companyTransferRuns.actorKey, input.actorKey),
          inArray(companyTransferRuns.status, [...RESUMABLE_STATUSES, "completed"]),
        ),
      )
      .orderBy(desc(companyTransferRuns.createdAt))
      .limit(1);
    const existing = matches[0] ? rowFromRecord(matches[0]) : null;
    if (existing) {
      return { run: existing, resumed: true, alreadyCompleted: existing.status === "completed" };
    }
    const [created] = await db
      .insert(companyTransferRuns)
      .values({
        direction: input.direction,
        actorKey: input.actorKey,
        idempotencyKey: input.idempotencyKey,
        containerRef: input.containerRef,
        companyId: input.companyId ?? null,
      })
      .returning();
    return { run: rowFromRecord(created!), resumed: false, alreadyCompleted: false };
  },

  /**
   * Persist the parsed manifest so resume can re-verify parts without
   * refetching it. Counts default to the manifest's chunk/blob index when it
   * has one; manifests with a different part layout pass them explicitly.
   */
  async recordManifest(
    db: Db,
    runId: string,
    manifest: unknown,
    manifestSha256: string,
    counts?: { chunkCount: number; blobCount: number },
  ): Promise<void> {
    const index = asPartsIndex(manifest);
    const chunkCount = counts?.chunkCount ?? index?.chunks.length ?? 0;
    const blobCount = counts?.blobCount ?? index?.blobs.length ?? 0;
    await db
      .update(companyTransferRuns)
      .set({
        manifest,
        manifestSha256,
        chunkCount,
        blobCount,
        updatedAt: new Date(),
      })
      .where(eq(companyTransferRuns.id, runId));
  },

  async start(db: Db, runId: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ status: "running", error: null, startedAt: new Date(), finishedAt: null, updatedAt: new Date() })
      .where(
        and(eq(companyTransferRuns.id, runId), inArray(companyTransferRuns.status, RESUMABLE_STATUSES)),
      );
  },

  async attachCompany(db: Db, runId: string, companyId: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ companyId, updatedAt: new Date() })
      .where(eq(companyTransferRuns.id, runId));
  },

  /**
   * Record one finished container part. Appends atomically in SQL and is
   * idempotent: re-completing an already recorded part leaves the ledger
   * unchanged, so a retried part never double-counts.
   */
  async completePart(db: Db, runId: string, partName: string): Promise<void> {
    const partJson = JSON.stringify([partName]);
    await db
      .update(companyTransferRuns)
      .set({
        completedParts: sql`case when ${companyTransferRuns.completedParts} @> ${partJson}::jsonb then ${companyTransferRuns.completedParts} else ${companyTransferRuns.completedParts} || ${partJson}::jsonb end`,
        updatedAt: new Date(),
      })
      .where(eq(companyTransferRuns.id, runId));
  },

  /** Container part names the run still has to process, in manifest order. */
  remainingParts(run: CompanyTransferRunRow, manifest: CompanyTransferPartsIndex): string[] {
    const completed = new Set(run.completedParts);
    const remaining: string[] = [];
    for (const chunk of manifest.chunks) {
      if (!completed.has(chunk.name)) remaining.push(chunk.name);
    }
    for (const blob of manifest.blobs) {
      if (!completed.has(blob.name)) remaining.push(blob.name);
    }
    return remaining;
  },

  async complete(db: Db, runId: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ status: "completed", error: null, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(companyTransferRuns.id, runId));
  },

  async fail(db: Db, runId: string, error: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ status: "failed", error, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(companyTransferRuns.id, runId));
  },

  async cancel(db: Db, runId: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(companyTransferRuns.id, runId), inArray(companyTransferRuns.status, RESUMABLE_STATUSES)));
  },
};
