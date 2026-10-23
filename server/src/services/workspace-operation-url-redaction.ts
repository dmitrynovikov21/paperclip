const URL_PREFIX_RE = /[a-z][a-z0-9+.-]{0,31}:\/\//gi;
const PARTIAL_URL_PREFIX_RE = /[a-z][a-z0-9+.-]{0,31}(?::\/?)?(?![\s\S])/i;
const TRUNCATED_OUTPUT_PREFIX_RE = /^\[output truncated to last \d+ bytes; total \d+ bytes\]\n/;
const TRUNCATED_OUTPUT_RAW_PREFIX_RE = /^\[output truncated to last \d+ bytes; total \d+ bytes\]\\n/;
const MAX_PREFIX_LENGTH = 35;
const MAX_PENDING_USERINFO_LENGTH = 8192;
const REDACTED_USERINFO = "[REDACTED]";

/** The last @ before an authority boundary separates userinfo from the host. */
function authorityEnd(value: string, rawJson = false): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (rawJson && code === 0x5c) {
      // A saved NDJSON string may contain an escaped quote inside userinfo.
      // Wait if the escape pair is split across the scanner's 8192-byte parts.
      if (index + 1 === value.length) return value.length;
      index += 1;
      continue;
    }
    if (rawJson && code === 0x22 && (index + 1 === value.length || /[},\]]/.test(value[index + 1]!))) {
      return index;
    }
    // The URL parser accepts raw quotes, backslashes, angle brackets, and
    // whitespace in userinfo. Only these characters end its authority.
    if (code === 0x2f || code === 0x3f || code === 0x23) {
      return index;
    }
  }
  return value.length;
}

/** A new scheme can begin before the slash that ended the current authority. */
function nextUrlPrefixBeforeBoundary(value: string, boundary: number): number | null {
  URL_PREFIX_RE.lastIndex = 0;
  const match = URL_PREFIX_RE.exec(value);
  if (match && match.index < boundary) return match.index;
  // The second slash may arrive in the next output chunk or NDJSON event.
  if (value[boundary] === "/") {
    const partial = /[a-z][a-z0-9+.-]{0,31}:\/$/i.exec(value.slice(0, boundary + 1));
    if (partial && partial.index < boundary) return partial.index;
  }
  return null;
}

function redactAuthority(authority: string, incomplete = false): string {
  const separator = authority.lastIndexOf("@");
  if (separator > 0) return `${REDACTED_USERINFO}${authority.slice(separator)}`;
  return incomplete && authority ? REDACTED_USERINFO : authority;
}

/** A colon before a boundary may be a password delimiter, even without @ yet. */
function mayContainUnfinishedUserInfo(authority: string): boolean {
  return authority.includes(":");
}

/** Redact URL userinfo in operation fields, including interrupted authorities. */
export function redactWorkspaceOperationUrlUserInfo(value: string): string {
  const redactor = createWorkspaceOperationUrlStreamRedactor();
  return redactor.push(value) + redactor.flush();
}

function redactUnknownLeadingAuthority(value: string): string {
  const end = authorityEnd(value);
  const nextUrl = nextUrlPrefixBeforeBoundary(value, end);
  const unknownEnd = nextUrl ?? end;
  if (unknownEnd === 0) return value;
  // The preceding bytes were discarded, so this first token cannot be classified safely.
  return redactAuthority(value.slice(0, unknownEnd), true) + value.slice(unknownEnd);
}

/** A bounded process capture can start inside userinfo, before the URL scheme. */
export function redactTruncatedWorkspaceOperationOutput(value: string): string {
  const prefix = TRUNCATED_OUTPUT_PREFIX_RE.exec(value)?.[0];
  if (!prefix) return value;
  return prefix + redactUnknownLeadingAuthority(value.slice(prefix.length));
}

/** An old 4096-character excerpt may start in the middle of URL userinfo. */
export function redactWorkspaceOperationExcerpt(value: string | null): string | null {
  if (value === null) return null;
  const redactor = createWorkspaceOperationUrlStreamRedactor();
  const truncatedCapture = TRUNCATED_OUTPUT_PREFIX_RE.test(value);
  // Older rows kept only the last 4096 characters. At that limit the first
  // character may be inside userinfo, so its origin cannot be inferred.
  const input = value.length >= 4096 && !truncatedCapture
    ? redactUnknownLeadingAuthority(value)
    : redactTruncatedWorkspaceOperationOutput(value);
  return redactor.push(input) + redactor.flush();
}

export function redactWorkspaceOperationUrls<T>(value: T): T {
  if (typeof value === "string") return redactWorkspaceOperationUrlUserInfo(value) as T;
  if (Array.isArray(value)) return value.map(redactWorkspaceOperationUrls) as T;
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactWorkspaceOperationUrls(entry)]),
  ) as T;
}

