import type { Capability, ProviderName, SourceName } from "../../types";
import type { CallContext, CapabilityProvider } from "../types";
import { ProviderError } from "../../lib/errors";
import { optionalNumber, optionalString, requireString } from "../params";
import { normalizeTrendingHashtags, normalizeTrendingSounds } from "../../domain/trending";
import {
  emptyVideoStats,
  type AuthorSummary,
  type Comment,
  type HashtagStats,
  type MusicRef,
  type Profile,
  type SearchResult,
  type SoundStats,
  type TranscriptResult,
  type Video,
  type VideoStats,
} from "../../domain/models";

const DEFAULT_BASE_URL = "https://scrapebadger.com/v1/tiktok";

export interface VendorScraperConfig {
  name: ProviderName;
  source: SourceName;
  apiKey: string;
  costPerCallUSD: number;
  baseUrl?: string;
  /** Header the vendor expects for the key. */
  apiKeyHeader?: string;
}

/**
 * Paid fallback (spec section 2.1). Endpoint paths, parameters and response
 * fields below are taken from ScrapeBadger's published OpenAPI document
 * (docs.scrapebadger.com/openapi-tiktok.json, fetched 2026-09-13), so the
 * adapter matches the vendor contract rather than a guess.
 *
 * ScrapeBadger returns data already normalized into the same field names as
 * TikTok's Creative Center; we still run it through the domain mappers so both
 * paths produce one identical shape.
 */
export class ScrapeBadgerProvider implements CapabilityProvider {
  readonly name: ProviderName;
  readonly source: SourceName;
  readonly capabilities: readonly Capability[] = [
    "trending",
    "search",
    "profile",
    "profile_videos",
    "video_detail",
    "comments",
    "hashtag_stats",
    "hashtag_videos",
    "sound_stats",
    "transcript",
  ];

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiKeyHeader: string;
  readonly costPerCallUSD: number;

  constructor(config: VendorScraperConfig) {
    this.name = config.name;
    this.source = config.source;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKeyHeader = config.apiKeyHeader ?? "x-api-key";
    this.costPerCallUSD = config.costPerCallUSD;
  }

  async healthCheck(ctx: CallContext): Promise<boolean> {
    try {
      const body = await this.get(ctx, "/regions");
      return Boolean(body);
    } catch {
      return false;
    }
  }

