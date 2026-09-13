import { z } from "zod";
import type {
  HashtagStats,
  SearchResult,
  SoundStats,
  TrendingHashtag,
  TrendingSound,
  Video,
} from "../../domain/models";
import { buildHashtagSnapshotStatements, buildSoundSnapshotStatements } from "../../storage/snapshots";
import { hashtagMomentum, soundLifecycle, emergingInNiche } from "../../velocity/engine";
import { buildVideoSnapshotStatements } from "../../storage/snapshots";
import { defineTool } from "../registry";
import { compactVideo, routeMeta } from "./shared";

const regionSchema = z
  .string()
  .length(2)
  .describe("ISO 3166-1 alpha-2 content region, e.g. US, GB, CA")
  .optional();

/** Trending rows come back in two families; snapshots only want counts. */
function hashtagStatsFromTrending(row: TrendingHashtag): HashtagStats {
  return {
    id: row.id,
    name: row.name,
    description: null,
    videoCount: row.publishCount,
    viewCount: row.viewCount,
    url: row.url,
    source: row.source,
  };
}

function soundStatsFromTrending(row: TrendingSound): SoundStats {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    original: false,
    durationSeconds: row.durationSeconds,
    videoCount: null,
    userCount: row.userCount,
    coverUrl: row.coverUrl,
    playUrl: row.playUrl,
    source: row.source,
  };
}

export const trendingHashtags = defineTool({
  name: "tt_trending_hashtags",
  risk: "GREEN",
  title: "Trending hashtags",
  summary:
    "Current trending hashtags by region and category, annotated with our own historical velocity (lifecycle stage, acceleration, saturation) whenever we already have enough snapshots for that tag.",
  inputSchema: {
    region: regionSchema,
    category: z.string().optional().describe("Creative Center industry filter, e.g. 'Family & Relationships'"),
    limit: z.number().int().min(1).max(200).default(20),
    period: z.number().int().min(1).max(120).default(7).describe("Trend window in days"),
    annotate_limit: z.number().int().min(0).max(50).default(20).describe("How many rows to enrich from D1"),
  },
  handler: async (input, ctx) => {
    const execution = await ctx.route<TrendingHashtag[]>("trending", {
      mode: "hashtags",
      region: input.region ?? ctx.region,
      count: input.limit,
      period: input.period,
    });

    let rows = execution.value ?? [];
    if (input.category) {
      const needle = input.category.toLowerCase();
      rows = rows.filter((row) => (row.industry ?? "").toLowerCase().includes(needle));
    }

    const annotations = new Map<string, Record<string, unknown>>();
    for (const row of rows.slice(0, input.annotate_limit)) {
      const momentum = await hashtagMomentum(ctx.env.DB, row.name, {
        now: ctx.now,
        windowDays: 14,
      });
      if (momentum.metrics.samples === 0) continue;
      annotations.set(row.name.toLowerCase(), {
        samples: momentum.metrics.samples,
        lifecycle: momentum.metrics.lifecycle,
        velocity_24h: momentum.metrics.velocity24h,
        acceleration: momentum.metrics.acceleration,
        actionability: momentum.metrics.actionability,
        saturation: momentum.metrics.saturation,
      });
    }
    ctx.snapshot(
      buildHashtagSnapshotStatements(ctx.env.DB, rows.map(hashtagStatsFromTrending), ctx.now),
    );

    const growth = rows.filter((row) => annotations.get(row.name.toLowerCase())?.lifecycle === "GROWTH");
    return {
      summary: `Fetched ${rows.length} trending hashtags via ${execution.provider}${
        execution.failover ? " (after failover)" : ""
      }; ${annotations.size} had enough history to classify, ${growth.length} in GROWTH.`,
      data: {
        region: input.region ?? ctx.region,
        period_days: input.period,
        hashtags: rows.map((row) => ({
          name: row.name,
          rank: row.rank,
          rank_diff: row.rankDiff,
          industry: row.industry,
          views: row.viewCount,
          posts: row.publishCount,
          creators: row.userCount,
          is_new: row.isNew,
          is_promoted: row.isPromoted,
          url: row.url,
          history: annotations.get(row.name.toLowerCase()) ?? null,
          source: row.source,
        })),
      },
      meta: routeMeta(execution),
    };
  },
});

