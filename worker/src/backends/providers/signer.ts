import type { Capability } from "../../types";
import type { CallContext, CapabilityProvider } from "../types";
import { ProviderError } from "../../lib/errors";
import { optionalNumber, optionalString, requireString } from "../params";
import { SignerClient } from "../signerClient";
import {
  extractTranscript,
  normalizeComments,
  normalizeHashtag,
  normalizeProfile,
  normalizeSearchResult,
  normalizeSound,
  normalizeVideo,
} from "../../domain/tiktok-web";
import type { SearchResult, Video } from "../../domain/models";

const WEB_BASE = "https://www.tiktok.com";

/**
 * Self-hosted path: ask the signer gateway for a signed URL, then fetch it.
 *
 * The Worker does the fetching (not the gateway) so the request can live in the
 * same place as normalization and snapshotting. If TikTok ever blocks
 * Cloudflare egress outright, swap `execute` to call gateway semantic
 * endpoints instead - the router contract does not change.
 */
export class SignerProvider implements CapabilityProvider {
  readonly name = "signer" as const;
  readonly source = "signer" as const;
  readonly costPerCallUSD = 0;
  readonly capabilities: readonly Capability[] = [
    "search",
    "profile",
    "profile_videos",
    "video_detail",
    "comments",
    "hashtag_stats",
    "hashtag_videos",
    "sound_stats",
    "transcript",
    "download",
  ];

  constructor(private readonly client: SignerClient) {}

  async healthCheck(ctx: CallContext): Promise<boolean> {
    const health = await this.client.health(ctx.signal);
    return health.ok;
  }

