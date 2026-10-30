import { mkdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { removeStaleBackupPartials } from "@paperclipai/db";

const GIB = 1024 * 1024 * 1024;
// setTimeout clamps larger delays to 1ms; longer waits are re-checked at the tick.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Scheduler state kept next to the backups. Only `lastSuccess` drives the
 * schedule; a `.sql.gz` file without a matching record never counts as done.
 */
export const DATABASE_BACKUP_STATE_FILE = ".paperclip-backup-state.json";
/** Free space the backup volume keeps at all times unless overridden. */
export const DEFAULT_DATABASE_BACKUP_MIN_FREE_BYTES = 12 * GIB;
/** A running backup is aborted once free space drops to `minFreeBytes` plus this headroom. */
export const DEFAULT_DATABASE_BACKUP_GUARD_MARGIN_BYTES = 512 * 1024 * 1024;
const DEFAULT_WARMUP_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_GUARD_INTERVAL_MS = 5 * 1000;
/** Partial files of a run untouched this long were left by a run that died. */
const DEFAULT_PARTIAL_STALE_AFTER_MS = 10 * 60 * 1000;
const SIZE_ESTIMATE_MARGIN = 1.25;

export type DatabaseBackupSuccess = {
  /** File name inside the backup directory. */
  backupFile: string;
  sizeBytes: number;
  finishedAt: string;
};

type DatabaseBackupState = {
  lastSuccess?: DatabaseBackupSuccess;
  /** Expected size of the next backup: last success, or bytes an aborted run already wrote. */
  sizeEstimateBytes?: number;
};

export type DatabaseBackupRunResult = { backupFile: string; sizeBytes: number } | null;

export type DatabaseBackupSchedulerOptions = {
  backupDir: string;
  intervalMs: number;
  /** Delay before a run when no confirmed backup is recent enough. */
  warmupDelayMs?: number;
  /** Delay before the next attempt after a skipped, aborted or failed run. */
  retryDelayMs?: number;
  /** Free bytes the backup volume must never drop below. */
  minFreeBytes?: number;
  guardMarginBytes?: number;
  /** How often free space is re-measured while a backup is running. */
  guardIntervalMs?: number;
  /** File name prefix `runBackup` writes with; partial files of a killed run are matched by it. */
  filenamePrefix?: string;
  /** A run whose partial files were not written to for this long counts as dead. */
  partialStaleAfterMs?: number;
  now?: () => Date;
  /** Bytes available to the service user on the volume holding `dir`. */
  measureFreeBytes?: (dir: string) => number;
  /** Resolves with the finished backup, or null when the run failed or was skipped. */
  runBackup: (signal: AbortSignal) => Promise<DatabaseBackupRunResult>;
  onScheduled?: (delayMs: number) => void;
  onSkippedForLowSpace?: (info: { freeBytes: number; requiredBytes: number; sizeEstimateBytes: number }) => void;
  onAbortedForLowSpace?: (info: { freeBytes: number; floorBytes: number; writtenBytes: number }) => void;
  onPartialsRemoved?: (info: { files: string[]; bytes: number }) => void;
  onError?: (err: unknown) => void;
};

export type DatabaseBackupSchedulerHandle = {
  stop: () => void;
};

function statePath(backupDir: string): string {
  return join(backupDir, DATABASE_BACKUP_STATE_FILE);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readState(backupDir: string): DatabaseBackupState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(backupDir), "utf8")) as Record<string, unknown>;
    const state: DatabaseBackupState = {};
    const last = parsed.lastSuccess as Partial<DatabaseBackupSuccess> | undefined;
    if (
      last &&
      typeof last.backupFile === "string" &&
      isNonNegativeNumber(last.sizeBytes) &&
      typeof last.finishedAt === "string" &&
      Number.isFinite(Date.parse(last.finishedAt))
    ) {
      state.lastSuccess = { backupFile: last.backupFile, sizeBytes: last.sizeBytes, finishedAt: last.finishedAt };
    }
    if (isNonNegativeNumber(parsed.sizeEstimateBytes)) state.sizeEstimateBytes = parsed.sizeEstimateBytes;
    return state;
  } catch {
    return {};
  }
}

function writeState(backupDir: string, state: DatabaseBackupState): void {
  const target = statePath(backupDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, target);
}

/**
 * Last backup confirmed complete, or null. The record is trusted only while the
 * file it names is still in the backup directory with the recorded size, so a
 * truncated, replaced or pruned file never counts as a fresh backup.
 */