export const trendingSounds = defineTool({
  name: "tt_trending_sounds",
  risk: "GREEN",
  title: "Trending sounds",
  summary:
    "Trending sounds by region, with an explicit flag for sounds in the GROWTH phase based on our accumulated sound snapshots - the signal that matters for jumping on a sound before saturation.",
  inputSchema: {
    region: regionSchema,
    limit: z.number().int().min(1).max(200).default(20),
    period: z.number().int().min(1).max(120).default(7),
    growth_only: z.boolean().default(false).describe("Return only sounds our data classifies as GROWTH"),
    annotate_limit: z.number().int().min(0).max(50).default(20),
  },
  handler: async (input, ctx) => {
    const execution = await ctx.route<TrendingSound[]>("trending", {
      mode: "songs",
      region: input.region ?? ctx.region,
      count: input.limit,
      period: input.period,
    });

    const rows = execution.value ?? [];
    const lifecycleBySound = new Map<string, Record<string, unknown>>();
    for (const row of rows.slice(0, input.annotate_limit)) {
      if (!row.id) continue;
      const result = await soundLifecycle(ctx.env.DB, row.id, { now: ctx.now, windowDays: 30 });
      if (result.metrics.samples === 0) continue;
      lifecycleBySound.set(row.id, {
        samples: result.metrics.samples,
        stage: result.stage,
        velocity_24h: result.metrics.velocity24h,
        acceleration: result.metrics.acceleration,
        saturation: result.metrics.saturation,
        birth_at: result.birthAt,
      });
    }

    ctx.snapshot(
      buildSoundSnapshotStatements(ctx.env.DB, rows.map(soundStatsFromTrending), ctx.now),
    );

    const enriched = rows.map((row) => ({
      sound_id: row.id,
      title: row.title,
      author: row.author,
      rank: row.rank,
      rank_diff: row.rankDiff,
      creators: row.userCount,
      is_new: row.isNew,
      play_url: row.playUrl,
      history: row.id ? lifecycleBySound.get(row.id) ?? null : null,
      in_growth_phase: (row.id ? lifecycleBySound.get(row.id)?.stage : null) === "GROWTH",
      lifecycle_unproven: row.id ? !lifecycleBySound.has(row.id) : true,
      source: row.source,
    }));
    const filtered = input.growth_only
      ? enriched.filter((row) => row.in_growth_phase)
      : enriched;

    const unproven = enriched.filter((row) => row.lifecycle_unproven).length;
    return {
      summary: `${filtered.length} sounds returned via ${execution.provider}; ${
        enriched.filter((row) => row.in_growth_phase).length
      } in GROWTH, ${unproven} still unproven (need 4+ snapshots).`,
      data: { region: input.region ?? ctx.region, sounds: filtered },
      warnings:
        input.growth_only && filtered.length === 0
          ? ["No sound in the current trending set has enough accumulated history to be classified GROWTH yet."]
          : undefined,
      meta: routeMeta(execution),
    };
  },
});

