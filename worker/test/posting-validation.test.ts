import { describe, expect, it } from "vitest";
import {
  DEFAULT_POSTING_POLICY,
  MAX_CAPTION_LENGTH,
  postingContext,
  validatePostRequest,
} from "../src/storage/jobs";
import { fakeD1 } from "./support/fakes";

const NOW = 1_800_000_000;

const valid = {
  caption: "Why 'Karen' disappeared",
  hashtags: ["babynames", "names"],
  scheduledAt: null,
  now: NOW,
  videoR2Key: "renders/karen.mp4",
  videoObjectExists: true,
};

describe("validatePostRequest", () => {
  it("accepts a well-formed request", () => {
    const result = validatePostRequest(valid, { postsToday: 0, lastScheduledAt: null });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("enforces the 5 posts/day cap", () => {
    const result = validatePostRequest(valid, { postsToday: 5, lastScheduledAt: null });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/daily cap reached: 5\/5/);
  });

  it("enforces the 3h minimum spacing", () => {
    const result = validatePostRequest(
      { ...valid, scheduledAt: NOW + 3600 },
      { postsToday: 1, lastScheduledAt: NOW },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/minimum spacing is 3h/);
  });

  it("allows a post exactly at the spacing boundary", () => {
    const result = validatePostRequest(
      { ...valid, scheduledAt: NOW + 3 * 3600 },
      { postsToday: 1, lastScheduledAt: NOW },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a missing R2 object and an over-long caption", () => {
    const missing = validatePostRequest({ ...valid, videoObjectExists: false }, {
      postsToday: 0,
      lastScheduledAt: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(" ")).toMatch(/no R2 object at key/);

    const long = validatePostRequest({ ...valid, caption: "x".repeat(MAX_CAPTION_LENGTH + 1) }, {
      postsToday: 0,
      lastScheduledAt: null,
    });
    expect(long.ok).toBe(false);
    expect(long.errors.join(" ")).toContain(String(MAX_CAPTION_LENGTH));
  });

  it("rejects malformed hashtags", () => {
    const result = validatePostRequest({ ...valid, hashtags: ["#baby names"] }, {
      postsToday: 0,
      lastScheduledAt: null,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/bare words/);
  });

  it("warns, without failing, outside business-ish hours", () => {
    const result = validatePostRequest({ ...valid, scheduledAt: NOW - (NOW % 86_400) }, {
      postsToday: 0,
      lastScheduledAt: null,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("uses the documented policy defaults", () => {
    expect(DEFAULT_POSTING_POLICY.maxPostsPerDay).toBe(5);
    expect(DEFAULT_POSTING_POLICY.minSpacingHours).toBe(3);
    expect(DEFAULT_POSTING_POLICY.maxCaptionLength).toBe(2200);
  });
});

describe("postingContext", () => {
  it("reads today's count and the most recent scheduled time from D1", async () => {
    const db = fakeD1((sql) => {
      if (sql.includes("COUNT(*)")) return { first: { count: 2 } };
      if (sql.includes("MAX(")) return { first: { last_at: NOW - 7200 } };
      return {};
    });
    const context = await postingContext(db, NOW);
    expect(context.postsToday).toBe(2);
    expect(context.lastScheduledAt).toBe(NOW - 7200);
  });
});
