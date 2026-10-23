import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertIsolatedWorkspaceSyncAllowed, isRemoteGitRepositoryUrl } from "./isolated-workspace-guard.js";

describe("isolated workspace source guard", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("accepts an approved workspace and refuses key directories, aliases, and broad roots", async () => {
    const temp = await mkdtemp(path.join(os.homedir(), ".paperclip-isolated-workspace-"));
    cleanup.push(temp);
    const workspaceRoot = path.join(temp, "workspaces");
    const workspace = path.join(workspaceRoot, "project");
    const secretDirectory = path.join(temp, "private", "secrets");
    await mkdir(workspace, { recursive: true });
    await mkdir(secretDirectory, { recursive: true });
    await writeFile(path.join(secretDirectory, "master.key"), "synthetic-key-never-upload");
    await symlink(secretDirectory, path.join(workspaceRoot, "secret-alias"));
    const env = {
      PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME: "true",
      PAPERCLIP_SECRETS_HOST_AGENT_UID: String((process.getuid?.() ?? 0) + 1),
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(secretDirectory, "master.key"),
      PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON: JSON.stringify([workspaceRoot]),
    };

    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, env)).resolves.toBe(workspace);
    await expect(assertIsolatedWorkspaceSyncAllowed(secretDirectory, env)).rejects.toThrow(/outside/);
    await expect(assertIsolatedWorkspaceSyncAllowed(path.join(workspaceRoot, "secret-alias"), env)).rejects.toThrow(/outside/);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, {
      ...env,
      PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON: JSON.stringify([temp]),
    })).rejects.toThrow(/overlap/);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, {
      ...env,
      PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON: "[]",
    })).rejects.toThrow(/roots/);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, {
      ...env,
      PAPERCLIP_SECRETS_HOST_AGENT_UID: String(process.getuid?.()),
    })).rejects.toThrow(/separate/);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, {
      ...env,
      PAPERCLIP_SECRETS_HOST_AGENT_UID: "",
    })).rejects.toThrow(/agent UID/);

    await chmod(workspaceRoot, 0o777);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, env)).rejects.toThrow(/agent-immutable/);
  });

  it("admits remote Git URLs but rejects host-local clone sources", () => {
    expect(isRemoteGitRepositoryUrl("https://github.com/org/repo.git")).toBe(true);
    expect(isRemoteGitRepositoryUrl("git@github.com:org/repo.git")).toBe(true);
    expect(isRemoteGitRepositoryUrl("file:///srv/paperclip-private/repo")).toBe(false);
    expect(isRemoteGitRepositoryUrl("/srv/paperclip-private/repo")).toBe(false);
    expect(isRemoteGitRepositoryUrl("../private/repo")).toBe(false);
    expect(isRemoteGitRepositoryUrl("--upload-pack=cmd@host:path")).toBe(false);
  });
});
