/**
 * Mapping from TikTok's own web API payloads (the responses the signer path
 * fetches) into Ventriloquist's domain model.
 *
 * These payloads are private and shift without notice, so every accessor is
 * defensive: a missing field becomes null, never a crash. Shape drift shows up
 * as null-filled results, which the circuit breaker and canary catch.
 */

import type {
  AuthorSummary,
  Comment,
  HashtagStats,
  MusicRef,
  Profile,
  SearchResult,
  SoundStats,
  TranscriptResult,
  Video,
  VideoStats,
} from "./models";
import { emptyVideoStats } from "./models";

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/** TikTok wraps image/URL fields as `{ url_list: [...], uri }`. */
function urlFrom(value: unknown): string | null {
  const obj = asObject(value);
  if (!obj) return str(value);
  const list = asArray(obj.url_list);
  const first = list.find((entry) => typeof entry === "string");
  return str(first) ?? str(obj.uri);
}

/** Endpoint payloads differ: some return `item_list`, some `aweme_list`, some `data`. */
export function pickItemList(payload: unknown): Json[] {
  const root = asObject(payload);
  if (!root) return [];
  for (const key of ["item_list", "aweme_list", "items", "data", "videos"]) {
    const candidate = root[key];
    if (Array.isArray(candidate)) return candidate.map(asObject).filter((v): v is Json => v !== null);
    const nested = asObject(candidate);
    if (nested) {
      for (const inner of ["item_list", "aweme_list", "items", "videos"]) {
        if (Array.isArray(nested[inner])) {
          return (nested[inner] as unknown[]).map(asObject).filter((v): v is Json => v !== null);
        }
      }
    }
  }
  return [];
}

export function normalizeAuthor(raw: unknown): AuthorSummary | null {
  const author = asObject(raw);
  if (!author) return null;
  const stats = asObject(author.stats) ?? asObject(author);
  return {
    id: str(author.uid ?? author.id),
    uniqueId: str(author.unique_id ?? author.uniqueId),
    nickname: str(author.nickname),
    verified: bool(author.verified),
    avatarUrl: urlFrom(author.avatar_thumb ?? author.avatar_medium ?? author.avatar_larger),
    signature: str(author.signature),
    followerCount: num(stats?.follower_count ?? stats?.followerCount),
    videoCount: num(stats?.video_count ?? stats?.videoCount),
    region: str(author.region),
  };
}

export function normalizeMusic(raw: unknown): MusicRef | null {
  const music = asObject(raw);
  if (!music) return null;
  const stats = asObject(music.stats) ?? music;
  return {
    id: str(music.id ?? music.mid),
    title: str(music.title),
    author: str(music.author ?? music.authorName ?? music.owner_nickname),
    original: bool(music.original),
    durationSeconds: num(music.duration) !== null ? (num(music.duration) as number) / 1000 : null,
    videoCount: num(stats.video_count ?? stats.videoCount),
    userCount: num(stats.user_count ?? stats.userCount),
    playUrl: urlFrom(music.play_url ?? music.playUrl),
  };
}

export function normalizeVideoStats(raw: unknown): VideoStats {
  const stats = asObject(raw);
  if (!stats) return emptyVideoStats();
  return {
    playCount: num(stats.play_count ?? stats.playCount),
    likeCount: num(stats.digg_count ?? stats.like_count ?? stats.diggCount),
    commentCount: num(stats.comment_count ?? stats.commentCount),
    shareCount: num(stats.share_count ?? stats.shareCount),
    collectCount: num(stats.collect_count ?? stats.collectCount),
  };
}

