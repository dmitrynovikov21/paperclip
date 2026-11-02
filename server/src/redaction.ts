import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

const SECRET_PAYLOAD_KEY_RE = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");
// Authorization reasons are policy decision codes, not credentials. They must
// remain visible in audit receipts even though the field name contains
// "authorization". JWT-shaped values are still caught by the value guard below.
const AUDIT_REASON_PAYLOAD_KEY_RE = /^authorizationReason$/;
const AUDIT_SURFACE_PAYLOAD_KEY_RE = /^surface$/;
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const CLI_SECRET_FLAG_RE = new RegExp(String.raw`^-{1,2}${SECRET_FIELD_NAME_PATTERN}$`, "i");
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))([^"'` + "`" + String.raw`\r\n]+)((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))([^\\\r\n]+)((?:\\"))`,
  "gi",
);
// A header can follow a literal "\\n" inside serialized tool output. In that
// form the character before "Cookie" is the word character "n".
const SENSITIVE_HEADER_PREFIX_RE = /(?:^|\\[rn]|[^A-Za-z0-9_-])(?:Cookie|Set-Cookie|Authorization)\s*:\s*/gi;
const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) || input.includes(".");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isUserSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isUserSecretRefBinding(value: unknown): value is { type: "user_secret_ref"; key: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "user_secret_ref" && typeof value.key === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    if (SECRET_PAYLOAD_KEY_RE.test(key) && !AUDIT_REASON_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isUserSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string" && JWT_VALUE_RE.test(value) && !AUDIT_SURFACE_PAYLOAD_KEY_RE.test(key)) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

export function redactSensitiveText(input: string): string {
  if (!maybeContainsSecretText(input)) return input;
  return redactCommandText(
    redactSensitiveHeaders(input, () => REDACTED_EVENT_VALUE)
      .replace(JSON_SECRET_FIELD_TEXT_RE, (_match, prefix: string, _value: string, suffix: string) =>
        `${prefix}${REDACTED_EVENT_VALUE}${suffix}`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, (_match, prefix: string, _value: string, suffix: string) =>
        `${prefix}${REDACTED_EVENT_VALUE}${suffix}`),
    REDACTED_EVENT_VALUE,
  );
}

function redactSensitiveHeaders(input: string, replacement: (value: string) => string): string {
  let result = "";
  let cursor = 0;
  SENSITIVE_HEADER_PREFIX_RE.lastIndex = 0;
  for (const match of input.matchAll(SENSITIVE_HEADER_PREFIX_RE)) {
    const start = match.index + match[0].length;
    if (start < cursor) continue;
    let end = start;
    while (end < input.length) {
      const char = input[end];
      if (char === "\r" || char === "\n") break;
      if (char === "\\") {
        let next = end + 1;
        while (input[next] === "\\") next += 1;
        if (input[next] === "r" || input[next] === "n") break;
        if (input[next] === '"') {
          end = next + 1;
          continue;
        }
      }
      if (char === '"' && (end + 1 === input.length || /[,}\]\r\n]/.test(input[end + 1]!))) break;
      end += 1;
    }
    result += input.slice(cursor, start) + replacement(input.slice(start, end));
    cursor = end;
  }
  return result + input.slice(cursor);
}

// Run-log reads can start in the middle of a header value. Keep the byte
// length stable so the HTTP offset still addresses the persisted file.
export function redactRunLogTextPreservingBytes(input: string): string {
  if (!maybeContainsSecretText(input)) return input;
  const mask = (value: string) => "*".repeat(Buffer.byteLength(value, "utf8"));
  return redactSensitiveHeaders(input, mask)
    .replace(JSON_SECRET_FIELD_TEXT_RE, (_match, prefix: string, value: string, suffix: string) =>
      `${prefix}${mask(value)}${suffix}`)
    .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, (_match, prefix: string, value: string, suffix: string) =>
      `${prefix}${mask(value)}${suffix}`);
}
