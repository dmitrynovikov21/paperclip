function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectFileBackedAdapterAuthSourcePaths(
  adapterConfig: unknown,
  prefix = "adapterConfig",
): string[] {
  if (!isRecord(adapterConfig)) return [];
  const env = isRecord(adapterConfig.env) ? adapterConfig.env : null;
  return [
    ...(env && Object.hasOwn(env, "CODEX_HOME") ? [`${prefix}.env.CODEX_HOME`] : []),
    ...(Object.hasOwn(adapterConfig, "paperclipConnectorSkillDigest") ? [`${prefix}.paperclipConnectorSkillDigest`] : []),
    ...(Object.hasOwn(adapterConfig, "managedAiConnection") ? [`${prefix}.managedAiConnection`] : []),
  ];
}

export function collectFileBackedIssueAuthSourcePaths(overrides: unknown): string[] {
  if (!isRecord(overrides)) return [];
  return collectFileBackedAdapterAuthSourcePaths(
    overrides.adapterConfig,
    "assigneeAdapterOverrides.adapterConfig",
  );
}

export function assertNoFileBackedIssueAuthSourceOverrides(overrides: unknown): void {
  if (!process.env.PAPERCLIP_DATABASE_URL_FILE?.trim()) return;
  const paths = collectFileBackedIssueAuthSourcePaths(overrides);
  if (paths.length > 0) {
    throw new Error(`Issue adapter overrides cannot select connector authentication sources with file-backed database credentials (${paths.join(", ")}).`);
  }
}
