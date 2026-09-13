import { z } from "zod";
import type { Profile, Video } from "../../domain/models";
import type { ExecutionResult } from "../../backends/types";
import { buildVideoSnapshotStatements } from "../../storage/snapshots";
import { accountVelocity, detectBreakouts } from "../../velocity/engine";
import { defineTool } from "../registry";
import { compactVideo, routeMeta } from "./shared";

const usernameSchema = z.string().min(1).describe("TikTok handle, with or without leading @");

type VideoList = { items: Video[]; cursor: string | null; hasMore: boolean };

export const profileTool = defineTool({
  name: "tt_profile",
  risk: "GREEN",
  title: "Public profile",
  summary:
    "Public profile stats plus recent videos with metrics. Refreshes the snapshot history for that account on every call.",
  inputSchema: {
    username: usernameSchema,
    include_videos: z.boolean().default(true),
    video_count: z.number().int().min(0).max(50).default(12),
  },
  handler: async (input, ctx) => {
    const username = input.username.replace(/^@/, "");
    const profileExecution = await ctx.route<Profile>("profile", { username });
    const profile = profileExecution.value;

    let videos: Video[] = [];
    let videoExecution: ExecutionResult<VideoList> | null = null;
    if (input.include_videos && input.video_count > 0) {
      videoExecution = await ctx.route<VideoList>("profile_videos", {
        username,
        count: input.video_count,
      });
      videos = videoExecution.value.items ?? [];
      ctx.snapshot(
        buildVideoSnapshotStatements(ctx.env.DB, videos, ctx.now, videoExecution.source),
      );
    }

    return {
      summary: `@${username}: ${profile.stats.followerCount?.toLocaleString() ?? "?"} followers, ${
        profile.stats.videoCount?.toLocaleString() ?? "?"
      } videos${videos.length ? `, ${videos.length} recent videos snapshotted` : ""}.`,
      data: {
        profile: {
          username: profile.uniqueId ?? username,
          nickname: profile.nickname,
          verified: profile.verified,
          private: profile.privateAccount,
          signature: profile.signature,
          region: profile.region,
          profile_url: profile.profileUrl,
          followers: profile.stats.followerCount,
          following: profile.stats.followingCount,
          hearts: profile.stats.heartCount,
          videos: profile.stats.videoCount,
          source: profile.source,
        },
        recent_videos: videos.map(compactVideo),
      },
      meta: {
        profile: routeMeta(profileExecution),
        videos: videoExecution ? routeMeta(videoExecution) : null,
      },
    };
  },
});

export const videoDetailTool = defineTool({
  name: "tt_video_detail",
  risk: "GREEN",
  title: "Video detail",
  summary:
    "All public metrics for one video, plus its cached transcript. Transcription is lazy: pass include_transcript to fetch one on demand.",
  inputSchema: {
    video_id: z.string().min(1).describe("Numeric TikTok video id (aweme id)"),
    include_transcript: z.boolean().default(false),
  },
  handler: async (input, ctx) => {
    const execution = await ctx.route<{ video: Video }>("video_detail", {
      video_id: input.video_id,
    });
    const video = execution.value.video;
    ctx.snapshot(buildVideoSnapshotStatements(ctx.env.DB, [video], ctx.now, execution.source));

    const cached = await ctx.env.DB.prepare(
      `SELECT text, language, source, created_at FROM transcripts WHERE video_id = ?`,
    )
      .bind(input.video_id)
      .first<{ text: string; language: string | null; source: string; created_at: number | null }>();

    let transcript = cached
      ? { text: cached.text, language: cached.language, source: cached.source, cached: true }
      : null;
    const warnings: string[] = [];

    if (input.include_transcript && !transcript) {
      try {
        const transcriptExecution = await ctx.route<{
          text: string;
          language: string | null;
          source: string;
        } | null>("transcript", { video_id: input.video_id });
        if (transcriptExecution.value?.text) {
          transcript = { ...transcriptExecution.value, cached: false };
          ctx.cacheTranscript(input.video_id, {
            text: transcriptExecution.value.text,
            language: transcriptExecution.value.language,
            source: "tiktok_caption",
          });
        } else {
          warnings.push(
            "No caption or ASR track exposed for this video. The Whisper fallback runs on the VPS render worker (download -> transcribe -> transcripts table) and is not wired into the Worker yet.",
          );
        }
      } catch (error) {
        warnings.push(`Transcript fetch failed: ${String(error)}`);
      }
    }

    return {
      summary: `Video ${video.id} by @${video.author?.uniqueId ?? "?"}: ${
        video.stats.playCount?.toLocaleString() ?? "?"
      } plays, ${video.stats.likeCount?.toLocaleString() ?? "?"} likes.`,
      data: {
        video: compactVideo(video),
        transcript,
      },
      warnings: warnings.length ? warnings : undefined,
      meta: routeMeta(execution),
    };
  },
});

