import fs from "node:fs";
import path from "node:path";

export function isReleaseOwnedBundleTree(bundlePath: string): boolean {
  const serviceUid = process.getuid?.();
  if (process.platform !== "linux" || serviceUid === undefined || serviceUid === 0) return false;

  const checkedPaths = new Set<string>();
  const visitedDirectories = new Set<string>();
  const pending = [bundlePath];
  while (pending.length > 0) {
    const actual = fs.realpathSync(pending.pop()!);
    for (let current = actual; !checkedPaths.has(current); current = path.dirname(current)) {
      const entry = fs.lstatSync(current);
      if ((entry.uid !== serviceUid && entry.uid !== 0) || (entry.mode & 0o022) !== 0) return false;
      checkedPaths.add(current);
      if (current === path.dirname(current)) break;
    }

    const entry = fs.lstatSync(actual);
    if (entry.isFile()) continue;
    if (!entry.isDirectory()) return false;
    if (visitedDirectories.has(actual)) continue;
    visitedDirectories.add(actual);
    for (const name of fs.readdirSync(actual)) pending.push(path.join(actual, name));
  }
  return true;
}
