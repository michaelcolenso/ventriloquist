import { z } from "zod";
import { newId } from "../../lib/ids";
import {
  DEFAULT_POSTING_POLICY,
  MAX_CAPTION_LENGTH,
  consecutivePostFailures,
  getPostJob,
  insertPostJob,
  postingContext,
  validatePostRequest,
  type PostJobMessage,
} from "../../storage/jobs";
import { defineTool } from "../registry";

const hashtagsSchema = z
  .array(z.string().min(1))
  .max(10)
  .default([])
  .describe("Bare hashtag words without spaces or leading #");

/**
 * RED path. Everything here is queued, never executed inline (spec P6), and
 * the pacing rules are enforced before the job can reach the queue.
 */
export const queuePostTool = defineTool({
  name: "tt_queue_post",
  risk: "RED",
  title: "Queue post",
  summary:
    "Queue an already-rendered video (R2 key) for posting with caption and hashtags. Validates the daily cap, minimum spacing, caption length and R2 object before enqueueing. Returns a job id.",
  inputSchema: {
    video_r2_key: z.string().min(1).describe("R2 object key of the rendered MP4"),
    caption: z.string().max(MAX_CAPTION_LENGTH),
    hashtags: hashtagsSchema,
    schedule_at: z
      .number()
      .int()
      .optional()
      .describe("Unix epoch seconds; omit for 'next available slot'"),
    dry_run: z.boolean().default(false).describe("Validate only; do not enqueue"),
  },
  annotations: { destructiveHint: true, readOnlyHint: false },
  handler: async (input, ctx) => {
    const object = await ctx.env.MEDIA.head(input.video_r2_key);
    const context = await postingContext(ctx.env.DB, ctx.now);
    const validation = validatePostRequest(
      {
        caption: input.caption,
        hashtags: input.hashtags,
        scheduledAt: input.schedule_at ?? null,
        now: ctx.now,
        videoR2Key: input.video_r2_key,
        videoObjectExists: object !== null,
      },
      context,
    );

    const failures = await consecutivePostFailures(ctx.env.DB, ctx.now);
    const halted = failures >= 2;
    if (halted) {
      validation.ok = false;
      validation.errors.push(
        `${failures} consecutive post failures in the last 24h: posting is halted automatically (spec 7.4). Investigate and clear the halt before queueing again.`,
      );
    }

    if (!validation.ok) {
      return {
        summary: `Rejected before enqueueing: ${validation.errors.length} validation error(s).`,
        data: {
          accepted: false,
          errors: validation.errors,
          warnings: validation.warnings,
          posts_today: context.postsToday,
          cap: DEFAULT_POSTING_POLICY.maxPostsPerDay,
          last_job_at: context.lastScheduledAt,
          halted,
        },
        meta: { provider: "worker", source: "ventriloquist" },
      };
    }

    if (input.dry_run) {
      return {
        summary: "Dry run: request is valid and would be queued.",
        data: { accepted: true, dry_run: true, warnings: validation.warnings },
        meta: { provider: "worker", source: "ventriloquist" },
      };
    }

    const jobId = newId("job", ctx.now * 1000);
    await insertPostJob(ctx.env.DB, {
      jobId,
      kind: "post",
      videoR2Key: input.video_r2_key,
      caption: input.caption,
      hashtags: input.hashtags,
      scheduledAt: input.schedule_at ?? null,
      renderSpec: null,
      now: ctx.now,
    });

    const message: PostJobMessage = {
      jobId,
      kind: "post",
      videoR2Key: input.video_r2_key,
      caption: input.caption,
      hashtags: input.hashtags,
      scheduledAt: input.schedule_at ?? null,
      renderSpec: null,
    };
    await ctx.env.POSTING_QUEUE.send(message);

    return {
      summary: `Queued job ${jobId} (${context.postsToday + 1}/${DEFAULT_POSTING_POLICY.maxPostsPerDay} today). The VPS Playwright worker picks it up with human pacing.`,
      data: {
        job_id: jobId,
        accepted: true,
        scheduled_at: input.schedule_at ?? null,
        warnings: validation.warnings,
      },
      meta: { provider: "worker", source: "ventriloquist" },
    };
  },
});