export const shadowCohortTool = defineTool({
  name: "tt_shadow_cohort",
  risk: "GREEN",
  title: "Shadow cohort",
  summary:
    "The tracked competitor set: latest posts, per-account velocity and breakout detection (>3σ above the account's trailing median plays within 48h).",
  inputSchema: {
    refresh: z.boolean().default(false).describe("Pull fresh videos for a few cohort accounts first"),
    max_refresh_accounts: z.number().int().min(0).max(20).default(5),
    per_account_videos: z.number().int().min(1).max(30).default(10),
    breakout_since_hours: z.number().int().min(6).max(336).default(48),
    sigmas: z.number().min(1).max(6).default(3),
  },
  handler: async (input, ctx) => {
    const { results: cohort } = await ctx.env.DB.prepare(
      `SELECT username, niche, follower_count FROM shadow_cohort ORDER BY username`,
    ).all<{ username: string; niche: string | null; follower_count: number | null }>();

    const accounts = cohort ?? [];
    const refreshed: string[] = [];
    const warnings: string[] = [];

    if (input.refresh && accounts.length > 0) {
      for (const account of accounts.slice(0, input.max_refresh_accounts)) {
        try {
          const execution = await ctx.route<{ items: Video[] }>("profile_videos", {
            username: account.username,
            count: input.per_account_videos,
          });
          ctx.snapshot(
            buildVideoSnapshotStatements(
              ctx.env.DB,
              execution.value.items ?? [],
              ctx.now,
              execution.source,
            ),
          );
          refreshed.push(account.username);
        } catch (error) {
          warnings.push(`Refresh failed for @${account.username}: ${String(error)}`);
        }
      }
    }

    const breakouts = await detectBreakouts(ctx.env.DB, {
      now: ctx.now,
      sinceHours: input.breakout_since_hours,
      sigmas: input.sigmas,
    });

    const rows = [];
    for (const account of accounts) {
      const velocity = await accountVelocity(ctx.env.DB, account.username, { now: ctx.now });
      rows.push({
        username: account.username,
        niche: account.niche,
        follower_count: account.follower_count,
        videos_tracked: velocity.videosTracked,
        median_plays: velocity.medianPlays,
        median_likes: velocity.medianLikes,
        velocity_24h: velocity.velocity24h,
        acceleration: velocity.acceleration,
        lifecycle: velocity.lifecycle,
        latest_at: velocity.latestAt,
        breakouts: breakouts.filter((breakout) => breakout.username === account.username),
      });
    }

    if (accounts.length < 50) {
      warnings.push(
        `Cohort has ${accounts.length} accounts; the spec target is 50. Seed more with POST /admin/cohort or scripts/seed-cohort.mjs.`,
      );
    }
    if (input.refresh && accounts.length > input.max_refresh_accounts) {
      warnings.push(
        `Refreshed ${refreshed.length}/${accounts.length} accounts (max_refresh_accounts=${input.max_refresh_accounts}) to stay inside one cron budget.`,
      );
    }

    return {
      summary: `${accounts.length} cohort accounts; ${breakouts.length} breakout${
        breakouts.length === 1 ? "" : "s"
      } detected in the last ${input.breakout_since_hours}h.`,
      data: { cohort_size: accounts.length, refreshed, breakouts, accounts: rows },
      warnings: warnings.length ? warnings : undefined,
      meta: { provider: "d1", source: "ventriloquist" },
    };
  },
});

export const compareAccountsTool = defineTool({
  name: "tt_compare_accounts",
  risk: "GREEN",
  title: "Compare accounts",
  summary:
    "Side-by-side metrics and posting-cadence analysis for two or more accounts, computed from accumulated snapshots.",
  inputSchema: {
    usernames: z.array(usernameSchema).min(2).max(10),
    window_days: z.number().int().min(3).max(180).default(30),
    refresh: z.boolean().default(false),
    per_account_videos: z.number().int().min(1).max(50).default(20),
  },
  handler: async (input, ctx) => {
    const warnings: string[] = [];
    const rows = [];

    for (const raw of input.usernames) {
      const username = raw.replace(/^@/, "");
      if (input.refresh) {
        try {
          const execution = await ctx.route<{ items: Video[] }>("profile_videos", {
            username,
            count: input.per_account_videos,
          });
          ctx.snapshot(
            buildVideoSnapshotStatements(
              ctx.env.DB,
              execution.value.items ?? [],
              ctx.now,
              execution.source,
            ),
          );
        } catch (error) {
          warnings.push(`Refresh failed for @${username}: ${String(error)}`);
        }
      }
      const velocity = await accountVelocity(ctx.env.DB, username, {
        now: ctx.now,
        windowDays: input.window_days,
      });
      rows.push(velocity);
    }

    const cadence = rows.map((row) => {
      const timestamps = row.recent.map((video) => video.capturedAt).sort((a, b) => a - b);
      const gaps = timestamps.slice(1).map((t, index) => (t - timestamps[index]!) / 3600);
      const averageGap =
        gaps.length > 0 ? Math.round((gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) * 10) / 10 : null;
      return {
        username: row.username,
        posts_observed: row.recent.length,
        avg_hours_between_posts: averageGap,
      };
    });

    return {
      summary: `Compared ${rows.length} accounts over ${input.window_days}d: ${rows
        .map((row) => `@${row.username} median ${row.medianPlays ?? "?"} plays`)
        .join("; ")}.`,
      data: { window_days: input.window_days, accounts: rows, cadence },
      warnings: warnings.length ? warnings : undefined,
      meta: { provider: "d1", source: "ventriloquist" },
    };
  },
});
