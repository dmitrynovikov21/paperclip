import { existsSync, readdirSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";

export type DatabaseBackupSchedulerOptions = {
  backupDir: string;
  intervalMs: number;
  /** Delay before the first run when no fresh backup/marker can prove the last run finished. */
  warmupDelayMs?: number;
  /** Delay before retrying after a run was skipped for lack of free disk space. */
  lowSpaceRetryDelayMs?: number;
  /** Minimum free bytes required on the backup volume before a run starts. */
  minFreeBytesReserve?: number;
  now?: () => Date;
  runBackup: () => Promise<{ sizeBytes?: number } | null | void>;
  onSkippedForLowSpace?: (info: { freeBytes: number; requiredBytes: number }) => void;
  onScheduled?: (delayMs: number) => void;
};

export type DatabaseBackupSchedulerHandle = {
  stop: () => void;
};

function latestBackupMtimeMs(backupDir: string): number | null {
  if (!existsSync(backupDir)) return null;
  let latest: number | null = null;
  for (const name of readdirSync(backupDir)) {
    if (!name.endsWith(".sql.gz")) continue;
    const mtimeMs = statSync(join(backupDir, name)).mtimeMs;
    if (latest === null || mtimeMs > latest) latest = mtimeMs;
  }
  return latest;
}

/**
 * Delay before the next scheduled backup run.
 *
 * A bare `setInterval` re-arms its 24h window on every process start, so a host
 * that restarts more often than the backup interval never reaches a run. This
 * derives the next run from the newest backup file's mtime instead, falling
 * back to a short warmup delay when no provably-complete recent backup exists.
 */
export function computeNextBackupDelayMs(
  opts: Pick<DatabaseBackupSchedulerOptions, "backupDir" | "intervalMs" | "warmupDelayMs"> & {
    now?: () => Date;
  },
): number {
  const warmupDelayMs = opts.warmupDelayMs ?? 10 * 60 * 1000;
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const latestMtimeMs = latestBackupMtimeMs(opts.backupDir);
  if (latestMtimeMs === null) return warmupDelayMs;

  const dueAtMs = latestMtimeMs + opts.intervalMs;
  if (dueAtMs <= nowMs) return warmupDelayMs;
  return Math.min(dueAtMs - nowMs, opts.intervalMs);
}

/** Minimum free bytes to require before starting a backup run, given the last known backup size. */
export function requiredFreeBytes(lastBackupSizeBytes: number | null, reserveBytes: number): number {
  const sizeWithMargin = Math.ceil((lastBackupSizeBytes ?? 0) * 1.25);
  return reserveBytes + sizeWithMargin;
}

function freeBytesOf(dir: string): number {
  const stats = statfsSync(dir);
  return stats.bsize * stats.bfree;
}

function latestBackupSizeBytes(backupDir: string): number | null {
  if (!existsSync(backupDir)) return null;
  let latest: { mtimeMs: number; size: number } | null = null;
  for (const name of readdirSync(backupDir)) {
    if (!name.endsWith(".sql.gz")) continue;
    const stat = statSync(join(backupDir, name));
    if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { mtimeMs: stat.mtimeMs, size: stat.size };
  }
  return latest?.size ?? null;
}

/**
 * Starts a self-rescheduling (setTimeout chain, not setInterval) database backup
 * scheduler. Each run recomputes its own next delay from the newest backup file,
 * so restarts don't silently push the next run out by a full interval, and a run
 * is skipped (with a warning callback) rather than started when free disk space
 * would drop below the configured reserve.
 */
export function startDatabaseBackupScheduler(
  opts: DatabaseBackupSchedulerOptions,
): DatabaseBackupSchedulerHandle {
  const lowSpaceRetryDelayMs = opts.lowSpaceRetryDelayMs ?? 60 * 60 * 1000;
  const minFreeBytesReserve = opts.minFreeBytesReserve ?? 2 * 1024 * 1024 * 1024;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    opts.onScheduled?.(delayMs);
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (stopped) return;
    const requiredBytes = requiredFreeBytes(latestBackupSizeBytes(opts.backupDir), minFreeBytesReserve);
    const freeBytes = freeBytesOf(opts.backupDir);
    if (freeBytes < requiredBytes) {
      opts.onSkippedForLowSpace?.({ freeBytes, requiredBytes });
      scheduleNext(lowSpaceRetryDelayMs);
      return;
    }

    try {
      await opts.runBackup();
    } finally {
      if (!stopped) {
        scheduleNext(
          computeNextBackupDelayMs({
            backupDir: opts.backupDir,
            intervalMs: opts.intervalMs,
            warmupDelayMs: opts.warmupDelayMs,
            now: opts.now,
          }),
        );
      }
    }
  };

  scheduleNext(
    computeNextBackupDelayMs({
      backupDir: opts.backupDir,
      intervalMs: opts.intervalMs,
      warmupDelayMs: opts.warmupDelayMs,
      now: opts.now,
    }),
  );

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