export const hashtagMomentumTool = defineTool({
  name: "tt_hashtag_momentum",
  risk: "GREEN",
  title: "Hashtag momentum",
  summary:
    "Time series of view/post counts for one hashtag plus velocity, acceleration, lifecycle stage and saturation estimate. Reads our accumulated history; optionally tops up today's count from a live backend.",
  inputSchema: {
    hashtag: z.string().min(1).describe("Hashtag name, with or without leading #"),
    window_days: z.number().int().min(3).max(180).default(30),
    min_samples: z.number().int().min(2).max(50).default(4),
    live_top_up: z.boolean().default(true).describe("Fetch today's count if history is thin"),
    niche: z.string().optional().describe("Used to pick the saturation threshold"),
  },
  handler: async (input, ctx) => {
    const momentum = await hashtagMomentum(ctx.env.DB, input.hashtag, {
      now: ctx.now,
      windowDays: input.window_days,
      niche: input.niche ?? "baby-names",
    });

    let live: { value: HashtagStats; meta: Record<string, unknown> } | null = null;
    if (input.live_top_up && momentum.metrics.samples < input.min_samples) {
      try {
        const execution = await ctx.route<HashtagStats>("hashtag_stats", {
          hashtag: input.hashtag,
          region: ctx.region,
        });
        live = { value: execution.value, meta: routeMeta(execution) };
        ctx.snapshot(
          buildHashtagSnapshotStatements(ctx.env.DB, [execution.value], ctx.now),
        );
      } catch (error) {
        ctx.logger.warn("live hashtag top-up failed", { error: String(error) });
      }
    }

    const warnings: string[] = [];
    if (momentum.metrics.samples < input.min_samples) {
      warnings.push(
        `Only ${momentum.metrics.samples} snapshot(s) in the window: lifecycle needs ${input.min_samples}+. Snapshot crons will fill this in.`,
      );
    }
    if (momentum.metrics.lifecycle === "EMBRYONIC") {
      warnings.push("EMBRYONIC means we simply have <3 days of history, not that the tag is new.");
    }

    return {
      summary: `#${momentum.entity}: ${momentum.metrics.lifecycle.toLowerCase()}, ${
        momentum.metrics.samples
      } snapshots over ${input.window_days}d${
        momentum.metrics.acceleration !== null
          ? `, acceleration ${momentum.metrics.acceleration.toLocaleString()} views/day`
          : ""
      }.`,
      data: {
        hashtag: momentum.entity,
        window_days: momentum.windowDays,
        metrics: momentum.metrics,
        series: momentum.series,
        live_snapshot: live?.value ?? null,
        historical_only: momentum.series.every(
          (point) => point.value !== null && point.source !== "live",
        ),
      },
      warnings: warnings.length ? warnings : undefined,
      meta: live?.meta ?? { provider: "d1", source: "ventriloquist" },
    };
  },
});

export const emergingInNicheTool = defineTool({
  name: "tt_emerging_in_niche",
  risk: "GREEN",
  title: "Emerging in niche",
  summary:
    "Ranked list of hashtags and sounds gaining velocity before saturation, scored by acceleration x (1 - saturation) x niche relevance. Answers: what should we make a video about this week that hasn't been done to death?",
  inputSchema: {
    niche_keywords: z
      .array(z.string().min(2))
      .min(1)
      .describe("Niche keywords, e.g. ['baby names','name meanings','family']"),
    limit: z.number().int().min(1).max(50).default(10),
    window_days: z.number().int().min(3).max(90).default(14),
    min_samples: z.number().int().min(2).max(50).default(4),
    include_sounds: z.boolean().default(true),
  },
  handler: async (input, ctx) => {
    const result = await emergingInNiche(ctx.env.DB, {
      now: ctx.now,
      keywords: input.niche_keywords,
      limit: input.limit,
      windowDays: input.window_days,
      minSamples: input.min_samples,
    });

    const warnings: string[] = [];
    if (result.candidates.length === 0) {
      warnings.push(
        "No entity has enough accumulated history yet. Run tt_trending_hashtags and the snapshot crons to seed the watchlist, then retry - the velocity engine needs 4+ snapshots per entity.",
      );
    }
    if (result.skippedForHistory > 0) {
      warnings.push(
        `${result.skippedForHistory} matching entities were skipped for insufficient history.`,
      );
    }

    return {
      summary:
        result.candidates.length === 0
          ? `No emerging candidates yet (evaluated ${result.evaluated} entities, ${result.skippedForHistory} lacked history).`
          : `Top ${result.candidates.length} emerging candidates from ${result.evaluated} evaluated entities.`,
      data: {
        niche_keywords: input.niche_keywords,
        window_days: input.window_days,
        evaluated: result.evaluated,
        skipped_for_history: result.skippedForHistory,
        candidates: result.candidates.filter(
          (candidate) => input.include_sounds || candidate.entityType === "hashtag",
        ),
      },
      warnings: warnings.length ? warnings : undefined,
      meta: { provider: "d1", source: "ventriloquist" },
    };
  },
});

