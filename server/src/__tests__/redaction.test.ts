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

  it("keeps the outer JSON array active when an inner element looks like a header", () => {
    const first = '{"Cookie": ["' + "x".repeat(160) + ' Authorization: Bearer synthetic-inner-001';
    const second = '\",\n"session=synthetic-later-002"]}\nTimeout after 30000 ms';
    const redactor = createSensitiveHeaderStreamRedactor();
    const result = redactor.write(first) + redactor.write(second);
    expect(result).not.toContain("synthetic-inner-001");
    expect(result).not.toContain("synthetic-later-002");
    expect(result).toContain("Timeout after 30000 ms");
    expect(redactSensitiveText(first + second)).not.toContain("synthetic-later-002");
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

  it("masks every header-name split across message and payload events, then releases safe events", () => {
    for (const header of ["Cookie", "Set-Cookie", "Authorization"]) {
      for (let split = 1; split < header.length; split += 1) {
        for (const target of ["message", "payload"] as const) {
          const redactor = createSensitiveHeaderEventRedactor();
          const first = redactor.write({ stream: "stderr", message: header.slice(0, split), payload: null });
          const fragment = `${header.slice(split)}: session=synthetic-event-${split}\n`;
          const second = redactor.write({
            stream: "stderr",
            message: target === "message" ? fragment : null,
            payload: target === "payload" ? { detail: fragment } : null,
          });
          expect(JSON.stringify([first, second]), `${header} split ${split} ${target}`)
            .not.toContain(`synthetic-event-${split}`);
          expect(redactor.write({ stream: "stderr", message: "Timeout after 30000 ms", payload: null }).message)
            .toBe("Timeout after 30000 ms");
        }
      }
    }
  });

  it("keeps split header state when another event stream arrives between fragments", () => {
    for (const [source, other] of [["stderr", "stdout"], ["stdout", "stderr"], ["stderr", "system"]] as const) {
      for (const [header, split] of [["Cookie", 3], ["Set-Cookie", 6], ["Authorization", 7]] as const) {
        for (const target of ["message", "payload"] as const) {
          const redactor = createSensitiveHeaderEventRedactor();
          const first = redactor.write({ stream: source, message: header.slice(0, split), payload: null });
          const middle = redactor.write({ stream: other, message: "status: worker alive", payload: null });
          const fragment = `${header.slice(split)}: session=synthetic-cross-stream-001\n`;
          const last = redactor.write({
            stream: source,
            message: target === "message" ? fragment : null,
            payload: target === "payload" ? { detail: fragment } : null,
          });
          expect(JSON.stringify([first, middle, last])).not.toContain("synthetic-cross-stream-001");
          expect(middle.message).toBe("status: worker alive");
          expect(redactor.write({ stream: source, message: "Timeout after 30000 ms", payload: null }).message)
            .toBe("Timeout after 30000 ms");
        }
      }
    }
  });

  it("checks every payload text field against a split header regardless of metadata order", () => {
    for (const header of ["Cookie", "Set-Cookie", "Authorization"]) {
      for (const stream of ["stderr", "stdout", "system", null, "unknown"]) {
        const redactor = createSensitiveHeaderEventRedactor();
        redactor.write({ stream, message: header.slice(0, 3), payload: null });
        const value = `synthetic-${header.toLowerCase()}-${stream}`;
        const result = redactor.write({
          stream,
          message: null,
          payload: { toolName: "playwright", detail: `${header.slice(3)}: session=${value}\nRequest failed after 30000 ms` },
        });
        expect(JSON.stringify(result), `${header} ${stream}`).not.toContain(value);
        expect(result.payload?.toolName).toBe("playwright");
        expect(result.payload?.detail).toContain("Request failed after 30000 ms");
        expect(redactor.write({ stream, message: "safe after closed header", payload: null }).message)
          .toBe("safe after closed header");
      }
    }
  });

  it("keeps a split header across a separate metadata event", () => {
    for (const [header, split] of [["Cookie", 3], ["Set-Cookie", 6], ["Authorization", 7]] as const) {
      for (const stream of ["stderr", "stdout", "system", null, "unknown"]) {
        for (const metadataInFirstEvent of [false, true]) {
          const redactor = createSensitiveHeaderEventRedactor();
          const first = redactor.write({
            stream,
            message: header.slice(0, split),
            payload: metadataInFirstEvent ? { toolName: "playwright" } : null,
          });
          const otherStream = stream === "stdout" ? "stderr" : "stdout";
          const unrelated = redactor.write({ stream: otherStream, message: "status: worker alive" });
          const metadata = metadataInFirstEvent
            ? null
            : redactor.write({ stream, payload: { toolName: "playwright" } });
          const value = `synthetic-metadata-event-${header}-${stream}-${metadataInFirstEvent}`;
          const last = redactor.write({
            stream,
            payload: { detail: `${header.slice(split)}: session=${value}\nRequest failed after 30000 ms` },
          });
          const sanitized = redactEventPayload(last.payload);
          expect(JSON.stringify([first, unrelated, metadata, last, sanitized]), `${header} ${stream} ${metadataInFirstEvent}`)
            .not.toContain(value);
          expect(last.payload?.detail).toContain("Request failed after 30000 ms");
          expect(redactor.write({ stream, message: "safe after closed header" }).message)
            .toBe("safe after closed header");
        }
      }
    }
  });

  it("keeps a split header across an unrelated message in the same stream", () => {
    for (const [header, split] of [["Cookie", 3], ["Set-Cookie", 6], ["Authorization", 7]] as const) {
      for (const stream of ["stderr", "stdout", "system", null, "unknown"]) {
        const redactor = createSensitiveHeaderEventRedactor();
        redactor.write({ stream, message: header.slice(0, split) });
        const middle = redactor.write({ stream, message: "status: worker alive", payload: { toolName: "playwright" } });
        const value = `synthetic-same-stream-${header}-${stream}`;
        const last = redactor.write({
          stream,
          payload: { detail: `${header.slice(split)}: session=${value}\nRequest failed after 30000 ms` },
        });
        expect(JSON.stringify([last, redactEventPayload(last.payload)]), `${header} ${stream}`).not.toContain(value);
        expect(middle.message).toBe("status: worker alive");
        expect(last.payload?.detail).toContain("Request failed after 30000 ms");
        expect(redactor.write({ stream, message: "safe after closed header" }).message)
          .toBe("safe after closed header");
      }
    }
  });

  it("keeps an unfinished header across a complete independent status line", () => {
    for (const header of ["Cookie", "Set-Cookie", "Authorization"]) {
      for (const stream of ["stderr", "stdout", "system", null, "unknown"]) {
        const redactor = createSensitiveHeaderEventRedactor();
        redactor.write({ stream, message: `${header}: ` });
        redactor.write({ stream, payload: { toolName: "playwright" } });
        const status = redactor.write({ stream, message: "status: worker alive\n" });
        const value = `synthetic-interrupted-${header}-${stream}`;
        const last = redactor.write({
          stream,
          payload: { detail: `${header === "Authorization" ? "Bearer " : "session="}${value}\nRequest failed after 30000 ms` },
        });
        expect(status.message, `${header} ${stream}`).toBe("status: worker alive\n");
        expect(JSON.stringify([last, redactEventPayload(last.payload)]), `${header} ${stream}`).not.toContain(value);
        expect(last.payload?.detail).toContain("Request failed after 30000 ms");
        expect(redactor.write({ stream, message: "safe after interrupted header" }).message)
          .toBe("safe after interrupted header");
      }
    }
  });

  it("keeps a started credential value across independent same-stream events", () => {
    for (const header of ["Cookie", "Set-Cookie", "Authorization"]) {
      for (const stream of ["stderr", "stdout", "system"] as const) {
        for (const independent of ["worker alive\n", "status=worker-alive\n", "READY\n"]) {
          for (const detailFirst of [false, true]) {
            const redactor = createSensitiveHeaderEventRedactor();
            const value = `synthetic-tail-${header}-${stream}-${detailFirst}`;
            const prefix = header === "Authorization" ? "Bearer " : "session=";
            redactor.write({ eventType: "tool.output", stream, message: `${header}: ${prefix}` });
            redactor.write({ eventType: "tool.output", stream, payload: { toolName: "playwright" } });
            const middle = redactor.write({ eventType: "tool.output", stream, message: independent });
            const detail = `${value}\nRequest failed after 30000 ms`;
            const payload = detailFirst ? { detail, toolName: "playwright" } : { toolName: "playwright", detail };
            const last = redactor.write({ eventType: "tool.output", stream, payload });
            expect(JSON.stringify([middle, last]), `${header} ${stream} ${independent} ${detailFirst}`).not.toContain(value);
            expect(last.payload?.detail).toContain("Request failed after 30000 ms");
            if (independent === "worker alive\n") expect(middle.message).toBe(independent);
            expect(redactor.write({ eventType: "tool.output", stream, message: "safe diagnostic after value" }).message)
              .toBe("safe diagnostic after value");
          }
        }
      }
    }
  });

  it("retains split JSON credential values after an independent event closes a candidate", () => {
    for (const header of ["Cookie", "Set-Cookie", "Authorization"]) {
      for (const stream of ["stderr", "stdout", "system"] as const) {
        for (const jsonArray of [false, true]) {
          for (const detailFirst of [false, true]) {
            const redactor = createSensitiveHeaderEventRedactor();
            const value = `synthetic-json-tail-${header}-${stream}-${jsonArray}-${detailFirst}`;
            const prefix = header === "Authorization" ? "Bearer " : "session=";
            const opening = jsonArray ? `{"${header}":["${prefix}` : `{"${header}":"${prefix}`;
            const independent = jsonArray ? 'worker "] alive\n' : 'worker "alive"\n';
            const closing = jsonArray ? '"]}' : '"}';
            redactor.write({ stream, message: opening });
            redactor.write({ stream, payload: { toolName: "playwright" } });
            redactor.write({ stream, message: independent });
            const detail = `${value}${closing}\nRequest failed after 30000 ms`;
            const payload = detailFirst ? { detail, toolName: "playwright" } : { toolName: "playwright", detail };
            const last = redactor.write({ stream, payload });
            expect(JSON.stringify([last, redactEventPayload(last.payload)]), `${header} ${stream} ${jsonArray} ${detailFirst}`)
              .not.toContain(value);
            expect(last.payload?.detail).toContain("Request failed after 30000 ms");
            const otherStream = stream === "stdout" ? "stderr" : "stdout";
            expect(redactor.write({ stream: otherStream, message: "other stream visible" }).message)
              .toBe("other stream visible");
          }
        }
      }
    }
  });

  it("does not retire an unfinished header after an ambiguous cookie-shaped field", () => {
    for (const header of ["Cookie", "Set-Cookie", "Authorization"]) {
      const redactor = createSensitiveHeaderEventRedactor();
      redactor.write({ stream: "stderr", message: `${header}: ` });
      const ambiguous = redactor.write({ stream: "stderr", message: "status=worker-alive\n" });
      const credential = redactor.write({ stream: "stderr", payload: { detail: "session=synthetic-later-credential\n" } });
      expect(JSON.stringify(ambiguous)).not.toContain("worker-alive");
      expect(JSON.stringify(credential), header).not.toContain("synthetic-later-credential");
      expect(redactor.write({ stream: "stderr", message: "safe after closed header" }).message)
        .toBe("safe after closed header");
    }
  });

  it("still masks credential-shaped tool metadata after an unfinished header", () => {
    for (const header of ["Cookie", "Set-Cookie", "Authorization"]) {
      const redactor = createSensitiveHeaderEventRedactor();
      redactor.write({ stream: "stderr", message: `${header}: ` });
      const result = redactor.write({ stream: "stderr", payload: { toolName: "session=synthetic-toolname-credential\n" } });
      expect(JSON.stringify(result), header).not.toContain("synthetic-toolname-credential");
      expect(redactor.write({ stream: "stderr", message: "safe after tool metadata" }).message)
        .toBe("safe after tool metadata");
    }
  });

  it("scans a new complete header while an older header remains unfinished", () => {
    const redactor = createSensitiveHeaderEventRedactor();
    redactor.write({ stream: "stderr", message: "Cookie: " });
    redactor.write({ stream: "stderr", message: "status: worker alive\n" });
    const secondHeader = redactor.write({
      stream: "stderr",
      payload: { detail: "Authorization: Bearer synthetic-second-header\n" },
    });
    const firstValue = redactor.write({ stream: "stderr", payload: { detail: "session=synthetic-first-header\n" } });
    expect(JSON.stringify(secondHeader)).not.toContain("synthetic-second-header");
    expect(JSON.stringify(firstValue)).not.toContain("synthetic-first-header");
    expect(redactor.write({ stream: "stderr", message: "safe diagnostic after both headers" }).message)
      .toBe("safe diagnostic after both headers");
  });

  it("keeps short diagnostics visible after a cookie value while masking later cookie pairs", () => {
    for (const header of ["Cookie", "Set-Cookie"]) {
      const redactor = createSensitiveHeaderEventRedactor();
      redactor.write({ stream: "stderr", message: `${header}: ` });
      const first = redactor.write({ stream: "stderr", payload: { detail: "session=synthetic-first-cookie\n" } });
      expect(JSON.stringify(first)).not.toContain("synthetic-first-cookie");
      expect(redactor.write({ stream: "stderr", message: "READY" }).message).toBe("READY");
      expect(redactor.write({ stream: "stderr", message: "Timeout after 30000 ms" }).message)
        .toBe("Timeout after 30000 ms");
      const later = redactor.write({ stream: "stderr", payload: { detail: "other=synthetic-later-cookie\n" } });
      expect(JSON.stringify(later)).not.toContain("synthetic-later-cookie");
    }
  });

  it("masks a header split between payload fields with metadata in between", () => {
    const redactor = createSensitiveHeaderEventRedactor();
    const result = redactor.write({
      stream: "stderr",
      message: null,
      payload: {
        first: "Coo",
        toolName: "playwright",
        detail: "kie: session=synthetic-payload-fields\nTimeout after 30000 ms",
      },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-payload-fields");
    expect(result.payload?.detail).toContain("Timeout after 30000 ms");
  });

  it("masks a header that begins in a tool name and continues in output", () => {
    for (const adjacent of [true, false]) {
      const redactor = createSensitiveHeaderEventRedactor();
      const first = redactor.write({
        stream: "stderr",
        payload: { toolName: "Coo", detail: adjacent ? "kie: session=synthetic-toolname-adjacent\n" : "safe output" },
      });
      if (adjacent) {
        expect(JSON.stringify(first)).not.toContain("synthetic-toolname-adjacent");
      } else {
        const second = redactor.write({ stream: "stderr", payload: { detail: "kie: session=synthetic-toolname-later\n" } });
        expect(JSON.stringify(second)).not.toContain("synthetic-toolname-later");
      }
    }
  });

  it("preserves safe event text after an unconfirmed header prefix", () => {
    const redactor = createSensitiveHeaderEventRedactor();
    expect(redactor.write({ message: "Cook" }).message).toBe("Cook");
    expect(redactor.write({ message: "Timeout after 30000 ms" }).message).toBe("Timeout after 30000 ms");
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
