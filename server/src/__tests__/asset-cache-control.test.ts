import { describe, expect, it } from "vitest";
import { HASHED_ASSET_CACHE_CONTROL } from "../app.js";

// Regression guard for HELA-7803: the /assets static handler must NOT advertise
// `immutable, max-age=1y`. This deployment serves a customized UI build that is
// hotpatched in place (same filename, new content), and an immutable year-long
// cache makes those hotpatches permanently invisible to already-loaded clients.
describe("HASHED_ASSET_CACHE_CONTROL", () => {
  it("revalidates instead of caching immutably", () => {
    expect(HASHED_ASSET_CACHE_CONTROL).toBe("no-cache");
  });

  it("never marks assets immutable or year-cached", () => {
    expect(HASHED_ASSET_CACHE_CONTROL).not.toMatch(/immutable/i);
    expect(HASHED_ASSET_CACHE_CONTROL).not.toMatch(/max-age=31536000|max-age=\d{6,}/);
  });
});