export const jobStatusTool = defineTool({
  name: "tt_job_status",
  risk: "GREEN",
  title: "Job status",
  summary:
    "Status of a queued/running/posted/failed publish job, including the live TikTok URL once posted.",
  inputSchema: {
    job_id: z.string().min(1),
  },
  handler: async (input, ctx) => {
    const job = await getPostJob(ctx.env.DB, input.job_id);
    if (!job) {
      return {
        summary: `No job with id ${input.job_id}.`,
        data: { found: false, job_id: input.job_id },
        warnings: ["Job ids look like job_<base36 timestamp><random>."],
        meta: { provider: "d1", source: "ventriloquist" },
      };
    }
    const failures = await consecutivePostFailures(ctx.env.DB, ctx.now);
    return {
      summary: `Job ${job.job_id}: ${job.status}${
        job.tiktok_url ? ` -> ${job.tiktok_url}` : ""
      }.`,
      data: {
        found: true,
        job_id: job.job_id,
        kind: job.kind,
        status: job.status,
        video_r2_key: job.video_r2_key,
        caption: job.caption,
        hashtags: job.hashtags ? (JSON.parse(job.hashtags) as string[]) : [],
        scheduled_at: job.scheduled_at,
        posted_at: job.posted_at,
        tiktok_url: job.tiktok_url,
        error: job.error,
        attempts: job.attempts,
        created_at: job.created_at,
        consecutive_failures: failures,
        posting_halted: failures >= 2,
      },
      meta: { provider: "d1", source: "ventriloquist" },
    };
  },
});

export const renderAndPostTool = defineTool({
  name: "tt_render_and_post",
  risk: "RED",
  title: "Render and post",
  summary:
    "The flywheel primitive: hand a nobodynamed-video render spec to the pipeline, and the VPS worker renders it, uploads the artifact to R2, then posts it through the same queued, paced posting path.",
  inputSchema: {
    story: z.string().min(1).describe("Story slug from the nobodynamed-video repo (e.g. kunta)"),
    caption: z.string().max(MAX_CAPTION_LENGTH),
    hashtags: hashtagsSchema,
    schedule_at: z.number().int().optional(),
    render_options: z
      .record(z.unknown())
      .default({})
      .describe("Extra flags forwarded to the render command, e.g. { vibes: 'graveyard' }"),
    dry_run: z.boolean().default(false),
  },
  annotations: { destructiveHint: true, readOnlyHint: false },
  handler: async (input, ctx) => {
    const context = await postingContext(ctx.env.DB, ctx.now);
    const validation = validatePostRequest(
      {
        caption: input.caption,
        hashtags: input.hashtags,
        scheduledAt: input.schedule_at ?? null,
        now: ctx.now,
        videoR2Key: null,
        // The artifact does not exist yet; the render step creates it.
        videoObjectExists: true,
      },
      context,
    );

    const failures = await consecutivePostFailures(ctx.env.DB, ctx.now);
    const halted = failures >= 2;
    if (halted) {
      validation.ok = false;
      validation.errors.push(
        `${failures} consecutive post failures in the last 24h: posting is halted (spec 7.4).`,
      );
    }
    if (!validation.ok) {
      return {
        summary: `Rejected before rendering: ${validation.errors.length} validation error(s).`,
        data: { accepted: false, errors: validation.errors, warnings: validation.warnings, halted },
        meta: { provider: "worker", source: "ventriloquist" },
      };
    }
    if (input.dry_run) {
      return {
        summary: "Dry run: render + post request is valid.",
        data: { accepted: true, dry_run: true, warnings: validation.warnings },
        meta: { provider: "worker", source: "ventriloquist" },
      };
    }

    const jobId = newId("job", ctx.now * 1000);
    const renderSpec = {
      story: input.story,
      options: input.render_options,
      requested_by: "tt_render_and_post",
    };
    await insertPostJob(ctx.env.DB, {
      jobId,
      kind: "render_and_post",
      videoR2Key: null,
      caption: input.caption,
      hashtags: input.hashtags,
      scheduledAt: input.schedule_at ?? null,
      renderSpec,
      now: ctx.now,
    });

    const message: PostJobMessage = {
      jobId,
      kind: "render_and_post",
      videoR2Key: null,
      caption: input.caption,
      hashtags: input.hashtags,
      scheduledAt: input.schedule_at ?? null,
      renderSpec,
    };
    await ctx.env.POSTING_QUEUE.send(message);

    return {
      summary: `Queued render+post job ${jobId} for story "${input.story}". The VPS worker renders via the nobodynamed pipeline, uploads to R2, then posts with pacing.`,
      data: {
        job_id: jobId,
        accepted: true,
        kind: "render_and_post",
        render_spec: renderSpec,
        warnings: validation.warnings,
      },
      meta: { provider: "worker", source: "ventriloquist" },
    };
  },
});
