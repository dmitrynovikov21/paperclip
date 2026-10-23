const UNPAIRED_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** PostgreSQL jsonb rejects the lone surrogates that JSON.stringify escapes. */
export function replaceUnpairedSurrogates(value: string): string {
  return value.replace(UNPAIRED_SURROGATE_RE, "\uFFFD");
}

/** Keep the existing UTF-16 size limit without cutting a valid surrogate pair. */
export function truncateUnicodeString(value: string, maxCodeUnits: number): string {
  const end = Math.min(value.length, Math.max(0, maxCodeUnits));
  const lastCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  const splitsPair =
    lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff;
  return replaceUnpairedSurrogates(value.slice(0, splitsPair ? end - 1 : end));
}
