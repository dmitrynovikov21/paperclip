import { describe, expect, it } from "vitest";
import { replaceUnpairedSurrogates, truncateUnicodeString } from "./unicode.js";

describe("Unicode-safe snapshot text", () => {
  it.each([500, 1_200, 4_000, 12_000])("keeps valid pairs on both sides of the %i limit", (limit) => {
    expect(truncateUnicodeString(`${"a".repeat(limit - 1)}🟢tail`, limit))
      .toBe("a".repeat(limit - 1));
    expect(truncateUnicodeString(`${"a".repeat(limit - 2)}🟢tail`, limit))
      .toBe(`${"a".repeat(limit - 2)}🟢`);
    expect(truncateUnicodeString(`${"a".repeat(limit)}🟢tail`, limit))
      .toBe("a".repeat(limit));
  });

  it("repairs lone high and low surrogates while preserving valid emoji", () => {
    expect(replaceUnpairedSurrogates("before\ud83d middle \udfe2 and 🟢 after"))
      .toBe("before\uFFFD middle \uFFFD and 🟢 after");
    expect(truncateUnicodeString("x\ud83dy", 3)).toBe("x\uFFFDy");
  });
});
