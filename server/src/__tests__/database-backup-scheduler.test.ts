import { existsSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DATABASE_BACKUP_GUARD_MARGIN_BYTES,
  DEFAULT_DATABASE_BACKUP_MIN_FREE_BYTES,
  availableBytesFromStatfs,
  computeNextBackupDelayMs,
  estimateDatabaseBackupSizeBytes,
  readDatabaseBackupSuccess,
  recordDatabaseBackupSuccess,
  requiredFreeBytes,
  resolveDatabaseBackupMinFreeBytes,
  startDatabaseBackupScheduler,
  type DatabaseBackupSchedulerHandle,
  type DatabaseBackupSchedulerOptions,
} from "../services/database-backup-scheduler.js";

const GIB = 1024 * 1024 * 1024;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FLOOR = DEFAULT_DATABASE_BACKUP_MIN_FREE_BYTES + DEFAULT_DATABASE_BACKUP_GUARD_MARGIN_BYTES;

let dir: string;
const handles: DatabaseBackupSchedulerHandle[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "db-backup-scheduler-"));
});

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function writeBackupFile(name: string, content = "x"): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** A partial file last written `ageMs` ago, as a run killed at that moment leaves it. */
function partialFile(name: string, ageMs: number, content = ""): string {
  const path = writeBackupFile(name, content);
  const mtimeSeconds = (Date.now() - ageMs) / 1000;
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

/** A backup that finished `ageMs` ago, recorded the way the server records it. */
function confirmedBackup(name: string, ageMs: number, content = "x"): string {
  const path = writeBackupFile(name, content);
  recordDatabaseBackupSuccess(dir, { backupFile: path, sizeBytes: Buffer.byteLength(content) }, new Date(Date.now() - ageMs));
  return path;
}

function startScheduler(
  overrides: Partial<DatabaseBackupSchedulerOptions> & Pick<DatabaseBackupSchedulerOptions, "runBackup">,
) {
  const events = {
    scheduled: [] as number[],
    errors: [] as unknown[],
    skipped: [] as Array<{ freeBytes: number; requiredBytes: number; sizeEstimateBytes: number }>,
    aborted: [] as Array<{ freeBytes: number; floorBytes: number; writtenBytes: number }>,
    partialsRemoved: [] as Array<{ files: string[]; bytes: number }>,
  };
  const handle = startDatabaseBackupScheduler({
    backupDir: dir,
    intervalMs: DAY,
    warmupDelayMs: 1000,
    retryDelayMs: HOUR,
    guardIntervalMs: 100,
    onScheduled: (delayMs) => events.scheduled.push(delayMs),
    onError: (err) => events.errors.push(err),
    onSkippedForLowSpace: (info) => events.skipped.push(info),
    onAbortedForLowSpace: (info) => events.aborted.push(info),
    onPartialsRemoved: (info) => events.partialsRemoved.push(info),
    ...overrides,
  });
  handles.push(handle);
  return { handle, events };
}

describe("computeNextBackupDelayMs", () => {
  it("returns the warmup delay when no backup has been confirmed yet", () => {
    expect(computeNextBackupDelayMs({ backupDir: dir, intervalMs: DAY, warmupDelayMs: 5000 })).toBe(5000);
  });

  it("schedules the remaining time until the confirmed backup turns intervalMs old", () => {
    confirmedBackup("paperclip-20260101.sql.gz", HOUR);
    const delay = computeNextBackupDelayMs({ backupDir: dir, intervalMs: DAY, warmupDelayMs: 5000 });
    expect(delay).toBeGreaterThan(22 * HOUR);
    expect(delay).toBeLessThanOrEqual(23 * HOUR);
  });

  it("falls back to the warmup delay when the confirmed backup is older than the interval", () => {
    confirmedBackup("paperclip-old.sql.gz", 2 * DAY);
    expect(computeNextBackupDelayMs({ backupDir: dir, intervalMs: DAY, warmupDelayMs: 7000 })).toBe(7000);
  });

  it("does not rearm a full interval on every process restart (regression for bare setInterval bug)", () => {
    // A backup completed 23h ago; the process just restarted (e.g. a redeploy).
    confirmedBackup("paperclip-recent.sql.gz", 23 * HOUR);
    const delay = computeNextBackupDelayMs({ backupDir: dir, intervalMs: DAY, warmupDelayMs: 5000 });
    // Must be close to the 1h remaining, never a fresh 24h window.
    expect(delay).toBeLessThanOrEqual(HOUR + 1000);
  });

  it("ignores a fresh .sql.gz that was never confirmed (killed or truncated run)", () => {
    writeBackupFile("paperclip-partial.sql.gz");
    expect(computeNextBackupDelayMs({ backupDir: dir, intervalMs: DAY, warmupDelayMs: 5000 })).toBe(5000);

    confirmedBackup("paperclip-older.sql.gz", 30 * HOUR);
    writeBackupFile("paperclip-newer-partial.sql.gz");
    expect(computeNextBackupDelayMs({ backupDir: dir, intervalMs: DAY, warmupDelayMs: 5000 })).toBe(5000);
  });

  it("stops trusting the record once its file is truncated or pruned", () => {
    const path = confirmedBackup("paperclip-recent.sql.gz", HOUR, "complete dump");
    expect(readDatabaseBackupSuccess(dir)?.backupFile).toBe("paperclip-recent.sql.gz");

    writeFileSync(path, "trunc");
    expect(readDatabaseBackupSuccess(dir)).toBeNull();
    expect(computeNextBackupDelayMs({ backupDir: dir, intervalMs: DAY, warmupDelayMs: 5000 })).toBe(5000);

    unlinkSync(path);
    expect(computeNextBackupDelayMs({ backupDir: dir, intervalMs: DAY, warmupDelayMs: 5000 })).toBe(5000);
  });
});

describe("requiredFreeBytes", () => {
  it("adds a margin over the expected backup size on top of the floor", () => {
    expect(requiredFreeBytes(4 * GIB, FLOOR)).toBeGreaterThan(FLOOR + 4 * GIB);
  });

  it("requires just the floor when nothing is known about the backup size", () => {
    expect(requiredFreeBytes(0, FLOOR)).toBe(FLOOR);
  });

  it("does not start on the host snapshot where the dump would leave less than 12 GiB", () => {
    // 30.10 14:29Z: 19 037 093 888 B available, last full dump 6 557 518 802 B.
    expect(19_037_093_888).toBeLessThan(requiredFreeBytes(6_557_518_802, FLOOR));
  });
});

describe("availableBytesFromStatfs", () => {
  it("counts only blocks available to the service user, not root-reserved ones", () => {
    // 30.10 14:29Z on /: bfree 23 961 014 272 B, bavail 19 037 093 888 B.
    const stats = { bsize: 4096, bfree: 23_961_014_272 / 4096, bavail: 19_037_093_888 / 4096 };
    expect(availableBytesFromStatfs(stats)).toBe(19_037_093_888);
  });
});

describe("resolveDatabaseBackupMinFreeBytes", () => {
  it("keeps the 12 GiB default for unset or invalid values", () => {
    for (const raw of [undefined, "", "  ", "abc", "-1"]) {
      expect(resolveDatabaseBackupMinFreeBytes(raw)).toBe(12 * GIB);
    }
  });

  it("reads the reserve in GiB", () => {
    expect(resolveDatabaseBackupMinFreeBytes("20")).toBe(20 * GIB);
    expect(resolveDatabaseBackupMinFreeBytes("1.5")).toBe(1.5 * GIB);
    expect(resolveDatabaseBackupMinFreeBytes("0")).toBe(0);
  });
});

describe("startDatabaseBackupScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("skips the run near the threshold when no backup size is known and retries later", async () => {
    const runBackup = vi.fn(async () => null);
    const { events } = startScheduler({ runBackup, measureFreeBytes: () => FLOOR - 1 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(runBackup).not.toHaveBeenCalled();
    expect(events.skipped).toEqual([{ freeBytes: FLOOR - 1, requiredBytes: FLOOR, sizeEstimateBytes: 0 }]);
    expect(events.scheduled).toEqual([1000, HOUR]);
    expect(events.errors).toEqual([]);
  });

  it("aborts a running backup once free space falls below the floor and waits until it fits", async () => {
    let freeBytes = 20 * GIB;
    const signals: AbortSignal[] = [];
    const runBackup = vi.fn(
      (signal: AbortSignal) =>
        new Promise<null>((resolve) => {
          signals.push(signal);
          signal.addEventListener("abort", () => resolve(null), { once: true });
        }),
    );
    const { events } = startScheduler({ runBackup, measureFreeBytes: () => freeBytes });

    await vi.advanceTimersByTimeAsync(1000);
    expect(runBackup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(signals[0]?.aborted).toBe(false);

    // The dump has eaten into the headroom above the 12 GiB reserve.
    freeBytes = FLOOR - 1;
    await vi.advanceTimersByTimeAsync(100);

    expect(signals[0]?.aborted).toBe(true);
    const writtenBytes = 20 * GIB - (FLOOR - 1);
    expect(events.aborted).toEqual([{ freeBytes: FLOOR - 1, floorBytes: FLOOR, writtenBytes }]);
    expect(estimateDatabaseBackupSizeBytes(dir)).toBe(writtenBytes);
    expect(events.scheduled.at(-1)).toBe(HOUR);

    // Above the floor again, but not enough for a dump of at least that size.
    freeBytes = 15 * GIB;
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(events.skipped).toEqual([
      { freeBytes: 15 * GIB, requiredBytes: requiredFreeBytes(writtenBytes, FLOOR), sizeEstimateBytes: writtenBytes },
    ]);
    expect(events.errors).toEqual([]);
  });

  it("creates a missing backup directory before measuring free space", async () => {
    const backupDir = join(dir, "nested", "backups");
    const runBackup = vi.fn(async () => {
      const backupFile = join(backupDir, "paperclip-1.sql.gz");
      writeFileSync(backupFile, "dump");
      return { backupFile, sizeBytes: 4 };
    });
    // Real statfs on the test volume; no reserve so the run always fits.
    const { events } = startScheduler({ backupDir, runBackup, minFreeBytes: 0, guardMarginBytes: 0 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(events.errors).toEqual([]);
    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(existsSync(backupDir)).toBe(true);
    expect(readDatabaseBackupSuccess(backupDir)?.backupFile).toBe("paperclip-1.sql.gz");
  });

  it("keeps rescheduling when the backup directory can't be created", async () => {
    const notADirectory = writeBackupFile("not-a-directory");
    const runBackup = vi.fn(async () => null);
    const { events } = startScheduler({ backupDir: join(notADirectory, "backups"), runBackup });

    await vi.advanceTimersByTimeAsync(1000);

    expect(runBackup).not.toHaveBeenCalled();
    expect(events.errors).toHaveLength(1);
    expect((events.errors[0] as NodeJS.ErrnoException).code).toBe("ENOTDIR");
    expect(events.scheduled).toEqual([1000, HOUR]);
  });

  it("keeps rescheduling when free space can't be measured", async () => {
    const runBackup = vi.fn(async () => null);
    const { events } = startScheduler({
      runBackup,
      measureFreeBytes: () => {
        throw Object.assign(new Error("statfs failed"), { code: "EIO" });
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(runBackup).not.toHaveBeenCalled();
    expect(events.errors).toHaveLength(2);
    expect(events.scheduled).toEqual([1000, HOUR, HOUR]);
  });

  it("records a finished run and schedules the next one a full interval later", async () => {
    const runBackup = vi.fn(async () => {
      const backupFile = writeBackupFile("paperclip-1.sql.gz", "dump");
      return { backupFile, sizeBytes: 4 };
    });
    const { events } = startScheduler({ runBackup, measureFreeBytes: () => 50 * GIB });

    await vi.advanceTimersByTimeAsync(1000);

    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(readDatabaseBackupSuccess(dir)).toMatchObject({ backupFile: "paperclip-1.sql.gz", sizeBytes: 4 });
    expect(events.scheduled.at(-1)).toBe(DAY);
  });

  it("retries an hour after a failed run instead of waiting a full interval", async () => {
    const runBackup = vi.fn(async () => null);
    const { events } = startScheduler({ runBackup, measureFreeBytes: () => 50 * GIB });

    await vi.advanceTimersByTimeAsync(1000);

    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(readDatabaseBackupSuccess(dir)).toBeNull();
    expect(events.scheduled).toEqual([1000, HOUR]);
  });

  it("does not run when a backup was confirmed after the tick was scheduled", async () => {
    const runBackup = vi.fn(async () => null);
    const { events } = startScheduler({ runBackup, measureFreeBytes: () => 50 * GIB });

    confirmedBackup("paperclip-manual.sql.gz", 0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(runBackup).not.toHaveBeenCalled();
    expect(events.scheduled.at(-1)).toBe(DAY - 1000);
  });

  it("clears what a run killed with the previous process left and sizes the next run from it", async () => {
    // A JavaScript-engine run killed while compressing: its catch cleanup never ran.
    const sql = partialFile("paperclip-20261030-120000.sql.partial", 15 * MINUTE, "s".repeat(8192));
    const dump = partialFile("paperclip-20261030-120000.sql.gz.partial", 15 * MINUTE, "d".repeat(4096));
    const requiredBytes = requiredFreeBytes(4096, FLOOR);
    const runBackup = vi.fn(async () => null);
    const { events } = startScheduler({ runBackup, measureFreeBytes: () => requiredBytes - 1 });

    // Cleared at start, before any run; only the gzip output sizes the next backup.
    expect(existsSync(sql)).toBe(false);
    expect(existsSync(dump)).toBe(false);
    expect(events.partialsRemoved).toHaveLength(1);
    expect(events.partialsRemoved[0]?.files.sort()).toEqual([basename(dump), basename(sql)]);
    expect(events.partialsRemoved[0]?.bytes).toBe(8192 + 4096);
    expect(estimateDatabaseBackupSizeBytes(dir)).toBe(4096);

    await vi.advanceTimersByTimeAsync(1000);

    // The estimate did not drop to zero, so a run that would cut into the reserve is not started.
    expect(runBackup).not.toHaveBeenCalled();
    expect(events.skipped).toEqual([{ freeBytes: requiredBytes - 1, requiredBytes, sizeEstimateBytes: 4096 }]);
    expect(events.errors).toEqual([]);
  });

  it("leaves a partial file that may still be written alone until it goes stale", async () => {
    const dump = partialFile("paperclip-20261030-120000.sql.gz.partial", 0, "d".repeat(4096));
    const presentWhenMeasured: boolean[] = [];
    const runBackup = vi.fn(async () => null);
    const { events } = startScheduler({
      runBackup,
      measureFreeBytes: () => {
        presentWhenMeasured.push(existsSync(dump));
        return FLOOR - 1;
      },
    });

    // Possibly a live run: kept, but already counted in the estimate.
    expect(existsSync(dump)).toBe(true);
    expect(estimateDatabaseBackupSizeBytes(dir)).toBe(4096);

    await vi.advanceTimersByTimeAsync(1000);
    // Nothing has written to it for an hour: removed before free space is measured.
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(presentWhenMeasured).toEqual([true, false]);
    expect(events.partialsRemoved).toEqual([{ files: [basename(dump)], bytes: 4096 }]);
    expect(estimateDatabaseBackupSizeBytes(dir)).toBe(4096);
    expect(runBackup).not.toHaveBeenCalled();
  });

  it("matches partial files by the configured file name prefix", async () => {
    const own = partialFile("custom-20261030-120000.sql.gz.partial", HOUR, "d");
    const foreign = partialFile("paperclip-20261030-120000.sql.gz.partial", HOUR, "d");

    startScheduler({ runBackup: vi.fn(async () => null), filenamePrefix: "custom", measureFreeBytes: () => FLOOR - 1 });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });

  it("keeps rescheduling when the backup directory can't be listed", async () => {
    const notADirectory = writeBackupFile("not-a-directory");
    const runBackup = vi.fn(async () => null);
    const { events } = startScheduler({ backupDir: notADirectory, runBackup });

    await vi.advanceTimersByTimeAsync(1000);

    expect(runBackup).not.toHaveBeenCalled();
    expect(events.errors.map((err) => (err as NodeJS.ErrnoException).code)).toEqual(["ENOTDIR", "ENOTDIR"]);
    expect(events.scheduled).toEqual([1000, HOUR]);
  });

  it("aborts its running backup on stop()", async () => {
    const signals: AbortSignal[] = [];
    const runBackup = vi.fn(
      (signal: AbortSignal) =>
        new Promise<null>((resolve) => {
          signals.push(signal);
          signal.addEventListener("abort", () => resolve(null), { once: true });
        }),
    );
    const { handle, events } = startScheduler({ runBackup, measureFreeBytes: () => 50 * GIB });

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(signals[0]?.aborted).toBe(true);
    expect(events.scheduled).toEqual([1000]);
  });
});
