import { describe, expect, it } from "vitest";
import { ScrapeBadgerProvider } from "../src/backends/providers/scrapebadger";
import { CreativeCenterProvider } from "../src/backends/providers/creativeCenter";
import { createLogger } from "../src/lib/logger";
import type { CallContext } from "../src/backends/types";
import type { Comment, Profile, SearchResult, SoundStats, Video } from "../src/domain/models";

/**
 * These fixtures mirror the response shapes documented in ScrapeBadger's
 * OpenAPI document (docs.scrapebadger.com/openapi-tiktok.json), which is the
 * contract the paid fallback must satisfy.
 */
function context(
  handler: (url: string) => unknown,
  options: { status?: number; raw?: string } = {},
): { ctx: CallContext; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (options.raw !== undefined) {
      return new Response(options.raw, { status: options.status ?? 200 });
    }
    return new Response(JSON.stringify(handler(url)), {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return {
    calls,
    ctx: {
      env: {} as never,
      region: "US",
      now: 1_800_000_000,
      fetch: fetchImpl,
      logger: createLogger("error"),
    },
  };
}

const vendor = () =>
  new ScrapeBadgerProvider({
    name: "scrapebadger",
    source: "scrapebadger",
    apiKey: "test-key",
    costPerCallUSD: 0.001,
  });

describe("ScrapeBadger adapter", () => {
  it("maps a search response and forwards count/region/cursor", async () => {
    const { ctx, calls } = context(() => ({
      videos: [
        {
          id: "741",
          description: "names",
          create_time_utc: 1_780_000_000,
          url: "https://www.tiktok.com/@x/video/741",
          author: { id: "1", unique_id: "x", nickname: "X", verified: true, follower_count: 10 },
          music: { id: "9", title: "sound", author_name: "a", duration: 15, video_count: 4 },
          stats: { play_count: 100, digg_count: 10, comment_count: 2, share_count: 1 },
          challenges: [{ title: "babynames" }],
          is_slideshow: false,
        },
      ],
      pagination: { has_more: true, cursor: "20" },
      region: "US",
    }));

    const result = (await vendor().execute(
      "search",
      { query: "baby names", count: 5 },
      ctx,
    )) as SearchResult<Video>;

    expect(calls[0]).toContain("/v1/tiktok/search/videos");
    expect(calls[0]).toContain("query=baby+names");
    expect(calls[0]).toContain("count=5");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.author?.uniqueId).toBe("x");
    expect(result.items[0]!.stats.playCount).toBe(100);
    expect(result.items[0]!.hashtags).toEqual(["babynames"]);
    expect(result.cursor).toBe("20");
    expect(result.hasMore).toBe(true);
    expect(result.source).toBe("scrapebadger");
  });

  it("maps profile, comments, hashtag and sound responses", async () => {
    const profileCtx = context(() => ({
      user: { id: "1", unique_id: "nobodynamed", nickname: "NN", stats: { follower_count: 42 } },
    })).ctx;
    const profile = (await vendor().execute("profile", { username: "@nobodynamed" }, profileCtx)) as Profile;
    expect(profile.uniqueId).toBe("nobodynamed");
    expect(profile.stats.followerCount).toBe(42);

    const commentsCtx = context(() => ({
      comments: [{ id: "c1", text: "do Karen next", digg_count: 12, author: { unique_id: "fan" } }],
      pagination: { has_more: false, cursor: "0" },
    })).ctx;
    const comments = (await vendor().execute("comments", { video_id: "741" }, commentsCtx)) as SearchResult<Comment>;
    expect(comments.items[0]!.text).toBe("do Karen next");
    expect(comments.items[0]!.likeCount).toBe(12);

    const hashtagCtx = context(() => ({
      hashtag: { id: "9", title: "babynames", video_count: 1000, view_count: 5_000_000 },
    })).ctx;
    const hashtag = (await vendor().execute("hashtag_stats", { hashtag: "#babynames" }, hashtagCtx)) as {
      name: string;
      viewCount: number | null;
    };
    expect(hashtag.name).toBe("babynames");
    expect(hashtag.viewCount).toBe(5_000_000);

    const soundCtx = context(() => ({ music: { id: "9", title: "s", user_count: 10, video_count: 20 } })).ctx;
    const sound = (await vendor().execute("sound_stats", { sound_id: "9" }, soundCtx)) as SoundStats;
    expect(sound.userCount).toBe(10);
    expect(sound.videoCount).toBe(20);
  });

  it("maps trending hashtags and songs from the vendor's signer path", async () => {
    const { ctx } = context((url) =>
      url.includes("hashtags")
        ? { hashtags: [{ name: "babynames", rank: 1, rank_diff: 3, view_count: 100, publish_count: 9 }] }
        : { songs: [{ id: "5", title: "s", rank: 2, user_count: 8 }] },
    );

    const hashtags = (await vendor().execute("trending", { mode: "hashtags" }, ctx)) as { name: string }[];
    expect(hashtags[0]!.name).toBe("babynames");
    const songs = (await vendor().execute("trending", { mode: "songs" }, ctx)) as { id: string | null }[];
    expect(songs[0]!.id).toBe("5");
  });

  it("classifies auth failures as non-retryable and 5xx as retryable", async () => {
    const unauthorized = context(() => ({}), { status: 401, raw: "nope" }).ctx;
    await expect(vendor().execute("search", { query: "x" }, unauthorized)).rejects.toMatchObject({
      status: 401,
      retryable: false,
      countsTowardBreaker: false,
    });

    const serverError = context(() => ({}), { status: 500, raw: "boom" }).ctx;
    await expect(vendor().execute("search", { query: "x" }, serverError)).rejects.toMatchObject({
      status: 500,
      retryable: true,
    });
  });
});

describe("Creative Center adapter", () => {
  it("maps a hashtag list response", async () => {
    const { ctx } = context((url) => {
      expect(url).toContain("ads.tiktok.com/creative_radar_api");
      return {
        code: 0,
        data: { list: [{ hashtag_name: "vintagenames", rank: 1, video_views: 123, publish_cnt: 4 }] },
      };
    });
    const rows = (await new CreativeCenterProvider().execute(
      "trending",
      { mode: "hashtags" },
      ctx,
    )) as { name: string; viewCount: number | null }[];
    expect(rows[0]!.name).toBe("vintagenames");
    expect(rows[0]!.viewCount).toBe(123);
  });

  it("treats a permission code as a retryable failure so the breaker can trip", async () => {
    const { ctx } = context(() => ({ code: 40101, msg: "no permission" }));
    await expect(
      new CreativeCenterProvider().execute("trending", { mode: "hashtags" }, ctx),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("rejects unsupported capabilities", async () => {
    const { ctx } = context(() => ({}));
    await expect(
      new CreativeCenterProvider().execute("search", { query: "x" }, ctx),
    ).rejects.toMatchObject({ retryable: false });
  });
});
