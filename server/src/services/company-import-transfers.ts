import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { companyTransferRunService } from "./company-transfer-runs.js";

// Disk spool for chunked resumable company imports. The client slices its
// existing import .zip into byte-range parts and uploads them one at a time;
// each verified part is spooled at
//
//   <instance root>/import-transfers/<runId>/part-<index>
//
// until apply assembles them back into the original zip. The layout follows
// the other per-instance state dirs that live directly under the instance root
// (telemetry/, runtime-services/, skills/, data/run-logs/); like those
// siblings it needs no backup/export exclusion wiring — database backups dump
// embedded Postgres, they do not walk the instance root tree.

/** Spool dirs with no upload/apply activity for this long are abandoned. */
export const IMPORT_TRANSFER_SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How often the abandoned-spool sweep runs. */
export const IMPORT_TRANSFER_SPOOL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveDefaultImportTransferSpoolRoot(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "import-transfers");
}

/**
 * Transfer run ids come from request URLs and are joined into filesystem
 * paths, so they are accepted only as canonical UUIDs — anything else (path
 * separators, dots, empty segments) is rejected before any path is built.
 */
export function isImportTransferRunId(value: string): boolean {
  return UUID_RE.test(value);
}

export function importTransferPartName(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid import transfer part index: ${String(index)}`);
  }
  return `part-${index}`;
}

function spoolDirFor(spoolRoot: string, runId: string): string {
  if (!isImportTransferRunId(runId)) {
    throw new Error("Invalid import transfer run id");
  }
  return path.join(spoolRoot, runId);
}

function partPathFor(spoolRoot: string, runId: string, index: number): string {
  return path.join(spoolDirFor(spoolRoot, runId), importTransferPartName(index));
}

/** Atomic part write: temp file in the same dir, then rename over the target. */
export async function writeImportTransferPart(
  spoolRoot: string,
  runId: string,
  index: number,
  bytes: Buffer,
): Promise<void> {
  const target = partPathFor(spoolRoot, runId, index);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tempPath, bytes);
  await fs.rename(tempPath, target);
}

/** Byte size of a spooled part, or null when it is missing (or not a file). */
export async function importTransferPartSizeOnDisk(
  spoolRoot: string,
  runId: string,
  index: number,
): Promise<number | null> {
  try {
    const stat = await fs.stat(partPathFor(spoolRoot, runId, index));
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/**
 * Concatenate the spooled parts, in index order, back into the original zip.
 * The full-zip buffer this produces exists only for the duration of an apply —
 * the same memory profile as the single-shot zip upload path.
 */
export async function assembleImportTransferZip(
  spoolRoot: string,
  runId: string,
  partCount: number,
): Promise<Buffer> {
  const buffers: Buffer[] = [];
  for (let index = 0; index < partCount; index += 1) {
    buffers.push(await fs.readFile(partPathFor(spoolRoot, runId, index)));
  }
  return Buffer.concat(buffers);
}

export async function removeImportTransferSpool(spoolRoot: string, runId: string): Promise<void> {
  await fs.rm(spoolDirFor(spoolRoot, runId), { recursive: true, force: true });
}

/**
 * Delete spool dirs whose transfer saw no activity for `maxAgeMs` and fail
 * their still-open ledger runs. Freshness comes from the ledger run's
 * `updatedAt` (every part upload bumps it) when the run exists, and from the
 * dir's mtime for orphan dirs with no run row. Terminal runs keep their status;
 * a later resume of a swept run re-uploads every part, because part
 * completeness is always re-checked against the files on disk.
 */
export async function sweepAbandonedImportTransferSpools(
  db: Db,
  spoolRoot: string,
  options: { maxAgeMs?: number; now?: Date } = {},
): Promise<{ swept: number }> {
  const maxAgeMs = options.maxAgeMs ?? IMPORT_TRANSFER_SPOOL_MAX_AGE_MS;
  const nowMs = (options.now ?? new Date()).getTime();
  let entries;
  try {
    entries = await fs.readdir(spoolRoot, { withFileTypes: true });
  } catch {
    return { swept: 0 };
  }
  let swept = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isImportTransferRunId(entry.name)) continue;
    const runId = entry.name;
    const run = await companyTransferRunService.getRun(db, runId).catch(() => null);
    let lastActivityMs: number;
    if (run) {
      lastActivityMs = run.updatedAt.getTime();
    } else {
      try {
        lastActivityMs = (await fs.stat(path.join(spoolRoot, runId))).mtimeMs;
      } catch {
        continue;
      }
    }
    if (nowMs - lastActivityMs <= maxAgeMs) continue;
    await fs.rm(path.join(spoolRoot, runId), { recursive: true, force: true });
    if (run && (run.status === "pending" || run.status === "running")) {
      await companyTransferRunService.fail(
        db,
        runId,
        "Abandoned import transfer: spooled parts were deleted after prolonged inactivity.",
      );
    }
    swept += 1;
  }
  return { swept };
}
