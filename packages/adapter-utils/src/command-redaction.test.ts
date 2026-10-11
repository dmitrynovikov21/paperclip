import { describe, expect, it } from "vitest";

describe("explicit diagnostic credential forms", () => {
  it("masks suffixed CLI options and encoded JSON headers with whitespace", () => {
    const jwt = `${Buffer.from(' {"alg":"HS256","typ":"JWT"}').toString("base64url")}.abcdefghijk.abcdefghijkl`;
    expect(redactCommandText("tool --api-key-prod sensitivevalue --token-policy readable"))
      .not.toContain("sensitivevalue");
    expect(redactCommandText(`provider ${jwt}`)).not.toContain(jwt);
    expect(redactCommandText("plan.security.credentials.md")).toBe("plan.security.credentials.md");
  });
});
import {
  REDACTED_COMMAND_TEXT_VALUE,
  looksLikeCredentialJwt,
  createPostgresUrlStreamRedactor,
  redactDiagnosticText,
  redactCommandText,
  redactPostgresUrlUserinfo,
} from "./command-redaction.js";

describe("looksLikeCredentialJwt", () => {
  it("recognizes encoded headers even with short payloads and signatures", () => {
    const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
    expect(looksLikeCredentialJwt(`${header}.e30.c2ln`)).toBe(true);
  });

  it("recognizes direct-encryption JWTs with an empty encrypted-key segment", () => {
    const header = Buffer.from('{"alg":"dir","enc":"A256GCM"}').toString("base64url");
    expect(looksLikeCredentialJwt(`${header}..abcdefghijk.abcdefghijkl.abcdefghijk`)).toBe(true);
  });

  it.each([
    "eyJ..signature",
    "eyJ.key..ciphertext.tag",
    "eyJ.key.iv..tag",
    "eyJ.key.iv.ciphertext.",
  ])("rejects empty segments outside the JWE encrypted key: %s", (input) => {
    expect(looksLikeCredentialJwt(input)).toBe(false);
  });

  it.each([
    "api.openai.com",
    "agents.staging.example.com",
    "deployment.credentials.example.md",
    "paperclip.native-model-envelope.v3",
  ])("rejects public dotted identifiers: %s", (input) => {
    expect(looksLikeCredentialJwt(input)).toBe(false);
  });
});

describe("PostgreSQL URL credentials", () => {
  it("hides userinfo in free text and --dbname while keeping the host and database", () => {
    const input = "psql --dbname=postgresql://etl_user:p%40ss%3Aword@db.example.test/app -c SELECT";
    const result = redactCommandText(input);
    expect(result).toContain("--dbname=postgresql://***REDACTED***@db.example.test/app");
    expect(result).toContain("-c SELECT");
    expect(result).not.toContain("etl_user");
    expect(result).not.toContain("p%40ss%3Aword");
    expect(redactCommandText("postgres://u:s@db"))
      .toBe("postgres://***REDACTED***@db");
    expect(redactCommandText("postgres://worker:pa'ss@db/app"))
      .toBe("postgres://***REDACTED***@db/app");
    expect(redactCommandText("postgres://worker:synthetic@db/app?sslpassword=synthetic-query-secret"))
      .toBe("postgres://***REDACTED***@db/app?***REDACTED***");
    expect(redactPostgresUrlUserinfo("postgres://localhost/app")).toBe("postgres://localhost/app");
  });

  it("hides a PostgreSQL query split between log chunks", () => {
    const redactor = createPostgresUrlStreamRedactor();
    const output = [
      redactor.chunk("stdout", "postgres://worker:synthetic@db.example.test/app?sslpassword=synthetic-"),
      redactor.chunk("stdout", "query-secret&application_name=worker done\n"),
      redactor.finish("stdout"),
    ].join("");
    expect(output).toBe("postgres://***REDACTED***@db.example.test/app?***REDACTED*** done\n");
    expect(output).not.toContain("synthetic-query-secret");
  });

  it("holds a split scheme and userinfo until the final @ on each stream", () => {
    const redactor = createPostgresUrlStreamRedactor();
    const stdout = [
      redactor.chunk("stdout", "ps --dbname=post"),
      redactor.chunk("stdout", "gresql://etl_user:p%40"),
      redactor.chunk("stdout", "ss%3Aword@db.example.test/app done\n"),
      redactor.finish("stdout"),
    ].join("");
    const stderr = redactor.chunk("stderr", "stderr is separate\n") + redactor.finish("stderr");
    expect(stdout).toContain("postgresql://***REDACTED***@db.example.test/app done");
    expect(stderr).toBe("stderr is separate\n");
    expect(stdout).not.toContain("etl_user");
    expect(stdout).not.toContain("p%40ss%3Aword");
    expect(redactor.chunk("stdout", "connect postgres://db.example.test/app ready\n"))
      .toBe("connect postgres://db.example.test/app ready\n");
    expect(redactor.chunk("stdout", "connect postgres://db.example.test ready\n"))
      .toBe("connect postgres://db.example.test ready\n");
    expect(redactor.chunk("stdout", "postgres://db.example.test/app"))
      .toBe("postgres://");
    expect(redactor.finish("stdout")).toBe("db.example.test/app");
    expect(redactor.chunk("stdout", "postgres://worker:pa'"))
      .toBe("postgres://");
    expect(redactor.chunk("stdout", "ss@db/app\n"))
      .toBe("***REDACTED***@db/app\n");
    expect(redactor.chunk("stdout", "postgres://interrupted:secret")).toBe("postgres://");
    expect(redactor.finish("stdout")).toBe(REDACTED_COMMAND_TEXT_VALUE);

    const oversized = createPostgresUrlStreamRedactor();
    expect(oversized.chunk("stdout", `postgres://user:${"x".repeat(9000)}`))
      .toBe("postgres://");
    expect(oversized.chunk("stdout", "@db/app\n"))
      .toBe("***REDACTED***@db/app\n");
  });
});

