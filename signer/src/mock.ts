/**
 * Deterministic fixtures for MOCK=1.
 *
 * Mock mode exists so the whole facade (routing, normalization, snapshotting,
 * velocity math, MCP transport) can be exercised end to end with no Chromium,
 * no TikTok reachability and no cookies. Counts are derived from a hash plus a
 * slow time ramp, so repeated calls produce different numbers and the velocity
 * engine has something real to chew on.
 */

const MINUTE = 60;
const RAMP_SECONDS = 6 * 3600;

function hash(value: string): number {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return Math.abs(output);
}

function ramp(now: number, periodSeconds: number, amplitude: number): number {
  return Math.floor(((now % periodSeconds) / periodSeconds) * amplitude);
}

/** Counts drift upward within a 6h sawtooth so 4h snapshots show real deltas. */
function growth(seed: string, now: number, base: number, amplitude: number): number {
  const offset = hash(seed) % amplitude;
  return base + offset + ramp(now, RAMP_SECONDS, amplitude);
}

const COHORT = [
  { username: "nobodynamed", nickname: "Nobody Named", niche: "baby-names", followers: 84_200 },
  { username: "nameoracle", nickname: "The Name Oracle", niche: "baby-names", followers: 212_000 },
  { username: "baby_name_vault", nickname: "Baby Name Vault", niche: "baby-names", followers: 145_500 },
  { username: "theetymologist", nickname: "The Etymologist", niche: "etymology", followers: 310_400 },
  { username: "graveyardnames", nickname: "Graveyard Names", niche: "baby-names", followers: 61_300 },
  { username: "vowelcount", nickname: "Vowel Count", niche: "data-storytelling", followers: 98_700 },
  { username: "namingrights", nickname: "Naming Rights", niche: "parenting-humor", followers: 402_900 },
];

const HASHTAGS = [
  "babynames",
  "vintagenames",
  "girlnames",
  "boynames",
  "namemeaning",
  "etymology",
  "familyhumor",
  "graveyardnames",
];

const SOUNDS = ["7300000000000000001", "7300000000000000002", "7300000000000000003", "7300000000000000004"];

function authorFor(username: string, now: number) {
  const account = COHORT.find((entry) => entry.username === username) ?? COHORT[0]!;
  return {
    uid: String(hash(account.username) % 10_000_000),
    sec_uid: `MS4wLjABAAAA${hash(account.username).toString(36)}`,
    unique_id: account.username,
    nickname: account.nickname,
    signature: `${account.niche} account`,
    verified: account.followers > 200_000,
    region: "US",
    avatar_thumb: { url_list: [`https://mock.local/avatar/${account.username}.jpg`] },
    stats: {
      follower_count: growth(account.username, now, account.followers, 500),
      video_count: 120,
      heart_count: account.followers * 12,
    },
  };
}

function videoFor(id: string, username: string, now: number) {
  const seed = `${id}:${username}`;
  const plays = growth(seed, now, 20_000 + (hash(seed) % 900_000), 250_000);
  const likes = Math.floor(plays * 0.07) + 50;
  const comments = Math.floor(plays * 0.004) + 5;
  const shares = Math.floor(plays * 0.002) + 2;
  const hashtags = HASHTAGS.slice(hash(seed) % 3, (hash(seed) % 3) + 3);
  return {
    aweme_id: id,
    desc: `#${hashtags[0]} did you know this about ${username}?`,
    create_time: now - (hash(seed) % 30) * 86_400,
    share_url: `https://www.tiktok.com/@${username}/video/${id}`,
    region: "US",
    author: authorFor(username, now),
    music: {
      id: SOUNDS[hash(seed) % SOUNDS.length],
      title: `mock sound ${hash(seed) % 9}`,
      author: "mock",
      original: true,
      duration: 15_000,
      stats: {
        video_count: growth(`sound:${seed}`, now, 400, 900),
        user_count: growth(`sound-user:${seed}`, now, 300, 700),
      },
      play_url: "https://mock.local/sound.mp3",
    },
    statistics: {
      play_count: plays,
      digg_count: likes,
      comment_count: comments,
      share_count: shares,
      collect_count: Math.floor(likes * 0.2),
    },
    video: {
      duration: 14_000 + (hash(seed) % 4_000),
      cover: { url_list: [`https://mock.local/cover/${id}.jpg`] },
    },
    text_extra: hashtags.map((tag) => ({ hashtag_name: tag })),
    challenges: hashtags.map((tag) => ({ title: tag })),
    is_slideshow: false,
    status_code: 0,
  };
}

