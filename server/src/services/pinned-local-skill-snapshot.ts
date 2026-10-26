import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { assertSkillSnapshotPath, snapshotFile } from "./skill-snapshot.js";

export const PROJECT_ROOT_SKILL_SUBDIRECTORIES = ["references", "scripts", "assets"] as const;

const fdRoot = process.platform === "linux" ? "/proc/self/fd"
  : process.platform === "darwin" ? "/dev/fd" : null;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type FileKind = CompanySkillVersionFileInventoryEntry["kind"];
type EntryIdentity = { path: string; dev: number; ino: number; directory: boolean; size?: number; mtimeMs?: number };

function childPath(directory: FileHandle, name: string) {
  if (!fdRoot || name === "." || name === ".." || path.basename(name) !== name) {
    throw new Error("Unsafe local skill source path");
  }
  return path.join(fdRoot, String(directory.fd), name);
}

async function openSourceDirectory(source: string): Promise<FileHandle> {
  // The source can be agent-writable. Without descriptor-relative traversal a
  // concurrent directory swap could redirect a later service-side read.
  if (!fdRoot || !path.isAbsolute(source)) throw new Error("Local skill snapshots require descriptor-based source access");
  const absolute = path.resolve(source);
  const root = path.parse(absolute).root;
  let directory = await fs.open(root, directoryFlags);
  try {
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      const next = await fs.open(childPath(directory, part), directoryFlags);
      await directory.close();
      directory = next;
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function collect(
  source: string,
  mode: "full" | "project_root",
  classifyKind: (relativePath: string) => FileKind,
  readBytes: boolean,
): Promise<{ identities: EntryIdentity[]; files: CompanySkillVersionFileInventoryEntry[] }> {
  const root = await openSourceDirectory(source);
  const identities: EntryIdentity[] = [];
  const files: CompanySkillVersionFileInventoryEntry[] = [];
  let sawEntrypoint = false;

  async function visit(directory: FileHandle, relativeDir: string) {
    const stat = await directory.stat();
    identities.push({ path: relativeDir, dev: stat.dev, ino: stat.ino, directory: true });
    const names = (await fs.readdir(path.join(fdRoot!, String(directory.fd)))).sort();
    for (const name of names) {
      if (name === ".git" || name === "node_modules") continue;
      if (mode === "project_root" && !relativeDir && name !== "SKILL.md"
        && !(PROJECT_ROOT_SKILL_SUBDIRECTORIES as readonly string[]).includes(name)) continue;
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      let child: FileHandle;
      try {
        child = await fs.open(childPath(directory, name), fileFlags);
      } catch {
        throw new Error("Unsafe local skill source entry");
      }
      try {
        const entry = await child.stat();
        if (entry.isDirectory()) {
          if (relativePath === "SKILL.md") throw new Error("Unsafe local skill entrypoint");
          await visit(child, relativePath);
        } else if (entry.isFile() && entry.nlink === 1) {
          if (mode === "project_root" && !relativeDir && name !== "SKILL.md") {
            throw new Error("Unsafe local skill source entry");
          }
          identities.push({ path: relativePath, dev: entry.dev, ino: entry.ino, size: entry.size,
            mtimeMs: entry.mtimeMs, directory: false });
          if (relativePath === "SKILL.md") sawEntrypoint = true;
          if (readBytes) files.push(snapshotFile(relativePath, classifyKind(relativePath), await child.readFile(), Boolean(entry.mode & 0o111)));
        } else {
          throw new Error("Unsafe local skill source entry");
        }
      } finally {
        await child.close();
      }
    }
  }

  try {
    await visit(root, "");
    if (!sawEntrypoint) throw new Error("Local skill source has no regular SKILL.md");
    return { identities, files };
  } finally {
    await root.close();
  }
}

/** Snapshot only files opened beneath pinned directories; reject a source swap before publication. */
export async function collectPinnedLocalSkillSnapshot(
  source: string,
  mode: "full" | "project_root",
  classifyKind: (relativePath: string) => FileKind,
): Promise<CompanySkillVersionFileInventoryEntry[]> {
  const snapshot = await collect(source, mode, classifyKind, true);
  const verified = await collect(source, mode, classifyKind, false);
  if (JSON.stringify(snapshot.identities) !== JSON.stringify(verified.identities)) {
    throw new Error("Local skill source changed during snapshot");
  }
  return snapshot.files.sort((left, right) => left.path === "SKILL.md" ? -1
    : right.path === "SKILL.md" ? 1 : left.path.localeCompare(right.path));
}

async function openRelativeFile(source: string, relativePath: string): Promise<FileHandle> {
  let directory = await openSourceDirectory(source);
  try {
    const parts = relativePath.split("/");
    for (const part of parts.slice(0, -1)) {
      const next = await fs.open(childPath(directory, part), directoryFlags);
      await directory.close();
      directory = next;
    }
    return await fs.open(childPath(directory, parts.at(-1)!), fileFlags);
  } finally {
    await directory.close();
  }
}

/** Read a single installed file for API callers without dereferencing an agent-planted link. */
export async function readPinnedLocalSkillFile(
  source: string,
  relativePath: string,
  kind: FileKind,
): Promise<CompanySkillVersionFileInventoryEntry | null> {
  assertSkillSnapshotPath(relativePath);
  let file: FileHandle;
  try {
    file = await openRelativeFile(source, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Unsafe local skill source entry");
  }
  let before: Stats;
  let bytes: Buffer;
  try {
    before = await file.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error("Unsafe local skill source entry");
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  let check: FileHandle;
  try {
    check = await openRelativeFile(source, relativePath);
  } catch {
    throw new Error("Local skill source changed during read");
  }
  try {
    const after = await check.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Local skill source changed during read");
    }
  } finally {
    await check.close();
  }
  return snapshotFile(relativePath, kind, bytes, Boolean(before.mode & 0o111));
}
