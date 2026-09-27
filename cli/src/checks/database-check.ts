import fs from "node:fs";
import { resolveDatabaseConnectionString } from "@paperclipai/db";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

export async function databaseCheck(config: PaperclipConfig, configPath?: string): Promise<CheckResult> {
  if (process.env.PAPERCLIP_DATABASE_URL_FILE && config.database.mode !== "postgres") {
    return {
      name: "Database",
      status: "fail",
      message: "PAPERCLIP_DATABASE_URL_FILE requires PostgreSQL mode",
      canRepair: false,
    };
  }
  if (config.database.mode === "postgres") {
    let connectionString: string | undefined;
    try {
      connectionString = resolveDatabaseConnectionString({ configConnectionString: config.database.connectionString });
    } catch (err) {
      return {
        name: "Database",
        status: "fail",
        message: err instanceof Error ? err.message : "Invalid PostgreSQL credential source",
        canRepair: false,
      };
    }
    if (!connectionString) {
      return {
        name: "Database",
        status: "fail",
        message: "PostgreSQL mode selected but no connection string configured",
        canRepair: false,
        repairHint: "Run `paperclipai configure --section database`",
      };
    }

    try {
      const { createDb } = await import("@paperclipai/db");
      const db = createDb(connectionString);
      await db.execute("SELECT 1");
      return {
        name: "Database",
        status: "pass",
        message: "PostgreSQL connection successful",
      };
    } catch (err) {
      return {
        name: "Database",
        status: "fail",
        message: process.env.PAPERCLIP_DATABASE_URL_FILE
          ? "Cannot connect to PostgreSQL using file-backed credential"
          : `Cannot connect to PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
        canRepair: false,
        repairHint: "Check your connection string and ensure PostgreSQL is running",
      };
    }
  }

  if (config.database.mode === "embedded-postgres") {
    const dataDir = resolveRuntimeLikePath(config.database.embeddedPostgresDataDir, configPath);
    const reportedPath = dataDir;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(reportedPath, { recursive: true });
    }

    return {
      name: "Database",
      status: "pass",
      message: `Embedded PostgreSQL configured at ${dataDir} (port ${config.database.embeddedPostgresPort})`,
    };
  }

  return {
    name: "Database",
    status: "fail",
    message: `Unknown database mode: ${String(config.database.mode)}`,
    canRepair: false,
    repairHint: "Run `paperclipai configure --section database`",
  };
}
