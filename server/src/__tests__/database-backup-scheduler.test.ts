import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeNextBackupDelayMs,
  requiredFreeBytes,
  startDatabaseBackupScheduler,
} from "../services/database-backup-scheduler.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "db-backup-scheduler-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBackupFile(name: string, ageMs: number) {
  const path = join(dir, name);
  writeFileSync(path, "x");
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(path, mtime, mtime);
}

describe("computeNextBackupDelayMs", () => {
  it("returns the warmup delay when no backup file exists yet", () => {
    const delay = computeNextBackupDelayMs({
      backupDir: dir,
      intervalMs: 24 * 60 * 60 * 1000,
      warmupDelayMs: 5000,
    });
    expect(delay).toBe(5000);
  });

  it("schedules the remaining time until the newest backup file turns intervalMs old", () => {
    writeBackupFile("paperclip-20260101.sql.gz", 60 * 60 * 1000); // 1h old
    const intervalMs = 24 * 60 * 60 * 1000;
    const delay = computeNextBackupDelayMs({ backupDir: dir, intervalMs, warmupDelayMs: 5000 });
    expect(delay).toBeGreaterThan(22 * 60 * 60 * 1000);
    expect(delay).toBeLessThanOrEqual(23 * 60 * 60 * 1000);
  });

  it("falls back to the warmup delay when the newest backup is already older than the interval", () => {
    writeBackupFile("paperclip-old.sql.gz", 48 * 60 * 60 * 1000); // 2 days old
    const delay = computeNextBackupDelayMs({
      backupDir: dir,
      intervalMs: 24 * 60 * 60 * 1000,
      warmupDelayMs: 7000,
    });
    expect(delay).toBe(7000);
  });

  it("does not rearm a full interval on every process restart (regression for bare setInterval bug)", () => {
    // A backup completed 23h ago; the process just restarted (e.g. a redeploy).
    writeBackupFile("paperclip-recent.sql.gz", 23 * 60 * 60 * 1000);
    const delay = computeNextBackupDelayMs({
      backupDir: dir,
      intervalMs: 24 * 60 * 60 * 1000,
      warmupDelayMs: 5000,
    });
    // Must be close to the 1h remaining, never a fresh 24h window.
    expect(delay).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });
});

describe("requiredFreeBytes", () => {
  it("adds a margin over the last backup size on top of the reserve", () => {
    const reserve = 12 * 1024 * 1024 * 1024;
    const lastSize = 4 * 1024 * 1024 * 1024;
    const required = requiredFreeBytes(lastSize, reserve);
    expect(required).toBeGreaterThan(reserve + lastSize);
  });

  it("falls back to just the reserve when there is no prior backup size", () => {
    const reserve = 12 * 1024 * 1024 * 1024;
    expect(requiredFreeBytes(null, reserve)).toBe(reserve);
  });
});

describe("startDatabaseBackupScheduler", () => {
  it("skips a run and reschedules without deleting/creating files when free space is below the requirement", async () => {
    let runCalled = false;
    let skipped: { freeBytes: number; requiredBytes: number } | null = null;
    const handle = startDatabaseBackupScheduler({
      backupDir: dir,
      intervalMs: 24 * 60 * 60 * 1000,
      warmupDelayMs: 0,
      minFreeBytesReserve: Number.MAX_SAFE_INTEGER / 2, // force "not enough space"
      runBackup: async () => {
        runCalled = true;
        return null;
      },
      onSkippedForLowSpace: (info) => {
        skipped = info;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();

    expect(runCalled).toBe(false);
    expect(skipped).not.toBeNull();
  });

  it("runs the backup and reschedules from the chain, not from a fixed setInterval", async () => {
    let runCount = 0;
    const handle = startDatabaseBackupScheduler({
      backupDir: dir,
      intervalMs: 24 * 60 * 60 * 1000,
      warmupDelayMs: 0,
      runBackup: async () => {
        runCount += 1;
        writeBackupFile(`paperclip-${runCount}.sql.gz`, 0);
        return null;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();

    expect(runCount).toBeGreaterThanOrEqual(1);
  });
});
