import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
} from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { assertGitWorktreeBaseWorkspaceReady } from "../services/heartbeat.js";
import {
  ensurePersistedExecutionWorkspaceAvailable,
  realizeExecutionWorkspace,
  type ExecutionWorkspaceInput,
} from "../services/workspace-runtime.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.homedir(), ".paperclip-host-git-test-"));
  roots.push(root);
  const repoRoot = path.join(root, "workspaces", "project");
  const keyFile = path.join(root, "private", "master.key");
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  await fs.writeFile(keyFile, "synthetic-test-key-only");
  const git = async (args: string[], cwd = repoRoot) => execFile("git", args, { cwd });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Paperclip Test"]);
  await git(["config", "user.email", "test@paperclip.dev"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "safe\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "synthetic base"]);
  return { root, repoRoot, keyFile, git };
}

function enableIsolation(repoRoot: string, keyFile: string) {
  vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
  vi.stubEnv("PAPERCLIP_SECRETS_HOST_AGENT_UID", String((process.getuid?.() ?? 0) + 1));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", keyFile);
  vi.stubEnv("PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON", JSON.stringify([path.dirname(repoRoot)]));
}

function base(repoRoot: string): ExecutionWorkspaceInput {
  return {
    baseCwd: repoRoot,
    source: "project_primary",
    projectId: "project-test",
    workspaceId: "workspace-test",
    repoUrl: null,
    repoRef: "HEAD",
  };
}

const issue = { id: "issue-test", identifier: "PAP-1", title: "Synthetic Git guard" };
const agent = { id: "agent-test", name: "Test", companyId: "company-test" };
const config = { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" } };

describe.skipIf(process.platform !== "linux")("isolated host Git before sandbox sync", () => {
  it("creates a worktree without calling a service-owned hook or ambient fsmonitor script", async () => {
    const { root, repoRoot, keyFile } = await createFixture();
    const hookMarker = path.join(root, "hook-called");
    const fsmonitorMarker = path.join(root, "fsmonitor-called");
    const agentHookScript = path.join(repoRoot, "agent-hook.sh");
    const agentFsmonitorScript = path.join(repoRoot, "agent-fsmonitor.sh");
    await fs.writeFile(agentHookScript, '#!/bin/sh\nprintf hook > "$PAPERCLIP_TEST_HOOK_MARKER"\n');
    await fs.writeFile(agentFsmonitorScript, '#!/bin/sh\nprintf fsmonitor > "$PAPERCLIP_TEST_FSMONITOR_MARKER"\n');
    await fs.chmod(agentHookScript, 0o777);
    await fs.chmod(agentFsmonitorScript, 0o777);
    await fs.writeFile(
      path.join(repoRoot, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\n"${agentHookScript}"\n`,
      { mode: 0o755 },
    );
    enableIsolation(repoRoot, keyFile);
    vi.stubEnv("PAPERCLIP_TEST_HOOK_MARKER", hookMarker);
    vi.stubEnv("PAPERCLIP_TEST_FSMONITOR_MARKER", fsmonitorMarker);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
    vi.stubEnv("GIT_CONFIG_VALUE_0", agentFsmonitorScript);

    await assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "isolated_workspace",
      config,
      issue: { ...issue, projectId: "project-test", projectWorkspaceId: "workspace-test" },
      base: base(repoRoot),
    });
    const workspace = await realizeExecutionWorkspace({ base: base(repoRoot), config, issue, agent });

    expect(workspace.created).toBe(true);
    await expect(fs.stat(workspace.cwd)).resolves.toBeTruthy();
    await expect(fs.stat(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(fsmonitorMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects writable Git config with fsmonitor before reuse or sandbox sync", async () => {
    const { root, repoRoot, keyFile, git } = await createFixture();
    enableIsolation(repoRoot, keyFile);
    const initial = await realizeExecutionWorkspace({ base: base(repoRoot), config, issue, agent });
    const marker = path.join(root, "fsmonitor-called");
    const script = path.join(repoRoot, "agent-fsmonitor.sh");
    await fs.writeFile(script, '#!/bin/sh\nprintf fsmonitor > "$PAPERCLIP_TEST_FSMONITOR_MARKER"\n');
    await fs.chmod(script, 0o777);
    vi.stubEnv("PAPERCLIP_TEST_FSMONITOR_MARKER", marker);
    await git(["config", "core.fsmonitor", script]);
    await fs.chmod(path.join(repoRoot, ".git", "config"), 0o666);

    const syncIn = vi.fn(async () => ({ operations: [] }));
    const client = { syncIn } as unknown as SandboxManagedRuntimeClient;
    const prepare = vi.fn((workspaceCwd: string) => prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "test", sandboxId: "test", remoteCwd: path.join(root, "remote"), timeoutMs: 30_000, apiKey: null },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: workspaceCwd,
    }));
    await expect((async () => {
      const reused = await ensurePersistedExecutionWorkspaceAvailable({
        base: base(repoRoot),
        workspace: {
          id: "execution-workspace-test",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: initial.cwd,
          providerRef: initial.cwd,
          projectId: "project-test",
          projectWorkspaceId: "workspace-test",
          repoUrl: null,
          baseRef: "HEAD",
          branchName: initial.branchName,
        },
        issue,
        agent,
      });
      if (reused) await prepare(reused.cwd);
    })()).rejects.toThrow(/agent-immutable Git metadata/);
    expect(prepare).not.toHaveBeenCalled();
    expect(syncIn).not.toHaveBeenCalled();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "isolated_workspace",
      config,
      issue: { ...issue, projectId: "project-test", projectWorkspaceId: "workspace-test" },
      base: base(repoRoot),
    })).rejects.toThrow(/agent-immutable Git metadata/);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