export function readDatabaseBackupSuccess(backupDir: string): DatabaseBackupSuccess | null {
  const last = readState(backupDir).lastSuccess;
  if (!last) return null;
  const name = basename(last.backupFile);
  try {
    if (statSync(join(backupDir, name)).size !== last.sizeBytes) return null;
  } catch {
    return null;
  }
  return { ...last, backupFile: name };
}

/** Records a finished backup; call only after the backup file is complete. */
export function recordDatabaseBackupSuccess(
  backupDir: string,
  result: { backupFile: string; sizeBytes: number },
  finishedAt: Date = new Date(),
): void {
  writeState(backupDir, {
    lastSuccess: {
      backupFile: basename(result.backupFile),
      sizeBytes: result.sizeBytes,
      finishedAt: finishedAt.toISOString(),
    },
    sizeEstimateBytes: result.sizeBytes,
  });
}

function recordSizeLowerBound(backupDir: string, bytes: number): void {
  const state = readState(backupDir);
  writeState(backupDir, { ...state, sizeEstimateBytes: Math.max(state.sizeEstimateBytes ?? 0, bytes) });
}

/** Expected size of the next backup in bytes, 0 when nothing is known yet. */
export function estimateDatabaseBackupSizeBytes(backupDir: string): number {
  const state = readState(backupDir);
  return Math.max(state.lastSuccess?.sizeBytes ?? 0, state.sizeEstimateBytes ?? 0);
}

function msUntilNextBackup(backupDir: string, intervalMs: number, nowMs: number): number | null {
  const last = readDatabaseBackupSuccess(backupDir);
  if (!last) return null;
  const dueAtMs = Date.parse(last.finishedAt) + intervalMs;
  if (dueAtMs <= nowMs) return null;
  return Math.min(dueAtMs - nowMs, intervalMs);
}

/**
 * Delay before the next scheduled backup run.
 *
 * A bare `setInterval` re-arms its 24h window on every process start, so a host
 * that restarts more often than the backup interval never reaches a run. This
 * derives the next run from the last confirmed backup instead, falling back to
 * a short warmup delay when no confirmed backup is recent enough.
 */
export function computeNextBackupDelayMs(opts: {
  backupDir: string;
  intervalMs: number;
  warmupDelayMs?: number;
  now?: () => Date;
}): number {
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  return msUntilNextBackup(opts.backupDir, opts.intervalMs, nowMs) ?? opts.warmupDelayMs ?? DEFAULT_WARMUP_DELAY_MS;
}

/** Free bytes required before a run starts: the abort floor plus the expected backup size with margin. */
export function requiredFreeBytes(sizeEstimateBytes: number, floorBytes: number): number {
  return floorBytes + Math.ceil(sizeEstimateBytes * SIZE_ESTIMATE_MARGIN);
}

/** Reserve from `PAPERCLIP_DB_BACKUP_MIN_FREE_GIB`; unset or invalid values keep the default. */
export function resolveDatabaseBackupMinFreeBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DATABASE_BACKUP_MIN_FREE_BYTES;
  const gib = Number(raw);
  if (!Number.isFinite(gib) || gib < 0) return DEFAULT_DATABASE_BACKUP_MIN_FREE_BYTES;
  return Math.round(gib * GIB);
}

/** Bytes the service user can still write: `bavail`, not `bfree`, which includes root-reserved blocks. */
export function availableBytesFromStatfs(stats: { bavail: number; bsize: number }): number {
  return stats.bavail * stats.bsize;
}

function availableBytes(dir: string): number {
  return availableBytesFromStatfs(statfsSync(dir));
}

/**
 * Starts a self-rescheduling (setTimeout chain, not setInterval) database backup
 * scheduler. Each run recomputes its own next delay from the last confirmed
 * backup, so restarts don't push the next run out by a full interval. Free space
 * is checked before a run and re-checked while it writes: the run is skipped or
 * aborted instead of eating into the reserve, and every outcome reschedules.
 * Partial files of a run that died with its process are cleared at start and
 * before every run.
 */
