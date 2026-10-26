import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPinnedLocalSkillSnapshot, readPinnedLocalSkillFile } from "./pinned-local-skill-snapshot.js";

const describePinned = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;
const classify = (relativePath: string) => relativePath === "SKILL.md" ? "skill" as const : "reference" as const;

describePinned("pinned local skill snapshots", () => {
  let root: string;
  let skillDir: string;
  let secret: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pinned-skill-"));
    skillDir = path.join(root, "workspace", "skill");
    secret = path.join(root, "service-only-credential");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: safe\n---\nUse references/guide.md\n");
    await fs.mkdir(path.join(skillDir, "references"));
    await fs.writeFile(path.join(skillDir, "references", "guide.md"), "safe reference\n");
    await fs.writeFile(secret, "synthetic-service-db-url", { mode: 0o400 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("snapshots regular allowlisted files without following links", async () => {
    const files = await collectPinnedLocalSkillSnapshot(skillDir, "full", classify);
    expect(files).toMatchObject([
      { path: "SKILL.md", kind: "skill", content: expect.stringContaining("name: safe") },
      { path: "references/guide.md", kind: "reference", content: "safe reference\n" },
    ]);
    expect(await readPinnedLocalSkillFile(skillDir, "SKILL.md", "skill")).toMatchObject({ content: files[0]!.content });
  });

  it("limits workspace-root skills to their entrypoint and supported subdirectories", async () => {
    await fs.writeFile(path.join(skillDir, "unrelated.txt"), "workspace data outside the skill");
    const files = await collectPinnedLocalSkillSnapshot(skillDir, "project_root", classify);
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "references/guide.md"]);
    expect(JSON.stringify(files)).not.toContain("workspace data outside the skill");
  });

  it("rejects a linked entrypoint and a hard link to a service-only file", async () => {
    await fs.unlink(path.join(skillDir, "SKILL.md"));
    await fs.symlink(secret, path.join(skillDir, "SKILL.md"));
    await expect(collectPinnedLocalSkillSnapshot(skillDir, "full", classify)).rejects.toThrow(/Unsafe local skill source entry/);
    await expect(readPinnedLocalSkillFile(skillDir, "SKILL.md", "skill")).rejects.toThrow(/Unsafe local skill source entry/);
    await fs.unlink(path.join(skillDir, "SKILL.md"));
    await fs.link(secret, path.join(skillDir, "SKILL.md"));
    await expect(collectPinnedLocalSkillSnapshot(skillDir, "full", classify)).rejects.toThrow(/Unsafe local skill source entry/);
  });

  it("rejects source directory aliases and linked companion files", async () => {
    await fs.symlink(secret, path.join(skillDir, "references", "guide-link.md"));
    await expect(collectPinnedLocalSkillSnapshot(skillDir, "full", classify)).rejects.toThrow(/Unsafe local skill source entry/);
    await fs.unlink(path.join(skillDir, "references", "guide-link.md"));
    const alias = path.join(root, "skill-alias");
    await fs.symlink(skillDir, alias);
    await expect(collectPinnedLocalSkillSnapshot(alias, "full", classify)).rejects.toThrow();
  });

  it("fails if a directory is replaced by a link between reading and verification", async () => {
    const moved = path.join(root, "moved-skill");
    const originalOpen = fs.open.bind(fs);
    let sourceOpens = 0;
    vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith(`/skill`)) {
        sourceOpens += 1;
        if (sourceOpens === 2) {
          await fs.rename(skillDir, moved);
          await fs.symlink(path.dirname(secret), skillDir);
        }
      }
      return originalOpen(...args);
    }) as typeof fs.open);
    await expect(collectPinnedLocalSkillSnapshot(skillDir, "full", classify)).rejects.toThrow();
    expect(sourceOpens).toBe(2);
  });
});
