import { describe, expect, it } from "vitest";
import { profileTool } from "../src/mcp/tools/accounts";
import type { AppContext } from "../src/mcp/context";
import { fakeD1 } from "./support/fakes";

const profile = {
  uniqueId: "tiktok",
  nickname: "TikTok",
  verified: true,
  privateAccount: false,
  signature: "hi",
  region: null,
  profileUrl: "https://www.tiktok.com/@tiktok",
  stats: { followerCount: 96_100_000, followingCount: 1, heartCount: 465_200_000, videoCount: 1510 },
  source: "signer",
};

function fakeContext(videoFails: boolean): AppContext {
  const execution = (value: unknown) => ({
    value,
    provider: "signer",
    source: "signer",
    attemptChain: ["signer"],
    failover: false,
    latencyMs: 5,
    costUSD: 0,
  });
  return {
    env: { DB: fakeD1(() => ({})) },
    now: 1_790_000_000,
    snapshot: () => undefined,
    route: async (capability: string) => {
      if (capability === "profile") return execution(profile);
      if (videoFails) throw new Error('all providers for "profile_videos" are unavailable');
      return execution({ items: [], cursor: null, hasMore: false });
    },
  } as unknown as AppContext;
}

describe("tt_profile", () => {
  it("keeps the profile and warns when the video list is unavailable", async () => {
    const result = await profileTool.handler(
      { username: "@tiktok", include_videos: true, video_count: 12 },
      fakeContext(true),
    );
    expect(result.summary).toContain("96,100,000 followers");
    expect((result.data as { recent_videos: unknown[] }).recent_videos).toEqual([]);
    expect(result.warnings?.[0]).toContain("Recent videos unavailable");
  });

  it("has no warnings when videos load", async () => {
    const result = await profileTool.handler(
      { username: "tiktok", include_videos: true, video_count: 12 },
      fakeContext(false),
    );
    expect(result.warnings).toBeUndefined();
  });
});