export function startDatabaseBackupScheduler(
  opts: DatabaseBackupSchedulerOptions,
): DatabaseBackupSchedulerHandle {
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const floorBytes =
    (opts.minFreeBytes ?? DEFAULT_DATABASE_BACKUP_MIN_FREE_BYTES) +
    (opts.guardMarginBytes ?? DEFAULT_DATABASE_BACKUP_GUARD_MARGIN_BYTES);
  const guardIntervalMs = opts.guardIntervalMs ?? DEFAULT_GUARD_INTERVAL_MS;
  const partialStaleAfterMs = opts.partialStaleAfterMs ?? DEFAULT_PARTIAL_STALE_AFTER_MS;
  const now = opts.now ?? (() => new Date());
  const measureFreeBytes = opts.measureFreeBytes ?? availableBytes;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: AbortController | null = null;
  let stopped = false;

  /**
   * Removes the partial files a killed run left behind, which nothing else
   * would ever delete, and keeps their size in the estimate: the killed run
   * wrote at least that much, so the next run isn't sized from zero.
   */
  const sweepPartials = () => {
    const { removed, kept } = removeStaleBackupPartials({
      backupDir: opts.backupDir,
      filenamePrefix: opts.filenamePrefix,
      staleAfterMs: partialStaleAfterMs,
      nowMs: now().getTime(),
    });
    const compressedBytes = [...removed, ...kept].filter((file) => file.compressed).map((file) => file.sizeBytes);
    const writtenBytes = Math.max(0, ...compressedBytes);
    if (writtenBytes > 0) recordSizeLowerBound(opts.backupDir, writtenBytes);
    if (removed.length > 0) {
      opts.onPartialsRemoved?.({
        files: removed.map((file) => file.name),
        bytes: removed.reduce((sum, file) => sum + file.sizeBytes, 0),
      });
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    opts.onScheduled?.(delayMs);
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS));
  };

  const runGuarded = async (): Promise<{
    result: DatabaseBackupRunResult;
    abortedAtFreeBytes: number | null;
  }> => {
    const controller = new AbortController();
    running = controller;
    let abortedAtFreeBytes: number | null = null;
    const guard = setInterval(() => {
      if (controller.signal.aborted) return;
      try {
        const freeBytes = measureFreeBytes(opts.backupDir);
        if (freeBytes < floorBytes) {
          abortedAtFreeBytes = freeBytes;
          controller.abort(new Error(`Free space ${freeBytes} B fell below the ${floorBytes} B floor`));
        }
      } catch (err) {
        // Without a measurement the reserve can't be enforced.
        controller.abort(err);
      }
    }, guardIntervalMs);
    try {
      const result = await opts.runBackup(controller.signal);
      return { result, abortedAtFreeBytes };
    } finally {
      clearInterval(guard);
      running = null;
    }
  };

  const tick = async () => {
    if (stopped) return;
    let nextDelayMs = retryDelayMs;
    try {
      // Before the estimate and the free-space check, so both see the cleared space.
      sweepPartials();
      const remainingMs = msUntilNextBackup(opts.backupDir, opts.intervalMs, now().getTime());
      if (remainingMs !== null) {
        // A backup finished since this tick was scheduled (e.g. a manual run).
        nextDelayMs = remainingMs;
        return;
      }

      // Owner-only like the dumps that go in it; an existing directory keeps its mode.
      mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
      const sizeEstimateBytes = estimateDatabaseBackupSizeBytes(opts.backupDir);
      const requiredBytes = requiredFreeBytes(sizeEstimateBytes, floorBytes);
      const freeAtStartBytes = measureFreeBytes(opts.backupDir);
      if (freeAtStartBytes < requiredBytes) {
        opts.onSkippedForLowSpace?.({ freeBytes: freeAtStartBytes, requiredBytes, sizeEstimateBytes });
        return;
      }

      const { result, abortedAtFreeBytes } = await runGuarded();
      if (result) {
        recordDatabaseBackupSuccess(opts.backupDir, result, now());
        nextDelayMs = computeNextBackupDelayMs({
          backupDir: opts.backupDir,
          intervalMs: opts.intervalMs,
          warmupDelayMs: retryDelayMs,
          now,
        });
      } else if (abortedAtFreeBytes !== null) {
        // The aborted run wrote at least this much; don't retry until it fits.
        const writtenBytes = Math.max(0, freeAtStartBytes - abortedAtFreeBytes);
        opts.onAbortedForLowSpace?.({ freeBytes: abortedAtFreeBytes, floorBytes, writtenBytes });
        recordSizeLowerBound(opts.backupDir, writtenBytes);
      }
    } catch (err) {
      opts.onError?.(err);
    } finally {
      scheduleNext(nextDelayMs);
    }
  };

  try {
    // A run killed with the previous process left its partial files behind.
    sweepPartials();
  } catch (err) {
    opts.onError?.(err);
  }
  scheduleNext(
    computeNextBackupDelayMs({
      backupDir: opts.backupDir,
      intervalMs: opts.intervalMs,
      warmupDelayMs: opts.warmupDelayMs,
      now,
    }),
  );

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      running?.abort(new Error("Database backup scheduler stopped"));
    },
  };
}
