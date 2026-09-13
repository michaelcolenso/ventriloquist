/**
 * Trending hashtags/sounds arrive from two different public shapes:
 *
 *  - TikTok Creative Center:  { data: { list: [ { hashtag_name, video_views, ... } ] } }
 *  - ScrapeBadger:            { hashtags: [ { name, view_count, ... } ], region }
 *
 * Both are close cousins (ScrapeBadger's camel/snake naming mirrors Creative
 * Center), so one defensive mapper covers both.
 */

import type { TrendingHashtag, TrendingSound } from "./models";
import type { SourceName } from "../types";

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
  return value === true || value === 1 || value === "1" || value === "true";
}

/** Find the row list whether it is `data.list`, `hashtags`, `songs`, or `list`. */
function findRows(payload: unknown, ...keys: string[]): Json[] {
  const root = asObject(payload);
  if (!root) return [];
  const candidates: unknown[] = [];
  for (const key of keys) candidates.push(root[key]);
  const data = asObject(root.data);
  if (data) {
    for (const key of [...keys, "list"]) candidates.push(data[key]);
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(asObject).filter((v): v is Json => v !== null);
    }
  }
  return [];
}

export function normalizeTrendingHashtags(
  payload: unknown,
  source: SourceName,
  fallbackRegion: string | null = null,
): TrendingHashtag[] {
  return findRows(payload, "hashtags", "challenges", "list").map((row) => {
    const name = str(row.hashtag_name ?? row.hashtagName ?? row.name ?? row.title) ?? "";
    const countryCode = str(row.country_code ?? row.countryCode) ?? fallbackRegion;
    return {
      name: name.replace(/^#/, ""),
      id: str(row.hashtag_id ?? row.hashtagId ?? row.id),
      rank: num(row.rank),
      rankDiff: num(row.rank_diff ?? row.rankDiff),
      countryCode,
      industry: str(row.industry_name ?? row.industry ?? row.industryName),
      publishCount: num(row.publish_cnt ?? row.publish_count ?? row.publishCount),
      viewCount: num(row.video_views ?? row.view_count ?? row.viewCount),
      userCount: num(row.user_count ?? row.userCount),
      isPromoted: bool(row.is_promoted ?? row.isPromoted),
      isNew: bool(row.is_new ?? row.isNew),
      url:
        str(row.url) ??
        (name
          ? `https://www.tiktok.com/tag/${encodeURIComponent(name.replace(/^#/, ""))}`
          : null),
      source,
    };
  });
}

export function normalizeTrendingSounds(
  payload: unknown,
  source: SourceName,
  fallbackRegion: string | null = null,
): TrendingSound[] {
  return findRows(payload, "songs", "sounds", "music", "list").map((row) => {
    const duration = num(row.duration);
    return {
      id: str(row.music_id ?? row.musicId ?? row.song_id ?? row.id),
      title: str(row.title ?? row.song_name ?? row.name),
      author: str(row.author ?? row.author_name ?? row.authorName),
      rank: num(row.rank),
      rankDiff: num(row.rank_diff ?? row.rankDiff),
      countryCode: str(row.country_code ?? row.countryCode) ?? fallbackRegion,
      durationSeconds: duration === null ? null : duration > 1000 ? duration / 1000 : duration,
      userCount: num(row.user_cnt ?? row.user_count ?? row.userCount),
      coverUrl: str(row.cover_url ?? row.cover ?? row.coverUrl),
      playUrl: str(row.play_url ?? row.playUrl),
      isNew: bool(row.is_new ?? row.isNew),
      link: str(row.link ?? row.url),
      source,
    };
  });
}

export const __test__ = { findRows, num, str, bool };
