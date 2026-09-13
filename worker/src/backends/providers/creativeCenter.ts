import type { Capability } from "../../types";
import type { CallContext, CapabilityProvider } from "../types";
import { ProviderError } from "../../lib/errors";
import { optionalNumber, optionalString } from "../params";
import { normalizeTrendingHashtags, normalizeTrendingSounds } from "../../domain/trending";
import { mapVideo } from "./scrapebadger";

export const DEFAULT_BASE_URL = "https://ads.tiktok.com/creative_radar_api/v1/popular_trend";

const BROWSER_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  referer: "https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  lang: "en",
};

/**
 * Trending hashtags/sounds/videos from TikTok Creative Center's public endpoints.
 *
 * This is the free primary for the `trending` capability (spec capability 2):
 * Creative Center is public and unauthenticated, so it costs nothing and needs
 * no signer. It is also brittle (it occasionally returns `code: 40101, no
 * permission` without the right referer/region combination), which is exactly
 * why the vendored fallback sits behind it.
 */
export class CreativeCenterProvider implements CapabilityProvider {
  readonly name = "creative_center" as const;
  readonly source = "creative_center" as const;
  readonly capabilities: readonly Capability[] = ["trending"];
  readonly costPerCallUSD = 0;

  constructor(private readonly baseUrl: string = DEFAULT_BASE_URL) {}

  async healthCheck(ctx: CallContext): Promise<boolean> {
    try {
      const body = await this.fetchList(ctx, "/hashtag/list", {
        page: 1,
        limit: 1,
        period: 7,
        country_code: ctx.region,
        sort_by: "vv",
      });
      return body.length > 0;
    } catch {
      return false;
    }
  }

  async execute(
    capability: Capability,
    params: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<unknown> {
    if (capability !== "trending") {
      throw new ProviderError(this.name, capability, `capability not supported: ${capability}`, {
        retryable: false,
        countsTowardBreaker: false,
      });
    }

    const mode = optionalString(params, "mode") ?? "hashtags";
    const region = optionalString(params, "region") ?? ctx.region;
    const count = Math.min(optionalNumber(params, "count", 20) ?? 20, 200);
    const period = optionalNumber(params, "period", 7) ?? 7;
    const page = optionalNumber(params, "page", 1) ?? 1;
    const query = {
      page,
      limit: count,
      period,
      country_code: region,
      sort_by: optionalString(params, "sort_by") ?? "vv",
    };

    if (mode === "hashtags") {
      const body = await this.fetchJson(ctx, "/hashtag/list", query);
      const rows = normalizeTrendingHashtags(body, this.source, region);
      const filterText = optionalString(params, "q") ?? optionalString(params, "keyword");
      return filterText
        ? rows.filter((row) => row.name.toLowerCase().includes(filterText.toLowerCase()))
        : rows;
    }

    if (mode === "songs" || mode === "sounds") {
      const body = await this.fetchJson(ctx, "/sound/list", query);
      const rows = normalizeTrendingSounds(body, this.source, region);
      const filterText = optionalString(params, "q");
      return filterText
        ? rows.filter((row) => (row.title ?? "").toLowerCase().includes(filterText.toLowerCase()))
        : rows;
    }

    if (mode === "videos") {
      const body = await this.fetchJson(ctx, "/video/list", {
        page,
        limit: count,
        period,
        country_code: region,
        sort_by: optionalString(params, "sort_by") ?? "vv",
      });
      return this.extractList(body).map((row) => mapVideo(row, this.source));
    }

    throw new ProviderError(this.name, capability, `unknown trending mode "${mode}"`, {
      retryable: false,
      countsTowardBreaker: false,
    });
  }

  private async fetchList(
    ctx: CallContext,
    path: string,
    query: Record<string, string | number>,
  ): Promise<Record<string, unknown>[]> {
    return this.extractList(await this.fetchJson(ctx, path, query));
  }

  private async fetchJson(
    ctx: CallContext,
    path: string,
    query: Record<string, string | number>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

    let response: Response;
    try {
      response = await ctx.fetch(url.toString(), { headers: BROWSER_HEADERS, signal: ctx.signal });
    } catch (error) {
      throw new ProviderError(this.name, "trending", `network error: ${String(error)}`, {
        retryable: true,
      });
    }

    if (!response.ok) {
      throw new ProviderError(
        this.name,
        "trending",
        `creative center returned HTTP ${response.status}`,
        { status: response.status, retryable: response.status >= 500 || response.status === 429 },
      );
    }

    const body = (await response.json()) as Record<string, unknown>;
    const code = body.code ?? body.status_code;
    if (typeof code === "number" && code !== 0) {
      // 40101 = "no permission": the public endpoint changed its gate. Retryable
      // so the breaker trips after three tries and the paid fallback takes over.
      throw new ProviderError(
        this.name,
        "trending",
        `creative center code ${code}${body.msg ? `: ${String(body.msg)}` : ""}`,
        { retryable: true },
      );
    }
    return body;
  }

  private extractList(body: Record<string, unknown>): Record<string, unknown>[] {
    const data = body.data;
    const container = data && typeof data === "object" ? (data as Record<string, unknown>) : body;
    for (const key of ["list", "hashtags", "songs", "sounds", "videos", "materials"]) {
      const value = container[key];
      if (Array.isArray(value)) {
        return value.filter(
          (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
        );
      }
    }
    return [];
  }
}
