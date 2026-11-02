import { describe, expect, it } from "vitest";
import {
  createSensitiveHeaderEventRedactor,
  createSensitiveHeaderStreamRedactor,
  REDACTED_EVENT_VALUE,
  redactEventPayload,
  redactRunLogTextPreservingBytes,
  redactSensitiveText,
  sanitizeRecord,
} from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("preserves authorization decision reasons in audit payloads", () => {
    expect(redactEventPayload({
      authorizationReason: "allow_scoped_agent_write",
      authorization: "Bearer secret",
      surface: "issue.comment.create",
    })).toEqual({
      authorizationReason: "allow_scoped_agent_write",
      authorization: REDACTED_EVENT_VALUE,
      surface: "issue.comment.create",
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `paperclip {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("paperclip-json-secret");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain("paperclip-shell-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts HTTP credential headers in plain and JSON-escaped tool output", () => {
    const input = [
      "Playwright GET timed out",
      "Cookie: __Host-hp_access=fake-access-001; __Host-hp_refresh=fake-refresh-002; __Host-hp_csrf=fake-csrf-003",
      "Set-Cookie: session=fake-session-004; HttpOnly",
      "Authorization: Basic fake-basic-005",
      String.raw`{\"Cookie\":\"session=fake-json-cookie-006\",\"Set-Cookie\":\"session=fake-json-set-cookie-007\",\"Authorization\":\"Bearer fake-json-auth-008\"}`,
      "Request failed after 30000 ms",
    ].join("\n");

    for (const result of [redactSensitiveText(input), redactRunLogTextPreservingBytes(input)]) {
      expect(result).toContain("Playwright GET timed out");
      expect(result).toContain("Request failed after 30000 ms");
      for (const value of [
        "fake-access-001", "fake-refresh-002", "fake-csrf-003", "fake-session-004",
        "fake-basic-005", "fake-json-cookie-006", "fake-json-set-cookie-007", "fake-json-auth-008",
      ]) {
        expect(result).not.toContain(value);
      }
    }
    expect(Buffer.byteLength(redactRunLogTextPreservingBytes(input))).toBe(Buffer.byteLength(input));
  });

  it("redacts array-valued headers and escaped quotes inside JSON header values", () => {
    const input = [
      String.raw`{\"Cookie\":[\"session=fake-array-cookie\"],\"Set-Cookie\":[\"session=fake-array-set-cookie; HttpOnly\"],\"Authorization\":[\"Bearer fake-array-auth\"]}`,
      String.raw`{\"Cookie\":\"a=\\\"; b=fake-quoted-cookie\"}`,
    ].join("\n");
    for (const result of [redactSensitiveText(input), redactRunLogTextPreservingBytes(input)]) {
      for (const value of ["fake-array-cookie", "fake-array-set-cookie", "fake-array-auth", "fake-quoted-cookie"]) {
        expect(result).not.toContain(value);
      }
    }
    expect(Buffer.byteLength(redactRunLogTextPreservingBytes(input))).toBe(Buffer.byteLength(input));
    expect(JSON.stringify(redactEventPayload({ detail: input }))).not.toContain("fake-array-cookie");
    const legacyRecord = `${JSON.stringify({ stream: "stderr", chunk: String.raw`{\"Set-Cookie\":[\"session=fake-array-legacy\"]}` })}\n`;
    expect(redactRunLogTextPreservingBytes(legacyRecord)).not.toContain("fake-array-legacy");
  });

  it("holds split header names and masks values across arbitrary stream chunks", () => {
    for (const [first, second] of [
      ["Cookie: ", "session=fake-split-cookie\nTimeout after 30000 ms"],
      ["Cook", "ie: session=fake-split-name\nTimeout after 30000 ms"],
      ["Set-Cookie:", " session=fake-split-set-cookie\nTimeout after 30000 ms"],
      ["Authoriz", "ation: Bearer fake-split-auth\nTimeout after 30000 ms"],
      [String.raw`{\"Cookie\":[`, String.raw`\"session=fake-split-array\"]}` + "\nTimeout after 30000 ms"],
    ]) {
      const redactor = createSensitiveHeaderStreamRedactor();
      const result = redactor.write(first!) + redactor.write(second!);
      expect(result).not.toContain("fake-split-");
      expect(result).toContain("Timeout after 30000 ms");
    }
  });

  it("holds a pretty-printed JSON array value across physical lines and chunks", () => {
    for (const header of ["Cookie", "Set-Cookie", "Authorization"]) {
      const value = `fake-pretty-${header.toLowerCase()}`;
      const inputs = [
        `{"${header}": [\n  "${value}]inside",\n  "second-value"\n], "safe": "visible"}\nTimeout after 30000 ms`,
        `{\\"${header}\\": [\n  \\"${value}]inside\\",\n  \\"second-value\\"\n], \\"safe\\": \\"visible\\"}\nTimeout after 30000 ms`,
      ];
      for (const input of inputs) {
        for (const result of [redactSensitiveText(input), redactRunLogTextPreservingBytes(input)]) {
          expect(result).not.toContain(value);
          expect(result).not.toContain("second-value");
          expect(result).toContain("visible");
          expect(result).toContain("Timeout after 30000 ms");
        }
        expect(Buffer.byteLength(redactRunLogTextPreservingBytes(input))).toBe(Buffer.byteLength(input));
        for (let split = 1; split < input.length; split += 1) {
          const redactor = createSensitiveHeaderStreamRedactor();
          const result = redactor.write(input.slice(0, split)) + redactor.write(input.slice(split));
          expect(result, `${header} split ${split}`).not.toContain(value);
          expect(result, `${header} split ${split}`).not.toContain("second-value");
        }
      }
    }
  });

  it("masks a value split across adjacent adapter events before persistence or live delivery", () => {
    for (const header of ["Cookie", "Set-Cookie", "Authorization"]) {
      for (const target of ["message", "payload"] as const) {
        const redactor = createSensitiveHeaderEventRedactor();
        const first = redactor.write({ stream: "stderr", message: `${header}: `, payload: null });
        const second = redactor.write({
          stream: "stderr",
          message: target === "message" ? "session=fake-event-value\nTimeout after 30000 ms" : null,
          payload: target === "payload" ? { detail: "session=fake-event-value\nTimeout after 30000 ms" } : null,
        });
        expect(JSON.stringify([first, second])).not.toContain("fake-event-value");
        const after = redactor.write({ stream: "stderr", message: "safe later event", payload: null });
        expect(after.message).toBe("safe later event");
      }
    }
  });

  it("keeps later array elements masked after a newline in another event", () => {
    const redactor = createSensitiveHeaderEventRedactor();
    const events = [
      { stream: "stderr", message: '{"Cookie": [', payload: null },
      { stream: "stderr", message: null, payload: { detail: '"session=fake-first-value",\n' } },
      { stream: "stderr", message: '"session=fake-second-value"\n]', payload: null },
    ].map((event) => redactor.write(event));
    expect(JSON.stringify(events)).not.toContain("fake-first-value");
    expect(JSON.stringify(events)).not.toContain("fake-second-value");
  });

  it("redacts headers inside ordinary event payload strings", () => {
    const payload = redactEventPayload({
      detail: "Cookie: session=fake-payload-cookie\\nTimeout after 30000 ms",
      nested: { error: "Authorization: Basic fake-payload-auth" },
    });
    expect(JSON.stringify(payload)).not.toContain("fake-payload-cookie");
    expect(JSON.stringify(payload)).not.toContain("fake-payload-auth");
    expect(JSON.stringify(payload)).toContain("Timeout after 30000 ms");
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command: "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: ["--safe", "ok", "--token", "ghp_arg_secret", "--api-key=sk-inline-example"],
      env: {
        PAPERCLIP_RESOLVED_COMMAND: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND:
        `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual(["--api-key", REDACTED_EVENT_VALUE, "safe-next"]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });
});