function videosFor(username: string, count: number, now: number): unknown[] {
  return Array.from({ length: count }, (_, index) =>
    videoFor(String(7_400_000_000_000_000_000n + BigInt(hash(`${username}${index}`) % 9_999_999)), username, now),
  );
}

export const MOCK_ACCOUNTS = COHORT.map((entry) => entry.username);
export const MOCK_HASHTAGS = HASHTAGS;

/** Replies for the TikTok web API paths the signer path requests. */
export function mockTikTokResponse(
  pathname: string,
  params: URLSearchParams,
  now = Math.floor(Date.now() / 1000),
): unknown | null {
  if (pathname.startsWith("/api/search/item/full/")) {
    const keyword = params.get("keyword") ?? "babynames";
    const count = Number(params.get("count") ?? 12);
    const items = COHORT.flatMap((account) => videosFor(account.username, 2, now)).slice(0, count);
    return {
      status_code: 0,
      item_list: items,
      cursor: "20",
      has_more: true,
      keyword,
    };
  }

  if (pathname.startsWith("/api/user/detail/")) {
    const username = params.get("uniqueId") ?? "nobodynamed";
    const author = authorFor(username, now);
    return {
      status_code: 0,
      userInfo: {
        user: {
          id: author.uid,
          secUid: author.sec_uid,
          uniqueId: author.unique_id,
          nickname: author.nickname,
          signature: author.signature,
          verified: author.verified,
          privateAccount: false,
          region: author.region,
          avatarLarger: { url_list: author.avatar_thumb.url_list },
        },
        stats: {
          followerCount: author.stats.follower_count,
          followingCount: 320,
          heartCount: author.stats.heart_count,
          videoCount: author.stats.video_count,
        },
      },
    };
  }

  if (pathname.startsWith("/api/post/item_list/")) {
    const secUid = params.get("secUid") ?? "";
    const count = Number(params.get("count") ?? 10);
    const account =
      COHORT.find((entry) => secUid.includes(hash(entry.username).toString(36))) ?? COHORT[0]!;
    return {
      status_code: 0,
      item_list: videosFor(account.username, count, now),
      cursor: "30",
      has_more: true,
    };
  }

  if (pathname.startsWith("/api/item/detail/")) {
    const itemId = params.get("itemId") ?? "7400000000000000000";
    return { status_code: 0, itemInfo: { itemStruct: videoFor(itemId, "nobodynamed", now) } };
  }

  if (pathname.startsWith("/api/comment/list/")) {
    const videoId = params.get("aweme_id") ?? "7400000000000000000";
    const count = Number(params.get("count") ?? 20);
    const texts = [
      "do Karen next!!",
      "please do Karen next, my mom is a Karen",
      "Karen is such a good name",
      "what about Deborah?",
      "do Deborah next please",
      "Deborah never gets covered",
      "this is the best baby name series",
      "can you do 80s names that vanished",
      "80s names that vanished please!",
      "80s names that vanished, do it",
      "my grandma was named Karen and she hates it lol",
      "part 2 please",
    ];
    return {
      status_code: 0,
      comments: Array.from({ length: Math.min(count, texts.length) }, (_, index) => ({
        cid: `${videoId}-c${index}`,
        aweme_id: videoId,
        text: texts[index],
        digg_count: growth(`comment:${videoId}:${index}`, now, 5, 120),
        reply_comment_total: hash(texts[index]!) % 5,
        create_time: now - index * 3600,
        is_author_digged: index % 4 === 0,
        user: authorFor(COHORT[index % COHORT.length]!.username, now),
      })),
      cursor: "20",
      has_more: false,
    };
  }

  if (pathname.startsWith("/api/challenge/detail/")) {
    const name = params.get("challengeName") ?? "babynames";
    return {
      status_code: 0,
      challengeInfo: {
        challenge: { id: String(hash(name) % 1_000_000), title: name, desc: `${name} on TikTok` },
        stats: {
          videoCount: growth(`tag-videos:${name}`, now, 40_000, 30_000),
          viewCount: growth(`tag-views:${name}`, now, 8_000_000, 6_000_000),
        },
      },
    };
  }

  if (pathname.startsWith("/api/music/detail/")) {
    const musicId = params.get("musicId") ?? SOUNDS[0]!;
    return {
      status_code: 0,
      musicInfo: {
        music: {
          id: musicId,
          title: `mock sound ${hash(musicId) % 9}`,
          authorName: "mock creator",
          duration: 18_000,
          original: true,
          coverMedium: { url_list: ["https://mock.local/sound-cover.jpg"] },
          playUrl: { url_list: ["https://mock.local/sound.mp3"] },
        },
        stats: {
          videoCount: growth(`music-videos:${musicId}`, now, 2_000, 4_000),
          userCount: growth(`music-users:${musicId}`, now, 1_500, 3_000),
        },
      },
    };
  }

  return null;
}