  async execute(
    capability: Capability,
    params: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<unknown> {
    switch (capability) {
      case "search": {
        const payload = await this.getJson(
          capability,
          ctx,
          "/api/search/item/full/",
          {
            keyword: requireString(this.name, capability, params, "query"),
            count: optionalNumber(params, "count", 20),
            cursor: optionalString(params, "cursor"),
            search_source: "normal_search",
            region: ctx.region,
          },
        );
        const result = normalizeSearchResult(payload, ctx.region) as SearchResult<Video>;
        return this.tagSource(result);
      }

      case "profile": {
        const payload = await this.getJson(capability, ctx, "/api/user/detail/", {
          uniqueId: requireString(this.name, capability, params, "username").replace(/^@/, ""),
        });
        const profile = normalizeProfile(payload);
        if (!profile) this.invalidShape(capability, "user detail");
        return profile;
      }

      case "profile_videos": {
        const username = requireString(this.name, capability, params, "username").replace(/^@/, "");
        const secUid =
          optionalString(params, "sec_uid") ??
          (await this.resolveSecUid(capability, ctx, username));
        const payload = await this.getJson(capability, ctx, "/api/post/item_list/", {
          secUid,
          count: optionalNumber(params, "count", 20),
          cursor: optionalString(params, "cursor"),
        });
        const result = normalizeSearchResult(payload, ctx.region) as SearchResult<Video>;
        return this.tagSource(result);
      }

      case "video_detail": {
        const payload = await this.getJson(capability, ctx, "/api/item/detail/", {
          itemId: requireString(this.name, capability, params, "video_id"),
        });
        return this.videoFromItemDetail(capability, payload);
      }

      case "transcript": {
        const payload = await this.getJson(capability, ctx, "/api/item/detail/", {
          itemId: requireString(this.name, capability, params, "video_id"),
        });
        const item = this.videoFromItemDetail(capability, payload);
        return (
          extractTranscript(
            (payload as Record<string, unknown>)?.itemInfo ??
              (payload as Record<string, unknown>)?.item_info ??
              (payload as Record<string, unknown>)?.item,
          ) ?? item.transcript
        );
      }

      case "comments": {
        const videoId = requireString(this.name, capability, params, "video_id");
        const payload = await this.getJson(capability, ctx, "/api/comment/list/", {
          aweme_id: videoId,
          count: optionalNumber(params, "count", 20),
          cursor: optionalString(params, "cursor"),
          text_extra: "",
        });
        const result = normalizeComments(payload, videoId);
        return { ...result, source: this.source };
      }

      case "hashtag_stats": {
        const name = requireString(this.name, capability, params, "hashtag").replace(/^#/, "");
        const payload = await this.getJson(capability, ctx, "/api/challenge/detail/", {
          challengeName: name,
        });
        const hashtag = normalizeHashtag(payload);
        if (!hashtag) this.invalidShape(capability, "challenge detail");
        return hashtag;
      }

      case "hashtag_videos": {
        const name = requireString(this.name, capability, params, "hashtag").replace(/^#/, "");
        const challengeId =
          optionalString(params, "hashtag_id") ?? (await this.resolveChallengeId(capability, ctx, name));
        const payload = await this.getJson(capability, ctx, "/api/challenge/aweme/", {
          challengeID: challengeId,
          count: optionalNumber(params, "count", 20),
          cursor: optionalString(params, "cursor"),
          sort_type: optionalNumber(params, "sort_type", 0),
        });
        const result = normalizeSearchResult(payload, ctx.region) as SearchResult<Video>;
        return this.tagSource(result);
      }

      case "sound_stats": {
        const payload = await this.getJson(capability, ctx, "/api/music/detail/", {
          musicId: requireString(this.name, capability, params, "sound_id"),
        });
        const sound = normalizeSound(payload);
        if (!sound) this.invalidShape(capability, "music detail");
        return sound;
      }

      case "download": {
        const payload = await this.getJson(capability, ctx, "/api/item/detail/", {
          itemId: requireString(this.name, capability, params, "video_id"),
        });
        const video = normalizeVideo(
          (payload as Record<string, unknown>)?.itemInfo ??
            (payload as Record<string, unknown>)?.item_info ??
            (payload as Record<string, unknown>)?.item,
        );
        if (!video) this.invalidShape(capability, "item detail");
        const raw = payload as Record<string, unknown>;
        const item = (raw.itemInfo ?? raw.item_info ?? raw.item ?? {}) as Record<string, unknown>;
        const media = (item.video ?? {}) as Record<string, unknown>;
        return {
          videoId: video.id,
          coverUrl: video.coverUrl,
          playUrl: urlList(media.play_addr ?? media.playAddr)[0] ?? null,
          downloadUrl: urlList(media.download_addr ?? media.downloadAddr)[0] ?? null,
          noWatermarkUrl: urlList(media.download_no_watermark_addr)[0] ?? null,
        };
      }

      default:
        throw new ProviderError(this.name, capability, `capability not supported: ${capability}`, {
          retryable: false,
          countsTowardBreaker: false,
        });
    }
  }

  // -- internals ------------------------------------------------------------

  private tagSource<T extends { source: unknown }>(result: T): T {
    return { ...result, source: this.source };
  }

  private videoFromItemDetail(capability: Capability, payload: unknown) {
    const raw = (payload ?? {}) as Record<string, unknown>;
    const item = raw.itemInfo ?? raw.item_info ?? raw.item;
    const video = normalizeVideo(item);
    if (!video) this.invalidShape(capability, "item detail");
    return {
      video: { ...video, source: this.source },
      transcript: extractTranscript(item),
    };
  }

  private async resolveSecUid(
    capability: Capability,
    ctx: CallContext,
    username: string,
  ): Promise<string> {
    const payload = await this.getJson(capability, ctx, "/api/user/detail/", {
      uniqueId: username,
    });
    const raw = (payload ?? {}) as Record<string, unknown>;
    const info = (raw.userInfo ?? raw.user_info ?? raw) as Record<string, unknown>;
    const user = (info.user ?? info.user_info ?? info) as Record<string, unknown>;
    const resolved = user.secUid ?? user.sec_uid;
    if (typeof resolved !== "string" || resolved === "") {
      throw new ProviderError(this.name, capability, `could not resolve secUid for @${username}`, {
        retryable: false,
        countsTowardBreaker: false,
      });
    }
    return resolved;
  }

  private async resolveChallengeId(
    capability: Capability,
    ctx: CallContext,
    name: string,
  ): Promise<string> {
    const payload = await this.getJson(capability, ctx, "/api/challenge/detail/", {
      challengeName: name,
    });
    const hashtag = normalizeHashtag(payload);
    if (!hashtag?.id) {
      throw new ProviderError(this.name, capability, `could not resolve hashtag id for #${name}`, {
        retryable: false,
        countsTowardBreaker: false,
      });
    }
    return hashtag.id;
  }

  /** Sign, fetch, parse. Errors are classified so only real outages trip the breaker. */
  private async getJson(
    capability: Capability,
    ctx: CallContext,
    path: string,
    query: Record<string, string | number | undefined>,
    attempt = 0,
  ): Promise<unknown> {
    const url = new URL(path, WEB_BASE);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const signed = await this.client.sign(url.toString(), {
      region: ctx.region,
      signal: ctx.signal,
    });

    // The gateway could not sign, so it made the request itself from inside the
    // warmed page. The body is the response; parse it directly.
    if (signed.mode === "in_page") {
      if ((signed.status === 403 || signed.status === 429) && attempt === 0) {
        return this.getJson(capability, ctx, path, query, attempt + 1);
      }
      if (signed.status >= 400) {
        throw new ProviderError(
          this.name,
          capability,
          `tiktok returned HTTP ${signed.status} (gateway in-page fetch, strategy ${signed.strategy})`,
          {
            status: signed.status,
            retryable: signed.status >= 500 || signed.status === 429,
            countsTowardBreaker: signed.status >= 500 || signed.status === 429,
          },
        );
      }
      return this.parseBody(capability, signed.body);
    }

    let response: Response;
    try {
      response = await ctx.fetch(signed.url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9",
          referer: `${WEB_BASE}/`,
          ...signed.headers,
        },
        signal: ctx.signal,
      });
    } catch (error) {
      throw new ProviderError(this.name, capability, `fetch failed: ${String(error)}`, {
        retryable: true,
      });
    }

    // 403/429 from TikTok is the signature going stale: refetch once with a
    // fresh signature before failing over, because a stale msToken is the
    // single most common (and cheapest) signer failure.
    if ((response.status === 403 || response.status === 429) && attempt === 0) {
      return this.getJson(capability, ctx, path, query, attempt + 1);
    }

    if (!response.ok) {
      throw new ProviderError(
        this.name,
        capability,
        `tiktok returned HTTP ${response.status}`,
        {
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
          countsTowardBreaker: response.status >= 500 || response.status === 429,
        },
      );
    }

    const text = await response.text();
    return this.parseBody(capability, text);
  }

  private parseBody(capability: Capability, text: string): unknown {
    if (text.trim() === "") {
      throw new ProviderError(this.name, capability, "tiktok returned an empty body", {
        retryable: true,
      });
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const statusCode = parsed.status_code ?? parsed.statusCode;
      if (typeof statusCode === "number" && statusCode !== 0 && statusCode !== 200) {
        throw new ProviderError(
          this.name,
          capability,
          `tiktok status_code ${statusCode}${parsed.status_msg ? `: ${String(parsed.status_msg)}` : ""}`,
          { retryable: statusCode >= 1000, countsTowardBreaker: statusCode >= 1000 },
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(this.name, capability, "tiktok returned non-JSON body", {
        retryable: true,
        cause: error,
      });
    }
  }

  private invalidShape(capability: Capability, what: string): never {
    throw new ProviderError(this.name, capability, `unexpected ${what} payload shape`, {
      retryable: true,
    });
  }
}

function urlList(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const list = (value as Record<string, unknown>).url_list ?? (value as Record<string, unknown>).urlList;
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
}
