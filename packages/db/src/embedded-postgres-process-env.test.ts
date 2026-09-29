import { readFileSync, statSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const testOnLinux = support.supported && process.platform === "linux" ? it : it.skip;

function procEnvNames(pid: number): Set<string> {
  const bytes = readFileSync(`/proc/${pid}/environ`);
  const names = new Set<string>();
  for (let start = 0; start < bytes.length;) {
    const end = bytes.indexOf(0, start);
    if (end < 0) break;
    const equals = bytes.indexOf(61, start);
    if (equals > start && equals < end) names.add(bytes.subarray(start, equals).toString("utf8"));
    start = end + 1;
  }
  return names;
}

describe("embedded Postgres child environment", () => {
  testOnLinux("keeps control-plane secret names out of a same-UID Postgres backend", async () => {
    const originalEnv = { ...process.env };
    const isolatedEnv: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"]) {
      if (originalEnv[name] !== undefined) isolatedEnv[name] = originalEnv[name];
    }
    isolatedEnv.PAPERCLIP_AGENT_JWT_SECRET = "test-marker";
    isolatedEnv.BETTER_AUTH_SECRET = "test-marker";
    isolatedEnv.PAPERCLIP_TEST_API_TOKEN = "test-marker";
    process.env = isolatedEnv;

    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let sql: ReturnType<typeof postgres> | null = null;
    try {
      database = await startEmbeddedPostgresTestDatabase("paperclip-pg-child-env-");
      sql = postgres(database.connectionString, { max: 1 });
      const rows = await sql`select pg_backend_pid() as pid`;
      const pid = Number(rows[0]?.pid);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(statSync(`/proc/${pid}`).uid).toBe(process.getuid?.());

      const names = procEnvNames(pid);
      expect([...names].filter((name) =>
        ["PAPERCLIP_AGENT_JWT_SECRET", "BETTER_AUTH_SECRET", "PAPERCLIP_TEST_API_TOKEN"].includes(name),
      )).toEqual([]);
    } finally {
      try {
        await sql?.end();
        await database?.cleanup();
      } finally {
        process.env = originalEnv;
      }
    }
  }, 60_000);
});