/** Replies for the Creative Center paths (the free `trending` primary). */
export function mockCreativeCenterResponse(
  pathname: string,
  params: URLSearchParams,
  now = Math.floor(Date.now() / 1000),
): unknown | null {
  const limit = Math.min(Number(params.get("limit") ?? 20), 200);
  const country = params.get("country_code") ?? "US";

  if (pathname.endsWith("/hashtag/list")) {
    return {
      code: 0,
      msg: "success",
      data: {
        list: Array.from({ length: Math.min(limit, HASHTAGS.length * 3) }, (_, index) => {
          const name = `${HASHTAGS[index % HASHTAGS.length]}${index >= HASHTAGS.length ? index : ""}`;
          return {
            hashtag_name: name,
            hashtag_id: String(hash(name) % 1_000_000),
            rank: index + 1,
            rank_diff: (hash(name) % 9) - 4,
            country_code: country,
            industry_name: "Family & Relationships",
            publish_cnt: growth(`cc-posts:${name}`, now, 8_000, 20_000),
            video_views: growth(`cc-views:${name}`, now, 3_000_000, 30_000_000),
            user_count: growth(`cc-users:${name}`, now, 2_000, 12_000),
            is_promoted: false,
            is_new: index < 3,
          };
        }),
      },
    };
  }

  if (pathname.endsWith("/sound/list")) {
    return {
      code: 0,
      msg: "success",
      data: {
        list: Array.from({ length: Math.min(limit, 12) }, (_, index) => ({
          title: `mock sound ${index}`,
          music_id: SOUNDS[index % SOUNDS.length],
          author: "mock creator",
          rank: index + 1,
          rank_diff: (hash(`s${index}`) % 7) - 3,
          country_code: country,
          duration: 15 + (hash(`d${index}`) % 30),
          user_cnt: growth(`cc-sound:${index}`, now, 4_000, 20_000),
          cover_url: "https://mock.local/sound-cover.jpg",
          play_url: "https://mock.local/sound.mp3",
          is_new: index < 2,
          link: `https://www.tiktok.com/music/mock-${index}`,
        })),
      },
    };
  }

  if (pathname.endsWith("/video/list")) {
    return {
      code: 0,
      msg: "success",
      data: { list: videosFor("nobodynamed", Math.min(limit, 10), now) },
    };
  }

  return null;
}

export const MOCK_RAMP_SECONDS = RAMP_SECONDS;
export const MOCK_MINUTE = MINUTE;

