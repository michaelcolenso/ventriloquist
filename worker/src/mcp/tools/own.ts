import { z } from "zod";
import type { Video } from "../../domain/models";
import { buildVideoSnapshotStatements } from "../../storage/snapshots";
import { accountVelocity, whatWorked } from "../../velocity/engine";
import { defineTool } from "../registry";
import { routeMeta } from "./shared";

export const ownVideoMetricsTool = defineTool({
  name: "tt_own_video_metrics",
  risk: "GREEN",
  title: "Own video metrics",
  summary:
    "Public metrics for every own-account video (GREEN path - no session), refreshed from the public profile and accumulated into D1.",
  inputSchema: {
    handle: z.string().optional().describe("Defaults to OWN_ACCOUNT_HANDLE"),
    refresh: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(30),
  },
  handler: async (input, ctx) => {
    const handle = (input.handle ?? ctx.ownHandle()).replace(/^@/, "");
    let refreshExecution: Record<string, unknown> | null = null;
    const warnings: string[] = [];

    if (input.refresh) {
      try {
        const execution = await ctx.route<{ items: Video[] }>("profile_videos", {
          username: handle,
          count: input.limit,
        });
        refreshExecution = routeMeta(execution);
        ctx.snapshot(
          buildVideoSnapshotStatements(
            ctx.env.DB,
            execution.value.items ?? [],
            ctx.now,
            execution.source,
          ),
        );
      } catch (error) {
        warnings.push(`Live refresh failed, serving D1 history only: ${String(error)}`);
      }
    }

    const velocity = await accountVelocity(ctx.env.DB, handle, {
      now: ctx.now,
      limit: input.limit,
    });

    if (velocity.videosTracked === 0) {
      warnings.push(
        "No snapshots for this account yet. Run the snapshot-own-account cron or retry with refresh=true.",
      );
    }

    return {
      summary: `@${handle}: ${velocity.videosTracked} videos tracked, median ${
        velocity.medianPlays?.toLocaleString() ?? "?"
      } plays, account ${
        velocity.lifecycle !== "UNKNOWN" ? velocity.lifecycle.toLowerCase() : "unclassified"
      }.`,
      data: {
        handle,
        videos_tracked: velocity.videosTracked,
        median_plays: velocity.medianPlays,
        median_likes: velocity.medianLikes,
        velocity_24h: velocity.velocity24h,
        velocity_7d: velocity.velocity7d,
        acceleration: velocity.acceleration,
        lifecycle: velocity.lifecycle,
        videos: velocity.recent.map((video) => ({
          video_id: video.videoId,
          plays: video.playCount,
          likes: video.likeCount,
          captured_at: video.capturedAt,
          hashtags: video.hashtags,
        })),
      },
      warnings: warnings.length ? warnings : undefined,
      meta: refreshExecution ?? { provider: "d1", source: "ventriloquist" },
    };
  },
});

export const ownDeepAnalyticsTool = defineTool({
  name: "tt_own_deep_analytics",
  risk: "AMBER",
  title: "Own deep analytics",
  summary:
    "Watch time, average watch time, full-watch rate, traffic sources and retention for own videos, as captured by the daily Studio scrape on a burner session. Snapshots only - this tool never scrapes live.",
  inputSchema: {
    window_days: z.number().int().min(1).max(180).default(30),
    video_id: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  },
  handler: async (input, ctx) => {
    const since = Math.floor(ctx.now - input.window_days * 86_400);
    const { results } = await ctx.env.DB.prepare(
      `SELECT video_id, captured_at, watch_time_seconds, average_watch_time_seconds,
              full_watch_rate, traffic_sources, retention
         FROM own_video_analytics
        WHERE captured_at >= ? ${input.video_id ? "AND video_id = ?" : ""}
        ORDER BY captured_at DESC
        LIMIT ?`,
    )
      .bind(...(input.video_id ? [since, input.video_id, input.limit] : [since, input.limit]))
      .all<{
        video_id: string;
        captured_at: number;
        watch_time_seconds: number | null;
        average_watch_time_seconds: number | null;
        full_watch_rate: number | null;
        traffic_sources: string | null;
        retention: string | null;
      }>();

    const rows = (results ?? []).map((row) => ({
      video_id: row.video_id,
      captured_at: row.captured_at,
      watch_time_seconds: row.watch_time_seconds,
      average_watch_time_seconds: row.average_watch_time_seconds,
      full_watch_rate: row.full_watch_rate,
      traffic_sources: row.traffic_sources ? (JSON.parse(row.traffic_sources) as unknown) : null,
      retention: row.retention ? (JSON.parse(row.retention) as unknown) : null,
    }));

    const warnings: string[] = [];
    if (rows.length === 0) {
      warnings.push(
        "No Studio analytics captured yet. The studio-deep-scrape cron (daily, AMBER) writes to own_video_analytics from the Playwright worker; run it with a burner session to populate this.",
      );
    }

    return {
      summary:
        rows.length === 0
          ? "No deep analytics snapshots available yet."
          : `${rows.length} Studio snapshot rows in the last ${input.window_days}d.`,
      data: { window_days: input.window_days, rows },
      warnings: warnings.length ? warnings : undefined,
      meta: { provider: "d1", source: "ventriloquist" },
    };
  },
});

export const whatWorkedTool = defineTool({
  name: "tt_what_worked",
  risk: "GREEN",
  title: "What worked",
  summary:
    "Ranked analysis of own videos over a window: which hashtags and sounds correlate with above-median performance, plus the top performers. Reads D1 only.",
  inputSchema: {
    window: z.string().default("30d").describe("Window like 7d, 30d, 90d"),
    handle: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  },
  handler: async (input, ctx) => {
    const match = /^(\d+)\s*d$/.exec(input.window.trim());
    const windowDays = match ? Number(match[1]) : 30;
    const handle = (input.handle ?? ctx.ownHandle()).replace(/^@/, "");
    const result = await whatWorked(ctx.env.DB, handle, {
      now: ctx.now,
      windowDays,
      limit: input.limit,
    });

    const warnings: string[] = [];
    if (result.videosAnalyzed === 0) {
      warnings.push(
        `No own-video snapshots in the last ${windowDays}d. Run tt_own_video_metrics with refresh, or the snapshot-own-account cron, to build the history this tool reads.`,
      );
    }

    return {
      summary:
        result.videosAnalyzed === 0
          ? `No data for @${handle} in the last ${windowDays}d.`
          : `@${handle}: ${result.videosAnalyzed} videos, account median ${
              result.accountMedianPlays?.toLocaleString() ?? "?"
            } plays; best hashtag ${result.byHashtag[0]?.key ?? "n/a"}${
              result.byHashtag[0]?.liftVsAccountMedian
                ? ` at ${result.byHashtag[0].liftVsAccountMedian}x`
                : ""
            }.`,
      data: result,
      warnings: warnings.length ? warnings : undefined,
      meta: { provider: "d1", source: "ventriloquist" },
    };
  },
});
