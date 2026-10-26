import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv } from "./server-utils.js";
import { projectAcpxInheritedHostEnvironment } from "./acpx-engine/execute.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("does not pass source signing keys to local or ACPX agent processes", () => {
    const inherited = {
      PATH: "/usr/bin",
      PAPERCLIP_AGENT_JWT_SECRET: "synthetic-jwt",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "synthetic-actions",
    };
    expect(sanitizeInheritedPaperclipEnv(inherited)).toEqual({ PATH: "/usr/bin" });
    expect(projectAcpxInheritedHostEnvironment(inherited, "codex", true)).toEqual({ PATH: "/usr/bin" });
    expect(projectAcpxInheritedHostEnvironment(inherited, "codex", false)).toEqual({});
  });
});