export const searchVideosTool = defineTool({
  name: "tt_search_videos",
  risk: "GREEN",
  title: "Search videos",
  summary: "Keyword search over public TikTok videos with full public metrics, snapshotted into D1.",
  inputSchema: {
    query: z.string().min(1),
    region: regionSchema,
    count: z.number().int().min(1).max(50).default(20),
    cursor: z.string().optional(),
  },
  handler: async (input, ctx) => {
    const execution = await ctx.route<SearchResult<Video>>("search", {
      query: input.query,
      region: input.region ?? ctx.region,
      count: input.count,
      cursor: input.cursor,
    });
    const result = execution.value;
    ctx.snapshot(
      buildVideoSnapshotStatements(ctx.env.DB, result.items, ctx.now, result.source),
    );
    return {
      summary: `${result.items.length} videos for "${input.query}" via ${execution.provider}${
        execution.failover ? " (after failover)" : ""
      }.`,
      data: {
        query: input.query,
        region: input.region ?? ctx.region,
        cursor: result.cursor,
        has_more: result.hasMore,
        videos: result.items.map(compactVideo),
      },
      meta: routeMeta(execution),
    };
  },
});

export const soundLifecycleTool = defineTool({
  name: "tt_sound_lifecycle",
  risk: "GREEN",
  title: "Sound lifecycle",
  summary:
    "Birth date, growth curve, peak detection and saturation estimate for one sound, computed from accumulated sound snapshots.",
  inputSchema: {
    sound_id: z.string().min(1),
    window_days: z.number().int().min(3).max(180).default(60),
    live_top_up: z.boolean().default(true),
  },
  handler: async (input, ctx) => {
    const lifecycle = await soundLifecycle(ctx.env.DB, input.sound_id, {
      now: ctx.now,
      windowDays: input.window_days,
    });

    let live: SoundStats | null = null;
    if (input.live_top_up && lifecycle.metrics.samples < 4) {
      try {
        const execution = await ctx.route<SoundStats>("sound_stats", {
          sound_id: input.sound_id,
          region: ctx.region,
        });
        live = execution.value;
        ctx.snapshot(buildSoundSnapshotStatements(ctx.env.DB, [execution.value], ctx.now));
      } catch (error) {
        ctx.logger.warn("live sound top-up failed", { error: String(error) });
      }
    }

    const warnings =
      lifecycle.metrics.samples < 4
        ? [
            `Only ${lifecycle.metrics.samples} snapshots: peak and saturation estimates stay unproven until the sound cron accumulates more.`,
          ]
        : [];

    return {
      summary: `Sound ${input.sound_id}: ${lifecycle.stage.toLowerCase()}, birth ${
        lifecycle.birthAt ? new Date(lifecycle.birthAt * 1000).toISOString().slice(0, 10) : "unknown"
      }, peak velocity ${
        lifecycle.metrics.peakVelocity !== null
          ? lifecycle.metrics.peakVelocity.toLocaleString()
          : "n/a"
      }/day.`,
      data: {
        sound_id: input.sound_id,
        window_days: input.window_days,
        stage: lifecycle.stage,
        birth_at: lifecycle.birthAt,
        peak_at: lifecycle.metrics.peakAt,
        metrics: lifecycle.metrics,
        curve: lifecycle.curve,
        live_snapshot: live,
      },
      warnings: warnings.length ? warnings : undefined,
      meta: { provider: "d1", source: "ventriloquist" },
    };
  },
});
