import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

it("refuses to place a skill symlink to a synthetic key in a Claude prompt bundle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-skill-escape-"));
  vi.stubEnv("PAPERCLIP_HOME", root);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-instance");
  try {
    const source = path.join(root, "workspace", "skill");
    const key = path.join(root, "synthetic-master.key");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n");
    await fs.writeFile(key, "synthetic-key-bytes\n");
    await fs.symlink(key, path.join(source, "leak"));

    await expect(prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [{ key: "company/leaky", runtimeName: "leaky", source }],
      instructionsContents: null,
      onLog: async () => {},
    })).rejects.toThrow(/symbolic link/);
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("stages ordinary Claude skills on macOS while keeping key isolation Linux-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-macos-skill-"));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  vi.stubEnv("PAPERCLIP_HOME", root);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-instance");
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  try {
    const source = path.join(root, "workspace", "skill");
    const privateFile = path.join(root, "synthetic-master.key");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n");
    await fs.writeFile(privateFile, "synthetic-key-bytes\n");
    await fs.symlink(privateFile, path.join(source, "leak"));
    const input = {
      companyId: "company-1",
      skills: [{ key: "company/skill", runtimeName: "skill", source }],
      instructionsContents: null,
      onLog: async () => {},
    };

    const bundle = await prepareClaudePromptBundle(input);
    await expect(fs.readFile(path.join(bundle.rootDir, ".claude", "skills", "skill", "SKILL.md"), "utf8"))
      .resolves.toBe("# skill\n");
    await expect(fs.lstat(path.join(bundle.rootDir, ".claude", "skills", "skill", "leak")))
      .rejects.toMatchObject({ code: "ENOENT" });

    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    await expect(prepareClaudePromptBundle(input)).rejects.toThrow(/requires Linux/);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
