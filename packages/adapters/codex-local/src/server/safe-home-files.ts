import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";

// Remote staging runs on the host. A local agent can change its mounted home
// while the service is preparing a later run, so paths below that home must be
// opened relative to pinned directories, never checked and then read by name.
const fdRoot = process.platform === "linux" ? "/proc/self/fd" :
  process.platform === "darwin" ? "/dev/fd" : null;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function fdPath(dir: FileHandle, name?: string): string {
  if (!fdRoot) throw new Error("Safe Codex home staging requires a POSIX descriptor filesystem");
  if (name && (name === "." || name === ".." || path.basename(name) !== name)) {
    throw new Error("Invalid Codex home entry name");
  }
  return name ? path.join(fdRoot, String(dir.fd), name) : path.join(fdRoot, String(dir.fd));
}

export async function openDirectoryNoFollow(directory: string): Promise<FileHandle> {
  if (!fdRoot || !path.isAbsolute(directory)) {
    throw new Error("Safe Codex home staging requires an absolute POSIX path");
  }
  const parts = path.resolve(directory).split(path.sep).filter(Boolean);
  let current = await fs.open(path.parse(directory).root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of parts) {
      const next = await fs.open(
        fdPath(current, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

export async function openChildNoFollow(dir: FileHandle, name: string): Promise<FileHandle | null> {
  try {
    return await fs.open(fdPath(dir, name), readFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw error;
  }
}

export async function lstatChild(dir: FileHandle, name: string): Promise<Stats | null> {
  try {
    return await fs.lstat(fdPath(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function openPathNoFollow(candidate: string): Promise<FileHandle | null> {
  const dir = await openDirectoryNoFollow(path.dirname(candidate));
  try {
    return await openChildNoFollow(dir, path.basename(candidate));
  } finally {
    await dir.close();
  }
}

export async function readRegularFileNoFollow(candidate: string): Promise<Buffer | null> {
  const handle = await openPathNoFollow(candidate);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Codex home entry is not a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readChildLink(dir: FileHandle, name: string): Promise<string | null> {
  try {
    return await fs.readlink(fdPath(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listPinnedDirectory(dir: FileHandle): Promise<string[]> {
  return fs.readdir(fdPath(dir));
}

export async function replaceRegularFileNoFollow(candidate: string, bytes: string | Buffer): Promise<void> {
  const dir = await openDirectoryNoFollow(path.dirname(candidate));
  const name = path.basename(candidate);
  const temporary = `.paperclip-${randomUUID()}`;
  const temporaryPath = fdPath(dir, temporary);
  const targetPath = fdPath(dir, name);
  try {
    const handle = await fs.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    // Rename replaces the directory entry itself, never its symlink target.
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await dir.close();
  }
}

export async function removeFileNoFollow(candidate: string): Promise<void> {
  const dir = await openDirectoryNoFollow(path.dirname(candidate));
  try {
    await fs.unlink(fdPath(dir, path.basename(candidate))).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  } finally {
    await dir.close();
  }
}
