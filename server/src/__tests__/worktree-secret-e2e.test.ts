import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { prepareSandboxManagedRuntime, type SandboxManagedRuntimeClient } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { readPaperclipEnvEntries } from "../../../cli/src/config/env.js";
import { worktreeInitCommand } from "../../../cli/src/commands/worktree.js";
import { expect, it } from "vitest";

const execFile = promisify(execFileCallback);

function filesystemSandboxClient(): SandboxManagedRuntimeClient {
  const client: SandboxManagedRuntimeClient = {
    makeDir: async (remotePath) => { await fs.mkdir(remotePath, { recursive: true }); },
    writeFile: async (remotePath, bytes) => {
      await fs.mkdir(path.dirname(remotePath), { recursive: true });
      await fs.writeFile(remotePath, Buffer.from(bytes));
    },
    readFile: async (remotePath) => await fs.readFile(remotePath),
    listFiles: async (remotePath) => (await fs.readdir(remotePath).catch(() => [])).sort(),
    remove: async (remotePath) => { await fs.rm(remotePath, { recursive: true, force: true }); },
    run: async (command) => { await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 }); },
  };
  client.syncIn = async (operations) => {
    const results = [];
    for (const operation of operations) {
      let bytesTransferred = 0;
      for (const mapping of operation.files) {
        const bytes = await fs.readFile(mapping.sourcePath);
        await client.makeDir(path.dirname(mapping.targetPath));
        await client.writeFile(mapping.targetPath, bytes);
        if (mapping.mode != null) await fs.chmod(mapping.targetPath, mapping.mode);
        bytesTransferred += bytes.length;
      }
      for (const command of operation.postUploadCommands ?? []) await client.run(command.command);
      results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred });
    }
    return { operations: results };
  };
  return client;
}

it("keeps source signing keys outside a Kubernetes-style worktree run and accepts its scoped JWT", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-secret-e2e-"));
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  const remote = path.join(root, "sandbox");
  const previousCwd = process.cwd();
  const previousEnv = {
    PAPERCLIP_AGENT_JWT_SECRET: process.env.PAPERCLIP_AGENT_JWT_SECRET,
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET,
    PAPERCLIP_INSTANCE_ID: process.env.PAPERCLIP_INSTANCE_ID,
  };
  let restoreWorkspace: (() => Promise<void>) | undefined;
  try {
    await fs.mkdir(source);
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(source, ".env"), "PAPERCLIP_AGENT_JWT_SECRET=synthetic-source-jwt\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=synthetic-source-actions\n");
    await execFile("git", ["init", "-q", workspace]);
    await execFile("git", ["-C", workspace, "config", "user.name", "Paperclip Test"]);
    await execFile("git", ["-C", workspace, "config", "user.email", "test@paperclip.dev"]);
    await fs.writeFile(path.join(workspace, "README.md"), "safe workspace\n");
    await execFile("git", ["-C", workspace, "add", "README.md"]);
    await execFile("git", ["-C", workspace, "commit", "-qm", "fixture"]);

    process.env.PAPERCLIP_AGENT_JWT_SECRET = "synthetic-source-jwt";
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "synthetic-source-actions";
    process.env.PAPERCLIP_INSTANCE_ID = "synthetic-source";
    process.chdir(workspace);
    await worktreeInitCommand({ seed: false, fromConfig: path.join(source, "config.json"), home: path.join(root, "instances") });
    const saved = readPaperclipEnvEntries(path.join(workspace, ".paperclip", ".env"));
    expect(saved.PAPERCLIP_AGENT_JWT_SECRET).toBeTruthy();
    expect(saved.PAPERCLIP_AGENT_JWT_SECRET).not.toBe("synthetic-source-jwt");
    expect(saved.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).not.toBe("synthetic-source-actions");

    const client = filesystemSandboxClient();
    const prepared = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "kubernetes", sandboxId: "synthetic", remoteCwd: remote, timeoutMs: 30_000, apiKey: null },
      client, adapterKey: "test", workspaceLocalDir: workspace,
    });
    restoreWorkspace = prepared.restoreWorkspace;
    await client.run(`test ! -e '${path.join(remote, ".paperclip")}'`);
    expect(await fs.readFile(path.join(remote, "README.md"), "utf8")).toBe("safe workspace\n");

    // Model a lease that still holds a copy uploaded before the exclusion fix.
    await fs.mkdir(path.join(remote, ".paperclip"));
    await fs.writeFile(path.join(remote, ".paperclip", ".env"), "PAPERCLIP_AGENT_JWT_SECRET=synthetic-source-jwt\n");
    await fs.mkdir(path.join(remote, "nested", ".paperclip"), { recursive: true });
    await fs.writeFile(path.join(remote, "nested", ".paperclip", ".env"), "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=synthetic-source-actions\n");
    const adopted = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "kubernetes", sandboxId: "synthetic", remoteCwd: remote, timeoutMs: 30_000, apiKey: null },
      client, adapterKey: "test", workspaceLocalDir: workspace,
      workspaceInboundMode: "adopt_remote",
    });
    restoreWorkspace = adopted.restoreWorkspace;
    await prepared.cleanupWorkspaceSnapshot?.();
    await client.run(`test ! -e '${path.join(remote, ".paperclip")}' && test ! -e '${path.join(remote, "nested", ".paperclip")}'`);
    expect(await fs.readFile(path.join(remote, "README.md"), "utf8")).toBe("safe workspace\n");

    const agentId = randomUUID();
    const companyId = randomUUID();
    const runId = randomUUID();
    const sourceToken = createLocalAgentJwt(agentId, companyId, "codex_local", runId, null);
    process.env.PAPERCLIP_INSTANCE_ID = saved.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = saved.PAPERCLIP_AGENT_JWT_SECRET;
    const runToken = createLocalAgentJwt(agentId, companyId, "codex_local", runId, null);
    const db = {
      select: () => ({ from: (table: unknown) => ({ where: async () => {
        if (table === agents) return [{ id: agentId, companyId, status: "active", lifecycleHolds: [] }];
        if (table === heartbeatRuns) return [{ id: runId, companyId, agentId, status: "running", contextSnapshot: {}, resultJson: {} }];
        return [];
      } }) }),
    } as any;
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.get("/actor", (req, res) => res.json(req.actor));
    const authorized = await request(app).get("/actor").set("Authorization", `Bearer ${runToken}`);
    expect(authorized.status).toBe(200);
    expect(authorized.body).toMatchObject({ type: "agent", agentId, companyId, runId });
    expect((await request(app).get("/actor").set("Authorization", `Bearer ${sourceToken}`)).status).toBe(401);
  } finally {
    try {
      await restoreWorkspace?.();
    } finally {
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