describe("redactDiagnosticText", () => {
  it("preserves credential metadata and dotted identifiers", () => {
    for (const text of [
      '"tokenBudget":4000 --token-budget 4000 SECRET_STORAGE=vault',
      '{"credentialHandling":"harness","authorizationRequired":true}',
      "executor.customTools.integrations.list deployment.credentials.example.md api.openai.com",
      "Use a private key and secret manager with credential handling.",
      "Use bearer tokens and bearer authentication.",
    ]) expect(redactDiagnosticText(text)).toBe(text);
  });

  it("redacts a JSON secret field value", () => {
    const input = '{"token":"opaque-value","status":"error"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
    // The non-secret field keeps its value.
    expect(output).toContain('"status":"error"');
  });

  it("redacts an api_key JSON field with whitespace around the colon", () => {
    const input = '{ "api_key" : "sk-secret-123" }';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("sk-secret-123");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret field value", () => {
    // A diagnostic can carry a JSON string, so the double quotes appear as `\"`.
    const input = '{\\"token\\":\\"opaque-value\\"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(
      `\\"token\\":\\"${REDACTED_COMMAND_TEXT_VALUE}\\"`,
    );
  });

  it("still redacts a shell KEY=value secret", () => {
    const input = "ANTHROPIC_API_KEY=super-secret-value claude --print";
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("super-secret-value");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped quoted assignment across a literal newline", () => {
    const input = String.raw`authorization=\"Bearer first-line
second-line\" status=401`;
    const expected = String.raw`authorization=\"***REDACTED***\" status=401`;
    const output = redactDiagnosticText(input);
    expect(output).toBe(expected);
    expect(redactDiagnosticText(output)).toBe(expected);
  });

  it("keeps non-secret text and non-secret JSON fields intact", () => {
    const input = '{"status":"ok","message":"probe finished"}';
    expect(redactDiagnosticText(input)).toBe(input);
  });

  it("redacts the secret but keeps a non-secret marker in the same string", () => {
    const input = 'DIAGMARKER1234 said {"authorization":"Bearer opaque"}';
    const output = redactDiagnosticText(input);
    expect(output).toContain("DIAGMARKER1234");
    expect(output).not.toContain("opaque");
  });

  it("redacts a JSON secret value that contains an escaped quote", () => {
    // The value holds an escaped quote, so a naive matcher stops at the `\"` and
    // leaves the rest of the credential. The marker sits after the escaped quote.
    const input = '{"token":"pre\\"MARKERQUOTE_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_A");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts a JSON secret value that contains an escaped backslash", () => {
    const input = '{"secret":"pre\\\\MARKERBACKSLASH_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_A");
    expect(output).toContain(`"secret":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts an escaped-JSON secret value that contains an escaped quote", () => {
    // A diagnostic can carry a serialized JSON string, so the whole JSON is
    // escaped a second time. The inner value still holds an escaped quote.
    const innerJson = '{"token":"pre\\"MARKERQUOTE_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret value that contains an escaped backslash", () => {
    const innerJson = '{"password":"pre\\\\MARKERBACKSLASH_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });
});
