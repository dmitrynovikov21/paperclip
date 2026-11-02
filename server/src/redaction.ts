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
const SENSITIVE_HEADER_PREFIX_RE = /(?:Cookie|Set-Cookie|Authorization)(?:\\*["'])?\s*:\s*/gi;
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
  for (const range of sensitiveHeaderRanges(input)) {
    const start = range.valueStart;
    if (start < cursor) continue;
    const end = range.end;
    result += input.slice(cursor, start) + replacement(input.slice(start, end));
    cursor = end;
  }
  return result + input.slice(cursor);
}

type HeaderValueState =
  | { kind: "line"; headerName: "cookie" | "set-cookie" | "authorization"; jsonField: boolean; awaitingValue: boolean; quoteSlashes: number }
  | { kind: "quoted"; quote: string | null; quoteSlashes: number; slashRun: number }
  | { kind: "container"; brackets: string[]; quote: string | null; slashRun: number; quoteSlashes: number };

type HeaderRange = { start: number; valueStart: number; end: number; continuation: HeaderValueState | null };

function scanHeaderValue(input: string, start: number, state: HeaderValueState): {
  end: number;
  delimiterLength: number;
  continuation: HeaderValueState | null;
} {
  if (state.kind === "line" && state.jsonField) {
    if (state.awaitingValue) {
      while (start < input.length && /\s/.test(input[start]!)) start += 1;
      if (start === input.length) return { end: input.length, delimiterLength: 0, continuation: state };
    }
    if (input[start] === "[" || input[start] === "{") {
      state = { kind: "container", brackets: [], quote: null, slashRun: 0, quoteSlashes: state.quoteSlashes };
    } else if (input[start] === '"' || input[start] === "'" || input[start] === "\\") {
      state = { kind: "quoted", quote: null, slashRun: 0, quoteSlashes: state.quoteSlashes };
    }
  }
  if (state.kind === "quoted") {
    for (let index = start; index < input.length; index += 1) {
      const char = input[index]!;
      if (char === "\\") {
        state.slashRun += 1;
        continue;
      }
      if ((char === '"' || char === "'") && state.slashRun === state.quoteSlashes) {
        if (state.quote === char) return { end: index + 1, delimiterLength: 0, continuation: null };
        if (state.quote === null) state.quote = char;
      }
      state.slashRun = 0;
    }
    return { end: input.length, delimiterLength: 0, continuation: state };
  }
  if (state.kind === "container") {
    for (let index = start; index < input.length; index += 1) {
      const char = input[index]!;
      if (char === "\\") {
        state.slashRun += 1;
        continue;
      }
      if ((char === '"' || char === "'") && state.slashRun === state.quoteSlashes) {
        state.quote = state.quote === null ? char : state.quote === char ? null : state.quote;
      } else if (state.quote === null) {
        if (char === "[" || char === "{") state.brackets.push(char);
        else if (char === "]" || char === "}") {
          const opener = state.brackets.at(-1);
          if ((char === "]" && opener === "[") || (char === "}" && opener === "{")) {
            state.brackets.pop();
            if (state.brackets.length === 0) return { end: index + 1, delimiterLength: 0, continuation: null };
          }
        }
      }
      state.slashRun = 0;
    }
    return { end: input.length, delimiterLength: 0, continuation: state };
  }
  for (let index = start; index < input.length; index += 1) {
    const char = input[index]!;
    if (char === "\r" || char === "\n") return { end: index, delimiterLength: 1, continuation: null };
    if (!state.jsonField && char === "\\" && /[rn]/.test(input[index + 1] ?? "")) {
      return { end: index, delimiterLength: 2, continuation: null };
    }
  }
  return { end: input.length, delimiterLength: 0, continuation: { ...state, awaitingValue: state.awaitingValue && start === input.length } };
}

function scanSensitiveHeaderRanges(input: string): HeaderRange[] {
  const ranges: HeaderRange[] = [];
  let coveredUntil = 0;
  SENSITIVE_HEADER_PREFIX_RE.lastIndex = 0;
  for (const match of input.matchAll(SENSITIVE_HEADER_PREFIX_RE)) {
    // A header-like string inside a Cookie JSON value belongs to the outer
    // value. Letting it become a second range replaces the outer stream state
    // and can expose later array elements after a chunk boundary.
    if (match.index < coveredUntil) continue;
    const valueStart = match.index + match[0].length;
    const jsonField = /\\*["']\s*:\s*$/.test(match[0]);
    const quoteSlashes = jsonField ? (/(\\+)["']\s*:\s*$/.exec(match[0])?.[1]?.length ?? 0) : 0;
    const headerName = /^(?:Set-Cookie|Cookie|Authorization)/i.exec(match[0])![0].toLowerCase() as
      "cookie" | "set-cookie" | "authorization";
    const state: HeaderValueState = { kind: "line", headerName, jsonField, awaitingValue: valueStart === input.length, quoteSlashes };
    const scanned = scanHeaderValue(input, valueStart, state);
    ranges.push({ start: match.index, valueStart, end: scanned.end, continuation: scanned.continuation });
    coveredUntil = scanned.end;
  }
  return ranges;
}

export function sensitiveHeaderRanges(input: string): Array<{ start: number; valueStart: number; end: number }> {
  return scanSensitiveHeaderRanges(input).map(({ start, valueStart, end }) => ({ start, valueStart, end }));
}

type HeaderStreamState = { tail: string; active: HeaderValueState | null };
type HeaderStreamRedactor = {
  write(chunk: string): string;
  acceptsContinuation(chunk: string, completesHeaderName: boolean, fieldKey?: string): boolean;
  completesHeaderName(chunk: string): boolean;
  isAwaitingHeaderValue(): boolean;
  hasActiveValue(): boolean;
  fork(): HeaderStreamRedactor;
  stateKey(): string;
};
const SENSITIVE_HEADER_NAMES = ["Cookie", "Set-Cookie", "Authorization"] as const;

function pendingHeaderTail(input: string): string {
  let tail = "";
  for (const name of SENSITIVE_HEADER_NAMES) {
    for (let length = 1; length < name.length; length += 1) {
      const suffix = input.slice(-length);
      if (suffix.toLowerCase() === name.slice(0, length).toLowerCase() && length > tail.length) tail = suffix;
    }
    const fullName = new RegExp(`${name}(?:\\\\*["']?)?\\s*$`, "i").exec(input)?.[0] ?? "";
    if (fullName.length > tail.length) tail = fullName;
  }
  return tail;
}

function cloneHeaderValueState(state: HeaderValueState | null): HeaderValueState | null {
  if (!state) return null;
  return state.kind === "container" ? { ...state, brackets: [...state.brackets] } : { ...state };
}

/** Remembers prior output so a header name and value can cross chunk boundaries. */
function makeSensitiveHeaderStreamRedactor(initial: HeaderStreamState): HeaderStreamRedactor {
  let tail = initial.tail;
  let active = cloneHeaderValueState(initial.active);
  return {
    isAwaitingHeaderValue: () => active?.kind === "line" && active.awaitingValue,
    hasActiveValue: () => active !== null,
    completesHeaderName(chunk: string): boolean {
      return tail.length > 0 && scanSensitiveHeaderRanges(tail + chunk)
        .some((range) => range.start < tail.length && range.valueStart > tail.length);
    },
    acceptsContinuation(chunk: string, completesHeaderName: boolean, fieldKey?: string): boolean {
      if (completesHeaderName || !active || active.kind !== "line" || active.jsonField) return true;
      const firstLine = chunk.split(/\r?\n|\\[rn]/, 1)[0]!.trimStart();
      const plausibleValue = firstLine.includes("=")
        || /^[A-Za-z][\w+.-]*[ \t]+[A-Za-z0-9._~+/-]+={0,2}$/.test(firstLine);
      // Tool identity normally carries only metadata. Do not consume a
      // waiting value with its name, but still redact credential-shaped text.
      if (fieldKey === "toolName" && active.awaitingValue && !plausibleValue) return false;
      // A standalone diagnostic line is not the continuation of an unfinished
      // credential header. Another branch may still complete a split header
      // name with this field, so that case takes precedence above.
      if (/^[A-Za-z][\w.-]*:\s/.test(firstLine)) return false;
      if (SENSITIVE_HEADER_NAMES.some((name) => name.toLowerCase().startsWith(firstLine.toLowerCase()))) return false;
      if (active.awaitingValue) {
        // Keep the unresolved branch after a plausible cookie pair or auth
        // value as well: a later field may still be the real continuation.
        return plausibleValue || (active.headerName === "authorization" && !/\s/.test(firstLine));
      }
      return true;
    },
    write(chunk: string): string {
      const output = chunk.split("");
      const mask = (start: number, end: number) => {
        for (let index = start; index < end; index += 1) output[index] = "*";
      };
      let cursor = 0;
      if (active) {
        const scanned = scanHeaderValue(chunk, 0, active);
        mask(0, scanned.end);
        if (scanned.continuation) {
          active = scanned.continuation;
          tail = "";
          return output.join("");
        }
        cursor = scanned.end + scanned.delimiterLength;
        active = null;
        tail = "";
      }
      const combined = tail + chunk.slice(cursor);
      for (const range of scanSensitiveHeaderRanges(combined)) {
        const start = Math.max(0, range.valueStart - tail.length) + cursor;
        const end = Math.min(chunk.length, range.end - tail.length + cursor);
        if (end > start) mask(start, end);
        if (range.continuation) active = range.continuation;
      }
      tail = active ? "" : pendingHeaderTail(tail + chunk.slice(cursor));
      return output.join("");
    },
    fork: () => makeSensitiveHeaderStreamRedactor({ tail, active }),
    stateKey: () => JSON.stringify({ tail, active }),
  };
}

export function createSensitiveHeaderStreamRedactor(): HeaderStreamRedactor {
  return makeSensitiveHeaderStreamRedactor({ tail: "", active: null });
}

function redactEventStrings(value: unknown, redact: (text: string, fieldKey?: string) => string, fieldKey?: string): unknown {
  if (typeof value === "string") return redact(value, fieldKey);
  if (Array.isArray(value)) return value.map((item) => redactEventStrings(item, redact, fieldKey));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactEventStrings(item, redact, key)]));
  }
  return value;
}

