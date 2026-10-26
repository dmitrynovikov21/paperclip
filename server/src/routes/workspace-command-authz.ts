import type { Request } from "express";
import { forbidden } from "../errors.js";
import { collectFileBackedIssueAuthSourcePaths } from "../lib/adapter-auth-source.js";
import { isRemoteGitRepositoryUrl } from "@paperclipai/adapter-utils/isolated-workspace-guard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function prefixPath(prefix: string, key: string) {
  return prefix.length > 0 ? `${prefix}.${key}` : key;
}

function collectWorkspaceStrategyCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "runtimeProvisionCommand")) {
    paths.push(prefixPath(prefix, "runtimeProvisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  return paths;
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "runtimeProvisionCommand")) {
    paths.push(prefixPath(prefix, "runtimeProvisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  if (hasOwn(raw, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  return paths;
}

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

/** Host paths are selected by an operator when key isolation is enabled. */
export function assertNoAgentHostWorkspacePathMutation(req: Request, workspacePatch: unknown) {
  if (process.env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME !== "true" ||
      req.actor.type !== "agent" || !isRecord(workspacePatch)) return;
  if (hasOwn(workspacePatch, "cwd")) {
    throw forbidden("Agent keys cannot set project workspace host paths in isolated secrets mode.");
  }
  const repoUrl = workspacePatch.repoUrl;
  if (typeof repoUrl === "string" && repoUrl.trim() && !isRemoteGitRepositoryUrl(repoUrl)) {
    throw forbidden("Agent keys cannot select host-local Git sources in isolated secrets mode.");
  }
}

export function collectAgentAdapterWorkspaceCommandPaths(
  adapterConfig: unknown,
  prefix = "adapterConfig",
): string[] {
  if (!isRecord(adapterConfig)) return [];
  return [
    ...collectWorkspaceStrategyCommandPaths(
      adapterConfig.workspaceStrategy,
      `${prefix}.workspaceStrategy`,
    ),
    ...(hasOwn(adapterConfig, "filesystemSandboxCommand")
      ? [`${prefix}.filesystemSandboxCommand`]
      : []),
  ];
}

/** File-backed service credentials must never be reachable through agent-selected mounts. */
export function assertNoAgentFilesystemExtraPathsMutation(
  req: Request,
  adapterConfig: unknown,
  prefix = "adapterConfig",
) {
  if (req.actor.type !== "agent" || !process.env.PAPERCLIP_DATABASE_URL_FILE?.trim() ||
      !isRecord(adapterConfig) || !hasOwn(adapterConfig, "filesystemExtraPaths")) return;
  throw forbidden(`Agent-authenticated callers cannot modify ${prefix}.filesystemExtraPaths with file-backed database credentials.`);
}

export function collectProjectExecutionWorkspaceCommandPaths(policy: unknown): string[] {
  if (!isRecord(policy)) return [];
  return collectWorkspaceStrategyCommandPaths(
    policy.workspaceStrategy,
    "executionWorkspacePolicy.workspaceStrategy",
  );
}

export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
): string[] {
  if (!isRecord(workspacePatch)) return [];
  return hasOwn(workspacePatch, "cleanupCommand")
    ? [prefixPath(prefix, "cleanupCommand")]
    : [];
}

export function collectIssueWorkspaceCommandPaths(input: {
  executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown;
}): string[] {
  const paths: string[] = [];
  if (isRecord(input.executionWorkspaceSettings)) {
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        input.executionWorkspaceSettings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
      ),
    );
  }
  if (isRecord(input.assigneeAdapterOverrides)) {
    const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
    paths.push(...collectAgentAdapterWorkspaceCommandPaths(
      adapterConfig,
      "assigneeAdapterOverrides.adapterConfig",
    ));
  }
  return paths;
}

export function assertNoAgentIssueConfigMutation(req: Request, input: {
  executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown;
}) {
  assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(input));
  if (req.actor.type !== "agent" || !process.env.PAPERCLIP_DATABASE_URL_FILE?.trim()) return;
  if (isRecord(input.assigneeAdapterOverrides)) {
    assertNoAgentFilesystemExtraPathsMutation(
      req,
      input.assigneeAdapterOverrides.adapterConfig,
      "assigneeAdapterOverrides.adapterConfig",
    );
  }
  const paths = collectFileBackedIssueAuthSourcePaths(input.assigneeAdapterOverrides);
  if (paths.length > 0) {
    throw forbidden(`Agent-authenticated callers cannot modify connector authentication sources (${paths.join(", ")})`);
  }
}

export function collectExecutionWorkspaceCommandPaths(input: {
  config?: unknown;
  metadata?: unknown;
}): string[] {
  const paths: string[] = [];
  if (input.config !== undefined) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.config, "config"));
  }
  if (isRecord(input.metadata) && hasOwn(input.metadata, "config")) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.metadata.config, "metadata.config"));
  }
  return paths;
}
