export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_") || /^PG[A-Z0-9_]+$/.test(key)) {
      delete env[key];
    }
  }
  delete env.BETTER_AUTH_URL;
  delete env.BETTER_AUTH_BASE_URL;
  delete env.DATABASE_URL;
  delete env.DATABASE_MIGRATION_URL;
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  return env;
}

/** Strip service-only credentials after adapter and service overrides are merged. */
export function sanitizeRuntimeServiceChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.PAPERCLIP_DATABASE_URL_FILE;
  delete sanitized.PAPERCLIP_AGENT_JWT_SECRET;
  if (process.env.PAPERCLIP_DATABASE_URL_FILE?.trim()) {
    delete sanitized.DATABASE_URL;
    delete sanitized.DATABASE_MIGRATION_URL;
    for (const key of Object.keys(sanitized)) {
      if (/^PG[A-Z0-9_]+$/.test(key)) delete sanitized[key];
    }
  }
  return sanitized;
}