/** Redact values even when adjacent adapter events carry one split header. */
export function createSensitiveHeaderEventRedactor() {
  const headerRedactors: Record<"system" | "stdout" | "stderr", HeaderStreamRedactor[]> = {
    system: [createSensitiveHeaderStreamRedactor()],
    stdout: [createSensitiveHeaderStreamRedactor()],
    stderr: [createSensitiveHeaderStreamRedactor()],
  };
  const maxStates = 64;
  const failedClosed = new Set<"system" | "stdout" | "stderr">();

  function redactAgainstStates(text: string, states: HeaderStreamRedactor[], fieldKey?: string): { text: string; candidates: string[] } {
    const output = text.split("");
    const candidates: string[] = [];
    const completesHeaderName = states.some((state) => state.completesHeaderName(text));
    for (const state of states) {
      const candidate = state.acceptsContinuation(text, completesHeaderName, fieldKey) ? state.write(text) : text;
      candidates.push(candidate);
      for (let index = 0; index < output.length; index += 1) {
        if (candidate[index] !== text[index]) output[index] = "*";
      }
    }
    return { text: output.join(""), candidates };
  }

  function uniqueStates(states: HeaderStreamRedactor[]): HeaderStreamRedactor[] {
    return [...new Map(states.map((state) => [state.stateKey(), state])).values()];
  }

  return {
    write<T extends { stream?: string | null; message?: string | null; payload?: Record<string, unknown> | null }>(event: T): T {
      const stream = event.stream === "stdout" || event.stream === "stderr" ? event.stream : "system";
      if (failedClosed.has(stream)) {
        return {
          ...event,
          message: typeof event.message === "string" ? REDACTED_EVENT_VALUE : event.message,
          payload: event.payload
            ? redactEventStrings(event.payload, () => REDACTED_EVENT_VALUE) as Record<string, unknown>
            : event.payload,
        };
      }
      // Message and payload properties can be independent text carriers.
      // Keep possible continuations across unrelated metadata and events.
      const states = headerRedactors[stream];
      let overflow = false;
      let candidateStates: HeaderStreamRedactor[] = [];
      const resolvedStateKeys = new Set<string>();
      const redactField = (text: string, fieldKey?: string): string => {
        if (overflow) return REDACTED_EVENT_VALUE;
        const priorStates = uniqueStates([...states, ...candidateStates]);
        const branches = priorStates.map((state) => state.fork());
        const result = redactAgainstStates(text, branches, fieldKey);
        const fresh = createSensitiveHeaderStreamRedactor();
        const freshText = fresh.write(text);
        const output = result.text.split("");
        for (let index = 0; index < output.length; index += 1) {
          if (freshText[index] !== text[index]) output[index] = "*";
        }
        for (let index = 0; index < priorStates.length; index += 1) {
          // Retire completed continuations and resolved name prefixes, while
          // keeping a header that still awaits an unambiguous value.
          if (branches[index]!.stateKey() === fresh.stateKey() && !priorStates[index]!.isAwaitingHeaderValue()
            && (priorStates[index]!.hasActiveValue() || result.candidates[index] !== freshText)) {
            resolvedStateKeys.add(priorStates[index]!.stateKey());
          }
        }
        candidateStates = uniqueStates([
          ...candidateStates.filter((state) => !resolvedStateKeys.has(state.stateKey())),
          ...branches,
          fresh,
        ]);
        if (candidateStates.length > maxStates) overflow = true;
        return output.join("");
      };
      const message = typeof event.message === "string" ? redactField(event.message, "message") : event.message;
      const payload = event.payload
        ? redactEventStrings(event.payload, redactField) as Record<string, unknown>
        : event.payload;
      const nextStates = uniqueStates([
        ...states.filter((state) => !resolvedStateKeys.has(state.stateKey())),
        ...candidateStates,
      ]);
      if (overflow || nextStates.length > maxStates) {
        failedClosed.add(stream);
        return {
          ...event,
          message: typeof message === "string" ? REDACTED_EVENT_VALUE : message,
          payload: event.payload
            ? redactEventStrings(event.payload, () => REDACTED_EVENT_VALUE) as Record<string, unknown>
            : event.payload,
        };
      }
      headerRedactors[stream] = nextStates;
      return {
        ...event,
        message,
        payload,
      };
    },
  };
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