  async execute(
    capability: Capability,
    params: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<unknown> {
    try {
      return await this.dispatch(capability, params, ctx);
    } catch (error) {
      // `get` does not know which capability it was serving; stamp the real one.
      if (error instanceof ProviderError && error.capability !== capability) {
        throw new ProviderError(error.provider, capability, error.message, {
          status: error.status,
          retryable: error.retryable,
          countsTowardBreaker: error.countsTowardBreaker,
          cause: error,
        });
      }
      throw error;
    }
  }

  private async dispatch(
    capability: Capability,
    params: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<unknown> {
    switch (capability) {
      case "trending": {
        const mode = optionalString(params, "mode") ?? "hashtags";
        const region = optionalString(params, "region") ?? ctx.region;
        const count = optionalNumber(params, "count", 20) ?? 20;
        const period = optionalNumber(params, "period", 7) ?? 7;

        if (mode === "hashtags") {
          const body = await this.get(ctx, "/trending/hashtags", { region, count, period });
          return normalizeTrendingHashtags(body, this.source, region);
        }
        if (mode === "songs" || mode === "sounds") {
          const body = await this.get(ctx, "/trending/songs", { region, count, period });
          return normalizeTrendingSounds(body, this.source, region);
        }
        if (mode === "videos") {
          const body = await this.get(ctx, "/trending/videos", { region, count });
          const rows = extractRows(body, "videos");
          return rows.map((row) => mapVideo(row, this.source));
        }
        throw new ProviderError(this.name, capability, `unknown trending mode "${mode}"`, {
          retryable: false,
          countsTowardBreaker: false,
        });
      }

      case "search": {
        const body = await this.get(ctx, "/search/videos", {
          query: requireString(this.name, capability, params, "query"),
          region: optionalString(params, "region") ?? ctx.region,
          count: optionalNumber(params, "count", 20),
          cursor: optionalString(params, "cursor"),
        });
        return mapVideoSearch(body, this.source);
      }

      case "profile": {
        const body = await this.get(ctx, `/users/${encodeURIComponent(stripAt(requireString(this.name, capability, params, "username")))}`, {
          region: optionalString(params, "region") ?? ctx.region,
        });
        const user = extractFirst(body, ["user"]);
        if (!user) this.invalidShape(capability);
        return mapProfile(user as Record<string, unknown>, this.source);
      }

      case "profile_videos": {
        const body = await this.get(
          ctx,
          `/users/${encodeURIComponent(stripAt(requireString(this.name, capability, params, "username")))}/videos`,
          {
            region: optionalString(params, "region") ?? ctx.region,
            count: optionalNumber(params, "count", 20),
            cursor: optionalString(params, "cursor"),
          },
        );
        return mapVideoSearch(body, this.source);
      }

      case "video_detail": {
        const body = await this.get(
          ctx,
          `/videos/${encodeURIComponent(requireString(this.name, capability, params, "video_id"))}`,
          { region: optionalString(params, "region") ?? ctx.region },
        );
        const video = extractFirst(body, ["video"]);
        if (!video) this.invalidShape(capability);
        return { video: mapVideo(video as Record<string, unknown>, this.source), transcript: null };
      }

      case "transcript": {
        const body = await this.get(
          ctx,
          `/videos/${encodeURIComponent(requireString(this.name, capability, params, "video_id"))}/transcript`,
          { region: optionalString(params, "region") ?? ctx.region },
        );
        return mapTranscript(body);
      }

      case "comments": {
        const videoId = requireString(this.name, capability, params, "video_id");
        const body = await this.get(ctx, `/videos/${encodeURIComponent(videoId)}/comments`, {
          region: optionalString(params, "region") ?? ctx.region,
          count: optionalNumber(params, "count", 20),
          cursor: optionalString(params, "cursor"),
        });
        const rows = extractRows(body, "comments");
        return {
          items: rows.map((row) => mapComment(row, videoId, this.source)),
          cursor: cursorOf(body),
          hasMore: hasMoreOf(body, rows.length),
          region: regionOf(body) ?? ctx.region,
          source: this.source,
        } satisfies SearchResult<Comment>;
      }

      case "hashtag_stats": {
        const name = stripHash(requireString(this.name, capability, params, "hashtag"));
        const body = await this.get(ctx, `/hashtags/${encodeURIComponent(name)}`, {
          region: optionalString(params, "region") ?? ctx.region,
        });
        const row = extractFirst(body, ["hashtag"]);
        if (!row) this.invalidShape(capability);
        return mapHashtag(row as Record<string, unknown>, this.source);
      }

      case "hashtag_videos": {
        const name = stripHash(requireString(this.name, capability, params, "hashtag"));
        const body = await this.get(ctx, `/hashtags/${encodeURIComponent(name)}/videos`, {
          region: optionalString(params, "region") ?? ctx.region,
          count: optionalNumber(params, "count", 20),
          cursor: optionalString(params, "cursor"),
        });
        return mapVideoSearch(body, this.source);
      }

      case "sound_stats": {
        const body = await this.get(
          ctx,
          `/music/${encodeURIComponent(requireString(this.name, capability, params, "sound_id"))}`,
          { region: optionalString(params, "region") ?? ctx.region },
        );
        const row = extractFirst(body, ["music"]);
        if (!row) this.invalidShape(capability);
        return mapSound(row as Record<string, unknown>, this.source);
      }

      default:
        throw new ProviderError(this.name, capability, `capability not supported: ${capability}`, {
          retryable: false,
          countsTowardBreaker: false,
        });
    }
  }

  private async get(
    ctx: CallContext,
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await ctx.fetch(url.toString(), {
        headers: { [this.apiKeyHeader]: this.apiKey, accept: "application/json" },
        signal: ctx.signal,
      });
    } catch (error) {
      throw new ProviderError(this.name, "trending", `network error: ${String(error)}`, {
        retryable: true,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(this.name, "trending", `scrapebadger auth failed (HTTP ${response.status})`, {
        status: response.status,
        retryable: false,
        countsTowardBreaker: false,
      });
    }
    if (response.status === 402) {
      throw new ProviderError(this.name, "trending", "scrapebadger credits exhausted (HTTP 402)", {
        status: 402,
        retryable: false,
        countsTowardBreaker: true,
      });
    }
    if (!response.ok) {
      const body = await safeText(response);
      throw new ProviderError(
        this.name,
        "trending",
        `scrapebadger HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        { status: response.status, retryable: response.status >= 500 || response.status === 429 },
      );
    }

    const json = (await response.json()) as Record<string, unknown>;
    return json;
  }

  private invalidShape(capability: Capability): never {
    throw new ProviderError(this.name, capability, "unexpected scrapebadger payload shape", {
      retryable: true,
    });
  }
}

// -- mapping ----------------------------------------------------------------

function stripAt(value: string): string {
  return value.replace(/^@/, "");
}

function stripHash(value: string): string {
  return value.replace(/^#/, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    : [];
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

function extractRows(body: unknown, ...keys: string[]): Record<string, unknown>[] {
  const root = asRecord(body);
  if (!root) return [];
  for (const key of keys) {
    const rows = asRows(root[key]);
    if (rows.length > 0) return rows;
  }
  return [];
}

function extractFirst(body: unknown, keys: string[]): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) return null;
  for (const key of keys) {
    const value = asRecord(root[key]);
    if (value) return value;
  }
  return null;
}

function cursorOf(body: unknown): string | null {
  const pagination = asRecord(asRecord(body)?.pagination);
  return str(pagination?.cursor) ?? str(asRecord(body)?.cursor);
}

function hasMoreOf(body: unknown, fallbackCount: number): boolean {
  const pagination = asRecord(asRecord(body)?.pagination);
  const explicit = pagination?.has_more ?? asRecord(body)?.has_more;
  if (typeof explicit === "boolean") return explicit;
  return fallbackCount > 0;
}

function regionOf(body: unknown): string | null {
  return str(asRecord(body)?.region);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function mapAuthor(row: Record<string, unknown> | null): AuthorSummary | null {
  if (!row) return null;
  return {
    id: str(row.id ?? row.uid),
    uniqueId: str(row.unique_id ?? row.uniqueId),
    nickname: str(row.nickname),
    verified: bool(row.verified),
    avatarUrl: str(row.avatar_thumb ?? row.avatar_medium ?? row.avatar_larger),
    signature: str(row.signature),
    followerCount: num(row.follower_count),
    videoCount: num(row.video_count),
    region: str(row.region ?? row.account_region),
  };
}

export function mapMusic(row: Record<string, unknown> | null): MusicRef | null {
  if (!row) return null;
  const duration = num(row.duration);
  return {
    id: str(row.id ?? row.mid),
    title: str(row.title),
    author: str(row.author_name ?? row.author),
    original: bool(row.original),
    durationSeconds: duration === null ? null : duration,
    videoCount: num(row.video_count),
    userCount: num(row.user_count),
    playUrl: str(row.play_url),
  };
}

export function mapVideo(row: Record<string, unknown>, source: Video["source"]): Video {
  const stats = asRecord(row.stats) ?? {};
  const video = asRecord(row.video) ?? {};
  const duration = num(video.duration ?? row.duration);
  return {
    id: str(row.id ?? row.aweme_id) ?? "",
    description: str(row.description ?? row.desc),
    createdAt: num(row.create_time_utc ?? row.create_time),
    url: str(row.url),
    shareUrl: str(row.share_url),
    durationSeconds: duration,
    coverUrl: str(video.cover ?? video.origin_cover),
    region: str(row.region),
    author: mapAuthor(asRecord(row.author)),
    music: mapMusic(asRecord(row.music)),
    stats: {
      playCount: num(stats.play_count),
      likeCount: num(stats.digg_count ?? stats.like_count),
      commentCount: num(stats.comment_count),
      shareCount: num(stats.share_count),
      collectCount: num(stats.collect_count),
    } satisfies VideoStats,
    hashtags: asRows(row.challenges)
      .map((challenge) => str(challenge.title))
      .filter((name): name is string => Boolean(name))
      .concat(
        asRows(row.hashtags)
          .map((tag) => str(tag.name ?? tag.title ?? tag))
          .filter((name): name is string => Boolean(name)),
      ),
    isSlideshow: bool(row.is_slideshow),
    source,
  };
}

export function mapVideoSearch(body: unknown, source: Video["source"]): SearchResult<Video> {
  const rows = extractRows(body, "videos", "items");
  return {
    items: rows.map((row) => mapVideo(row, source)),
    cursor: cursorOf(body),
    hasMore: hasMoreOf(body, rows.length),
    region: regionOf(body),
    source,
  };
}

export function mapProfile(row: Record<string, unknown>, source: Profile["source"]): Profile {
  const stats = asRecord(row.stats) ?? {};
  return {
    id: str(row.id),
    uniqueId: str(row.unique_id),
    nickname: str(row.nickname),
    signature: str(row.signature),
    verified: bool(row.verified),
    privateAccount: bool(row.private_account),
    avatarUrl: str(row.avatar_larger ?? row.avatar_medium ?? row.avatar_thumb),
    region: str(row.region),
    profileUrl: str(row.profile_url),
    stats: {
      followerCount: num(stats.follower_count),
      followingCount: num(stats.following_count),
      heartCount: num(stats.heart_count),
      videoCount: num(stats.video_count),
    },
    source,
  };
}

export function mapComment(
  row: Record<string, unknown>,
  videoId: string | null,
  source: Comment["source"],
): Comment {
  return {
    id: str(row.id) ?? "",
    videoId: str(row.aweme_id) ?? videoId,
    parentCommentId: str(row.parent_comment_id),
    text: str(row.text) ?? "",
    likeCount: num(row.digg_count),
    replyCount: num(row.reply_count),
    createdAt: num(row.create_time_utc ?? row.create_time),
    likedByAuthor: bool(row.liked_by_author),
    author: mapAuthor(asRecord(row.author)),
    source,
  };
}

export function mapHashtag(row: Record<string, unknown>, source: HashtagStats["source"]): HashtagStats {
  return {
    id: str(row.id),
    name: str(row.title ?? row.name) ?? "",
    description: str(row.description),
    videoCount: num(row.video_count),
    viewCount: num(row.view_count),
    url: str(row.url),
    source,
  };
}

export function mapSound(row: Record<string, unknown>, source: SoundStats["source"]): SoundStats {
  const duration = num(row.duration);
  return {
    id: str(row.id ?? row.mid),
    title: str(row.title),
    author: str(row.author_name ?? row.author ?? row.owner_nickname),
    original: bool(row.original),
    durationSeconds: duration === null ? null : duration,
    videoCount: num(row.video_count),
    userCount: num(row.user_count),
    coverUrl: str(row.cover_medium ?? row.cover_thumb ?? row.cover_large),
    playUrl: str(row.play_url),
    source,
  };
}

export function mapTranscript(body: unknown): TranscriptResult | null {
  const root = asRecord(body);
  if (!root) return null;
  const direct = str(root.voice_to_text ?? root.transcript ?? root.text);
  if (direct && direct.trim() !== "") {
    return { text: direct, language: str(root.language), source: "scrapebadger" };
  }
  const tracks = asRows(root.subtitles ?? root.tracks);
  const first = tracks[0];
  const text = str(first?.text ?? first?.content);
  if (text) {
    return { text, language: str(first?.language_code ?? first?.language), source: "scrapebadger" };
  }
  return null;
}

export { emptyVideoStats };
