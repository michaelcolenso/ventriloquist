import { describe, expect, it } from "vitest";
import {
  extractTranscript,
  normalizeComments,
  normalizeHashtag,
  normalizeProfile,
  normalizeSearchResult,
  normalizeSound,
  normalizeVideo,
} from "../src/domain/tiktok-web";
import { normalizeTrendingHashtags, normalizeTrendingSounds } from "../src/domain/trending";

const rawItem = {
  aweme_id: "7412345678901234567",
  desc: "Names that vanished #babynames",
  create_time: 1_780_000_000,
  share_url: "https://www.tiktok.com/@nobodynamed/video/7412345678901234567",
  statistics: {
    play_count: 250_000,
    digg_count: 18_000,
    comment_count: 940,
    share_count: 320,
    collect_count: 1_100,
  },
  author: {
    uid: "123",
    unique_id: "nobodynamed",
    nickname: "Nobody Named",
    verified: true,
    signature: "names",
    avatar_thumb: { url_list: ["https://cdn.example/a.jpg"] },
  },
  music: {
    id: "729999",
    title: "original sound",
    author: "Nobody Named",
    duration: 14_000,
    original: true,
    stats: { video_count: 4_200, user_count: 3_100 },
  },
  video: { duration: 14_200, cover: { url_list: ["https://cdn.example/cover.jpg"] } },
  text_extra: [{ hashtag_name: "babynames" }, { hashtag_name: "names" }],
  challenges: [{ title: "etymology" }],
};

describe("tiktok web payload mapping", () => {
  it("maps an item_list video into the domain model", () => {
    const video = normalizeVideo(rawItem);
    expect(video).not.toBeNull();
    expect(video!.id).toBe("7412345678901234567");
    expect(video!.author?.uniqueId).toBe("nobodynamed");
    expect(video!.author?.verified).toBe(true);
    expect(video!.stats.playCount).toBe(250_000);
    expect(video!.stats.likeCount).toBe(18_000);
    expect(video!.hashtags.sort()).toEqual(["babynames", "etymology", "names"]);
    expect(video!.music?.videoCount).toBe(4_200);
    expect(video!.durationSeconds).toBeCloseTo(14.2, 1);
    expect(video!.source).toBe("signer");
  });

  it("tolerates a payload with no author, music or stats", () => {
    const video = normalizeVideo({ id: "1", desc: "bare" });
    expect(video!.id).toBe("1");
    expect(video!.author).toBeNull();
    expect(video!.music).toBeNull();
    expect(video!.stats.playCount).toBeNull();
  });

  it("returns null rather than throwing on garbage", () => {
    expect(normalizeVideo(null)).toBeNull();
    expect(normalizeVideo({ desc: "no id" })).toBeNull();
  });

  it("maps search payloads with pagination", () => {
    const result = normalizeSearchResult(
      { item_list: [rawItem], cursor: "20", has_more: true },
      "US",
    );
    expect(result.items).toHaveLength(1);
    expect(result.cursor).toBe("20");
    expect(result.hasMore).toBe(true);
    expect(result.region).toBe("US");
  });

  it("maps user detail, comments, hashtag and sound payloads", () => {
    const profile = normalizeProfile({
      userInfo: {
        user: { id: "123", unique_id: "nobodynamed", nickname: "Nobody Named", verified: true },
        stats: { follower_count: 12_345, video_count: 87, heart_count: 99_000 },
      },
    });
    expect(profile?.uniqueId).toBe("nobodynamed");
    expect(profile?.stats.followerCount).toBe(12_345);
    expect(profile?.profileUrl).toBe("https://www.tiktok.com/@nobodynamed");

    const comments = normalizeComments(
      {
        comments: [
          { cid: "c1", text: "do Karen next!", digg_count: 40, reply_comment_total: 2, user: { unique_id: "fan" } },
        ],
        cursor: "1",
        has_more: true,
      },
      "7412345678901234567",
    );
    expect(comments.items[0]!.text).toBe("do Karen next!");
    expect(comments.items[0]!.likeCount).toBe(40);
    expect(comments.items[0]!.videoId).toBe("7412345678901234567");

    const hashtag = normalizeHashtag({
      challengeInfo: { challenge: { id: "9", title: "babynames" }, stats: { videoCount: 1_200_000, viewCount: 9_900_000_000 } },
    });
    expect(hashtag?.name).toBe("babynames");
    expect(hashtag?.viewCount).toBe(9_900_000_000);

    const sound = normalizeSound({
      musicInfo: { music: { id: "729999", title: "sad piano", authorName: "someone", duration: 30_000 }, stats: { videoCount: 12_000, userCount: 11_000 } },
    });
    expect(sound?.id).toBe("729999");
    expect(sound?.durationSeconds).toBe(30);
    expect(sound?.userCount).toBe(11_000);
  });

  it("extracts transcripts from either caption shape", () => {
    expect(extractTranscript({ voice_to_text: "hello", text_language: "en" })?.text).toBe("hello");
    expect(extractTranscript({ subtitles: [{ text: "captions", language_code: "en" }] })?.text).toBe(
      "captions",
    );
    expect(extractTranscript({})).toBeNull();
  });
});

describe("trending payload mapping", () => {
  it("normalizes Creative Center shaped hashtag rows", () => {
    const rows = normalizeTrendingHashtags(
      {
        code: 0,
        data: {
          list: [
            {
              hashtag_name: "babynames",
              hashtag_id: "123",
              rank: 3,
              rank_diff: 5,
              country_code: "US",
              industry_name: "Family & Relationships",
              publish_cnt: 12_000,
              video_views: 45_000_000,
              is_promoted: false,
              is_new: true,
            },
          ],
        },
      },
      "creative_center",
      "US",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("babynames");
    expect(rows[0]!.viewCount).toBe(45_000_000);
    expect(rows[0]!.publishCount).toBe(12_000);
    expect(rows[0]!.rankDiff).toBe(5);
    expect(rows[0]!.isNew).toBe(true);
    expect(rows[0]!.url).toBe("https://www.tiktok.com/tag/babynames");
  });

  it("normalizes ScrapeBadger shaped trending rows", () => {
    const rows = normalizeTrendingHashtags(
      {
        hashtags: [
          { name: "vintagenames", id: "9", rank: 1, rank_diff: 2, country_code: "US", view_count: 8_000_000, publish_count: 900 },
        ],
        region: "US",
      },
      "scrapebadger",
      "US",
    );
    expect(rows[0]!.name).toBe("vintagenames");
    expect(rows[0]!.viewCount).toBe(8_000_000);
    expect(rows[0]!.source).toBe("scrapebadger");

    const sounds = normalizeTrendingSounds(
      {
        songs: [
          { title: "sped up", id: "55", rank: 2, rank_diff: -1, user_count: 4_400, duration: 22, play_url: "https://cdn.example/s.mp3" },
        ],
      },
      "scrapebadger",
      "US",
    );
    expect(sounds[0]!.durationSeconds).toBe(22);
    expect(sounds[0]!.userCount).toBe(4_400);
    expect(sounds[0]!.rankDiff).toBe(-1);
  });

  it("returns an empty list for an unknown shape instead of throwing", () => {
    expect(normalizeTrendingHashtags({ code: 40101 }, "creative_center")).toEqual([]);
  });
});