export function extractHashtags(item: Json): string[] {
  const tags = new Set<string>();
  for (const entry of asArray(item.text_extra)) {
    const obj = asObject(entry);
    const name = str(obj?.hashtag_name ?? obj?.hashtagName);
    if (name) tags.add(name.replace(/^#/, ""));
  }
  for (const entry of asArray(item.challenges)) {
    const obj = asObject(entry);
    const name = str(obj?.title ?? obj?.challenge_name);
    if (name) tags.add(name.replace(/^#/, ""));
  }
  for (const entry of asArray(item.hashtags)) {
    const obj = asObject(entry);
    const name = str(obj?.name ?? obj?.title ?? entry);
    if (name) tags.add(name.replace(/^#/, ""));
  }
  return [...tags];
}

export function normalizeVideo(raw: unknown): Video | null {
  const item = asObject(raw);
  if (!item) return null;
  const id = str(item.aweme_id ?? item.id ?? item.item_id);
  if (!id) return null;
  const video = asObject(item.video);
  const durationMs = num(video?.duration ?? item.duration);
  const createTime = num(item.create_time ?? item.createTime);
  const uniqueId = str((asObject(item.author) ?? {})["unique_id"]);
  return {
    id,
    description: str(item.desc ?? item.description),
    createdAt: createTime,
    url:
      str(item.url) ??
      (uniqueId ? `https://www.tiktok.com/@${uniqueId}/video/${id}` : null),
    shareUrl: str(item.share_url ?? item.shareUrl),
    durationSeconds: durationMs === null ? null : Math.round((durationMs / 1000) * 1000) / 1000,
    coverUrl: urlFrom(video?.cover ?? video?.origin_cover),
    region: str(item.region),
    author: normalizeAuthor(item.author),
    music: normalizeMusic(item.music),
    stats: normalizeVideoStats(item.stats ?? item.statistics),
    hashtags: extractHashtags(item),
    isSlideshow: bool(item.is_slideshow) || asArray(item.image_urls ?? item.image_post_info).length > 0,
    source: "signer",
  };
}

export function normalizeSearchResult(
  payload: unknown,
  region: string | null,
): SearchResult<Video> {
  const root = asObject(payload);
  const cursor =
    str(root?.cursor) ??
    str(asObject(root?.pagination)?.cursor) ??
    str(root?.max_cursor) ??
    null;
  const hasMore =
    bool(root?.has_more) ||
    bool(asObject(root?.pagination)?.has_more) ||
    asArray(root?.item_list).length > 0;
  return {
    items: pickItemList(payload)
      .map(normalizeVideo)
      .filter((v): v is Video => v !== null),
    cursor,
    hasMore,
    region,
    source: "signer",
  };
}

export function normalizeProfile(payload: unknown): Profile | null {
  const root = asObject(payload);
  if (!root) return null;
  const info = asObject(root.userInfo) ?? asObject(root.user_info) ?? root;
  const user = asObject(info.user) ?? asObject(info.user_info) ?? info;
  if (!user) return null;
  const stats = asObject(info.stats) ?? asObject(user.stats) ?? user;
  const uniqueId = str(user.uniqueId ?? user.unique_id);
  if (!uniqueId && !user.id && !user.uid) return null;
  return {
    id: str(user.id ?? user.uid),
    uniqueId,
    nickname: str(user.nickname),
    signature: str(user.signature),
    verified: bool(user.verified),
    privateAccount: bool(user.privateAccount ?? user.private_account ?? user.secret),
    avatarUrl: urlFrom(user.avatarLarger ?? user.avatar_larger ?? user.avatarMedium),
    region: str(user.region),
    profileUrl: uniqueId ? `https://www.tiktok.com/@${uniqueId}` : null,
    stats: {
      followerCount: num(stats.followerCount ?? stats.follower_count),
      followingCount: num(stats.followingCount ?? stats.following_count),
      heartCount: num(stats.heartCount ?? stats.heart ?? stats.heart_count),
      videoCount: num(stats.videoCount ?? stats.video_count),
    },
    source: "signer",
  };
}

export function normalizeComment(raw: unknown, videoId: string | null): Comment | null {
  const comment = asObject(raw);
  if (!comment) return null;
  const id = str(comment.cid ?? comment.id ?? comment.comment_id);
  if (!id) return null;
  return {
    id,
    videoId: str(comment.aweme_id) ?? videoId,
    parentCommentId: str(comment.parent_comment_id ?? comment.reply_id),
    text: str(comment.text) ?? "",
    likeCount: num(comment.digg_count ?? comment.like_count),
    replyCount: num(comment.reply_comment_total ?? comment.reply_count),
    createdAt: num(comment.create_time ?? comment.createTime),
    likedByAuthor: bool(comment.is_author_digged ?? comment.liked_by_author),
    author: normalizeAuthor(comment.user ?? comment.author),
    source: "signer",
  };
}

export function normalizeComments(
  payload: unknown,
  videoId: string | null,
): SearchResult<Comment> {
  const root = asObject(payload);
  const rows = asArray(root?.comments ?? root?.comment_list ?? root?.data);
  const cursor = str(root?.cursor) ?? str(root?.max_cursor) ?? null;
  return {
    items: rows
      .map((row) => normalizeComment(row, videoId))
      .filter((c): c is Comment => c !== null),
    cursor,
    hasMore: bool(root?.has_more) || asArray(root?.comments).length > 0,
    region: str(root?.region),
    source: "signer",
  };
}

export function normalizeHashtag(payload: unknown): HashtagStats | null {
  const root = asObject(payload);
  if (!root) return null;
  const info = asObject(root.challengeInfo) ?? asObject(root.challenge_info) ?? root;
  const challenge = asObject(info.challenge) ?? info;
  if (!challenge) return null;
  const stats = asObject(info.stats) ?? asObject(challenge.stats) ?? challenge;
  const name = str(challenge.challengeName ?? challenge.title ?? challenge.name);
  if (!name) return null;
  return {
    id: str(challenge.id ?? challenge.challenge_id),
    name: name.replace(/^#/, ""),
    description: str(challenge.desc ?? challenge.description),
    videoCount: num(stats.videoCount ?? stats.video_count),
    viewCount: num(stats.viewCount ?? stats.view_count),
    url: `https://www.tiktok.com/tag/${encodeURIComponent(name.replace(/^#/, ""))}`,
    source: "signer",
  };
}

export function normalizeSound(payload: unknown): SoundStats | null {
  const root = asObject(payload);
  if (!root) return null;
  const info = asObject(root.musicInfo) ?? asObject(root.music_info) ?? root;
  const music = asObject(info.music) ?? info;
  if (!music) return null;
  const stats = asObject(info.stats) ?? asObject(music.stats) ?? music;
  const durationMs = num(music.duration);
  return {
    id: str(music.id ?? music.mid),
    title: str(music.title),
    author: str(music.authorName ?? music.author_name ?? music.author),
    original: bool(music.original),
    durationSeconds: durationMs === null ? null : durationMs / 1000,
    videoCount: num(stats.videoCount ?? stats.video_count),
    userCount: num(stats.userCount ?? stats.user_count),
    coverUrl: urlFrom(music.coverMedium ?? music.cover_medium ?? music.coverLarge),
    playUrl: urlFrom(music.playUrl ?? music.play_url),
    source: "signer",
  };
}

/** TikTok exposes caption tracks and, for some videos, an ASR text blob. */
export function extractTranscript(payload: unknown): TranscriptResult | null {
  const root = asObject(payload);
  if (!root) return null;
  const direct = str(root.voice_to_text ?? root.voiceToText ?? root.transcript);
  if (direct && direct.trim() !== "") {
    return { text: direct, language: str(root.text_language), source: "tiktok_caption" };
  }
  const subtitles = asArray(root.subtitles ?? asObject(root.video)?.subtitles);
  const first = asObject(subtitles[0]);
  const text = str(first?.text ?? first?.content);
  if (text) {
    return {
      text,
      language: str(first?.language_code ?? first?.language),
      source: "tiktok_caption",
    };
  }
  return null;
}

export const __test__ = { asObject, num, str, urlFrom, bool };