/**
 * The replacement keeps every byte position stable for the byte-range log API.
 * Latin-1 maps each input byte to one character, including UTF-8 bytes around URLs.
 */
export function maskWorkspaceOperationUrlUserInfoBytes(input: Buffer): Buffer {
  const output = Buffer.from(input);
  const text = input.toString("latin1");
  const pattern = /[a-z][a-z0-9+.-]{0,31}:\/\//gi;
  for (const match of text.matchAll(pattern)) {
    const userinfoStart = match.index + match[0].length;
    const suffix = text.slice(userinfoStart);
    const boundary = authorityEnd(suffix, true);
    const nextUrl = nextUrlPrefixBeforeBoundary(suffix, boundary);
    const end = nextUrl ?? boundary;
    const authority = suffix.slice(0, end);
    const separator = authority.lastIndexOf("@");
    const hiddenLength = separator > 0 ? separator
      : (nextUrl === null && mayContainUnfinishedUserInfo(authority) ? end : 0);
    if (hiddenLength > 0) output.fill(0x2a, userinfoStart, userinfoStart + hiddenLength);
  }
  return output;
}

export interface WorkspaceOperationMaskedByteRange {
  start: number;
  end: number;
}

/**
 * Find byte positions to hide in old NDJSON logs. The same stream may continue
 * a URL in a later event, with JSON metadata between the two chunk strings.
 * Only positions are retained; no credential value is cached.
 */
export function createWorkspaceOperationByteRangeScanner() {
  type State = { pending: string; positions: number[]; droppingUserInfo: boolean };
  const states = new Map<string, State>();
  const ranges: WorkspaceOperationMaskedByteRange[] = [];

  function mark(positions: number[]) {
    for (const position of positions) {
      const last = ranges[ranges.length - 1];
      if (last && last.end === position) last.end += 1;
      else ranges.push({ start: position, end: position + 1 });
    }
  }

  function drain(state: State) {
    while (state.pending) {
      if (state.droppingUserInfo) {
        const boundary = authorityEnd(state.pending, true);
        const nextUrl = nextUrlPrefixBeforeBoundary(state.pending, boundary);
        if (nextUrl !== null) {
          mark(state.positions.slice(0, nextUrl));
          state.pending = state.pending.slice(nextUrl);
          state.positions = state.positions.slice(nextUrl);
          state.droppingUserInfo = false;
          continue;
        }
        if (boundary === state.pending.length) {
          const keep = PARTIAL_URL_PREFIX_RE.exec(state.pending)?.[0].length ?? 0;
          mark(state.positions.slice(0, state.pending.length - keep));
          state.pending = state.pending.slice(state.pending.length - keep);
          state.positions = state.positions.slice(state.positions.length - keep);
          return;
        }
        mark(state.positions.slice(0, boundary));
        state.pending = state.pending.slice(boundary + 1);
        state.positions = state.positions.slice(boundary + 1);
        state.droppingUserInfo = false;
        continue;
      }

      URL_PREFIX_RE.lastIndex = 0;
      const match = URL_PREFIX_RE.exec(state.pending);
      if (!match) {
        const keep = Math.min(MAX_PREFIX_LENGTH - 1, state.pending.length);
        state.pending = state.pending.slice(state.pending.length - keep);
        state.positions = state.positions.slice(state.positions.length - keep);
        return;
      }

      state.pending = state.pending.slice(match.index);
      state.positions = state.positions.slice(match.index);
      const userinfoStart = match[0].length;
      const suffix = state.pending.slice(userinfoStart);
      const boundary = authorityEnd(suffix, true);
      if (boundary < suffix.length) {
        const nextUrl = nextUrlPrefixBeforeBoundary(suffix, boundary);
        const end = nextUrl ?? boundary;
        const authority = suffix.slice(0, end);
        const separator = authority.lastIndexOf("@");
        const hiddenLength = separator > 0 ? separator
          : (nextUrl === null && mayContainUnfinishedUserInfo(authority) ? end : 0);
        if (hiddenLength > 0) mark(state.positions.slice(userinfoStart, userinfoStart + hiddenLength));
        const consumed = userinfoStart + end + (nextUrl === null ? 1 : 0);
        state.pending = state.pending.slice(consumed);
        state.positions = state.positions.slice(consumed);
        continue;
      }

      if (suffix.length > MAX_PENDING_USERINFO_LENGTH) {
        mark(state.positions.slice(userinfoStart));
        state.pending = "";
        state.positions = [];
        state.droppingUserInfo = true;
      }
      return;
    }
  }

  return {
    feed(stream: string, rawChunk: string, byteOffset: number) {
      const state = states.get(stream) ?? { pending: "", positions: [], droppingUserInfo: false };
      states.set(stream, state);
      const truncatedPrefix = TRUNCATED_OUTPUT_RAW_PREFIX_RE.exec(rawChunk)?.[0];
      if (truncatedPrefix) {
        const tail = rawChunk.slice(truncatedPrefix.length);
        const end = authorityEnd(tail, true);
        const nextUrl = nextUrlPrefixBeforeBoundary(tail, end);
        const unknownEnd = nextUrl ?? end;
        if (unknownEnd > 0) {
          const separator = tail.slice(0, unknownEnd).lastIndexOf("@");
          ranges.push({
            start: byteOffset + truncatedPrefix.length,
            end: byteOffset + truncatedPrefix.length + (separator > 0 ? separator : unknownEnd),
          });
        }
      }
      for (let start = 0; start < rawChunk.length; start += 8192) {
        const part = rawChunk.slice(start, start + 8192);
        state.pending += part;
        for (let i = 0; i < part.length; i += 1) state.positions.push(byteOffset + start + i);
        drain(state);
      }
    },
    finish(): WorkspaceOperationMaskedByteRange[] {
      for (const state of states.values()) {
        if (state.droppingUserInfo) {
          // A retained scheme-like suffix is still userinfo if no later chunk completes it.
          mark(state.positions);
          continue;
        }
        URL_PREFIX_RE.lastIndex = 0;
        const match = URL_PREFIX_RE.exec(state.pending);
        if (match) {
          const start = match.index + match[0].length;
          const separator = state.pending.slice(start).lastIndexOf("@");
          mark(state.positions.slice(start, separator > 0 ? start + separator : undefined));
        }
      }
      ranges.sort((left, right) => left.start - right.start);
      const merged: WorkspaceOperationMaskedByteRange[] = [];
      for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && last.end >= range.start) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
      }
      return merged;
    },
  };
}