/**
 * The same fake world, shaped like ScrapeBadger's documented responses.
 *
 * This is what lets the smoke test demonstrate real failover: point
 * SCRAPEBADGER_BASE_URL here, kill the signer, and the router cascades onto a
 * paid provider whose contract the adapter actually implements.
 */
export function mockScrapeBadgerResponse(
  pathname: string,
  params: URLSearchParams,
  now = Math.floor(Date.now() / 1000),
): unknown | null {
  const region = params.get("region") ?? "US";
  const count = Number(params.get("count") ?? 20);

  const vendorVideo = (item: Record<string, unknown>) => {
    const author = (item.author ?? {}) as Record<string, unknown>;
    const stats = (item.statistics ?? {}) as Record<string, unknown>;
    const music = (item.music ?? {}) as Record<string, unknown>;
    const video = (item.video ?? {}) as Record<string, unknown>;
    const authorStats = (author.stats ?? {}) as Record<string, unknown>;
    return {
      id: item.aweme_id,
      description: item.desc,
      create_time_utc: item.create_time,
      url: item.share_url,
      region: item.region ?? region,
      author: {
        id: author.uid,
        unique_id: author.unique_id,
        nickname: author.nickname,
        verified: author.verified,
        follower_count: authorStats.follower_count,
        video_count: authorStats.video_count,
      },
      music: {
        id: music.id,
        title: music.title,
        author_name: music.author,
        duration: music.duration,
        video_count: (music.stats as Record<string, unknown> | undefined)?.video_count,
        user_count: (music.stats as Record<string, unknown> | undefined)?.user_count,
      },
      stats: {
        play_count: stats.play_count,
        digg_count: stats.digg_count,
        comment_count: stats.comment_count,
        share_count: stats.share_count,
        collect_count: stats.collect_count,
      },
      video: { duration: video.duration },
      challenges: ((item.challenges ?? []) as { title: string }[]).map((challenge) => ({
        title: challenge.title,
      })),
      is_slideshow: item.is_slideshow ?? false,
    };
  };

  const userMatch = /^\/users\/([^/]+)$/.exec(pathname);
  if (userMatch) {
    const requested = decodeURIComponent(userMatch[1]!);
    // Unknown handles still get a plausible profile that echoes the requested
    // handle, so callers can tell which account the vendor answered for.
    const known = COHORT.some((entry) => entry.username === requested);
    const author = known
      ? authorFor(requested, now)
      : {
          uid: String(hash(requested) % 10_000_000),
          sec_uid: `MS4wLjABAAAA${hash(requested).toString(36)}`,
          unique_id: requested,
          nickname: requested,
          signature: `${requested} (vendor mock)`,
          verified: false,
          region: "US",
          avatar_thumb: { url_list: [`https://mock.local/avatar/${requested}.jpg`] },
          stats: {
            follower_count: growth(requested, now, 40_000, 900),
            video_count: 90,
            heart_count: 500_000,
          },
        };
    return {
      user: {
        id: author.uid,
        unique_id: author.unique_id,
        nickname: author.nickname,
        signature: author.signature,
        verified: author.verified,
        private_account: false,
        region: author.region,
        profile_url: `https://www.tiktok.com/@${author.unique_id}`,
        avatar_larger: author.avatar_thumb.url_list[0],
        stats: {
          follower_count: author.stats.follower_count,
          following_count: 320,
          heart_count: author.stats.heart_count,
          video_count: author.stats.video_count,
        },
      },
      region,
    };
  }

  const userVideos = /^\/users\/([^/]+)\/videos$/.exec(pathname);
  if (userVideos) {
    const username = decodeURIComponent(userVideos[1]!);
    const videos = videosFor(username, Math.min(count, 20), now).map((item) =>
      vendorVideo(item as Record<string, unknown>),
    );
    return {
      videos,
      pagination: { has_more: true, cursor: "20", count: videos.length },
      region,
    };
  }

  if (pathname === "/search/videos") {
    const videos = videosFor("nobodynamed", Math.min(count, 20), now).map((item) =>
      vendorVideo(item as Record<string, unknown>),
    );
    return { videos, pagination: { has_more: true, cursor: "20", count: videos.length }, region };
  }

  const commentsMatch = /^\/videos\/([^/]+)\/comments$/.exec(pathname);
  if (commentsMatch) {
    const videoId = decodeURIComponent(commentsMatch[1]!);
    const body = mockTikTokResponse(
      "/api/comment/list/",
      new URLSearchParams({ aweme_id: videoId, count: String(count) }),
      now,
    ) as { comments: Record<string, unknown>[] };
    return {
      comments: body.comments.map((comment) => ({
        id: comment.cid,
        text: comment.text,
        aweme_id: comment.aweme_id,
        digg_count: comment.digg_count,
        reply_count: comment.reply_comment_total,
        create_time_utc: comment.create_time,
        liked_by_author: comment.is_author_digged,
        author: { unique_id: (comment.user as Record<string, unknown>).unique_id },
      })),
      pagination: { has_more: false, cursor: "0" },
      region,
    };
  }

  const videoMatch = /^\/videos\/([^/]+)$/.exec(pathname);
  if (videoMatch) {
    const item = videoFor(decodeURIComponent(videoMatch[1]!), "nobodynamed", now);
    return { video: vendorVideo(item as unknown as Record<string, unknown>), region };
  }

  const hashtagMatch = /^\/hashtags\/([^/]+)$/.exec(pathname);
  if (hashtagMatch) {
    const name = decodeURIComponent(hashtagMatch[1]!);
    const body = mockTikTokResponse(
      "/api/challenge/detail/",
      new URLSearchParams({ challengeName: name }),
      now,
    ) as { challengeInfo: { challenge: Record<string, unknown>; stats: Record<string, number> } };
    return {
      hashtag: {
        id: body.challengeInfo.challenge.id,
        title: name,
        video_count: body.challengeInfo.stats.videoCount,
        view_count: body.challengeInfo.stats.viewCount,
        url: `https://www.tiktok.com/tag/${name}`,
      },
      region,
    };
  }

  const musicMatch = /^\/music\/([^/]+)$/.exec(pathname);
  if (musicMatch) {
    const id = decodeURIComponent(musicMatch[1]!);
    const body = mockTikTokResponse(
      "/api/music/detail/",
      new URLSearchParams({ musicId: id }),
      now,
    ) as { musicInfo: { music: Record<string, unknown>; stats: Record<string, number> } };
    return {
      music: {
        id: body.musicInfo.music.id,
        title: body.musicInfo.music.title,
        author_name: body.musicInfo.music.authorName,
        duration: body.musicInfo.music.duration,
        video_count: body.musicInfo.stats.videoCount,
        user_count: body.musicInfo.stats.userCount,
      },
      region,
    };
  }

  if (pathname === "/trending/hashtags") {
    const creative = mockCreativeCenterResponse(
      "/hashtag/list",
      new URLSearchParams({ limit: String(count), country_code: region }),
      now,
    ) as { data: { list: Record<string, unknown>[] } };
    return {
      hashtags: creative.data.list.map((row) => ({
        name: row.hashtag_name,
        id: row.hashtag_id,
        rank: row.rank,
        rank_diff: row.rank_diff,
        country_code: row.country_code,
        industry: row.industry_name,
        publish_count: row.publish_cnt,
        view_count: row.video_views,
        user_count: row.user_count,
        is_new: row.is_new,
      })),
      region,
    };
  }

  if (pathname === "/trending/songs") {
    const creative = mockCreativeCenterResponse(
      "/sound/list",
      new URLSearchParams({ limit: String(count), country_code: region }),
      now,
    ) as { data: { list: Record<string, unknown>[] } };
    return {
      songs: creative.data.list.map((row) => ({
        title: row.title,
        id: row.music_id,
        author: row.author,
        rank: row.rank,
        rank_diff: row.rank_diff,
        country_code: row.country_code,
        duration: row.duration,
        user_count: row.user_cnt,
        is_new: row.is_new,
        link: row.link,
      })),
      region,
    };
  }

  return null;
}