/** Hold a possible URL until the authority boundary arrives in a later chunk. */
export function createWorkspaceOperationUrlStreamRedactor() {
  let pending = "";
  let droppingUserInfo = false;
  let droppingPending = "";

  function consume(chunk: string, final = false): string {
    let input = pending + chunk;
    pending = "";
    let output = "";

    if (droppingUserInfo) {
      input = droppingPending + input;
      droppingPending = "";
      const boundary = authorityEnd(input);
      const nextUrl = nextUrlPrefixBeforeBoundary(input, boundary);
      if (nextUrl !== null) {
        input = input.slice(nextUrl);
      } else if (boundary === input.length) {
        if (!final) droppingPending = PARTIAL_URL_PREFIX_RE.exec(input)?.[0] ?? "";
        return output;
      } else {
        output += input[boundary];
        input = input.slice(boundary + 1);
      }
      droppingUserInfo = false;
    }

    while (input) {
      URL_PREFIX_RE.lastIndex = 0;
      const match = URL_PREFIX_RE.exec(input);
      if (!match) {
        // Keep only a suffix that could become a URL scheme in the next chunk.
        // Holding an arbitrary tail would split ordinary complete log lines.
        const keep = final ? 0 : (PARTIAL_URL_PREFIX_RE.exec(input)?.[0].length ?? 0);
        output += input.slice(0, input.length - keep);
        pending = input.slice(input.length - keep);
        break;
      }

      output += input.slice(0, match.index);
      const prefix = match[0];
      const afterPrefix = input.slice(match.index + prefix.length);
      const end = authorityEnd(afterPrefix);
      if (end === afterPrefix.length) {
        if (final) {
          // An interrupted stream may end inside userinfo, before its @ arrives.
          output += prefix + redactAuthority(afterPrefix, true);
        } else if (afterPrefix.length > MAX_PENDING_USERINFO_LENGTH) {
          output += prefix + REDACTED_USERINFO;
          droppingUserInfo = true;
        } else {
          pending = prefix + afterPrefix;
        }
        break;
      }

      const nextUrl = nextUrlPrefixBeforeBoundary(afterPrefix, end);
      const authorityLength = nextUrl ?? end;
      const authority = afterPrefix.slice(0, authorityLength);
      output += prefix + redactAuthority(authority, nextUrl === null && mayContainUnfinishedUserInfo(authority));
      if (nextUrl === null) output += afterPrefix[end];
      input = afterPrefix.slice(authorityLength + (nextUrl === null ? 1 : 0));
    }
    return output;
  }

  return {
    push: (chunk: string) => consume(chunk),
    flush: () => consume("", true),
    hasPending: () => pending.length > 0 || droppingUserInfo,
  };
}
