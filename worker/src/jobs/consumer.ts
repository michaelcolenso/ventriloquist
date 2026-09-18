import type { Env } from "../env";
import { createLogger } from "../lib/logger";
import { errorMessage } from "../lib/errors";
import {
  consecutivePostFailures,
  getPostJob,
  updateJobStatus,
  type PostJobMessage,
} from "../storage/jobs";
import { newId } from "../lib/ids";
import { sendAlert } from "../lib/alerts";

export interface QueueContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Queue consumer (spec section 7).
 *
 * The Worker never touches TikTok credentials. It hands the job to the VPS
 * Playwright worker, which owns the posting session, and mirrors every state
 * transition into `post_jobs` so the durable record survives a lost message.
 */
export async function consumeQueue(
  batch: MessageBatch<PostJobMessage>,
  env: Env,
  ctx: QueueContext,
): Promise<void> {
  const logger = createLogger("info", { queue: batch.queue });

  for (const message of batch.messages) {
    const jobId = message.body?.jobId;
    logger.info("dispatching post job", { jobId, kind: message.body?.kind, attempts: message.attempts });

    if (!jobId) {
      message.ack();
      continue;
    }

    const job = await getPostJob(env.DB, jobId);
    if (!job) {
      logger.warn("post job missing from D1; acking", { jobId });
      message.ack();
      continue;
    }
    if (job.status === "posted") {
      message.ack();
      continue;
    }

    if (!env.POSTING_WORKER_URL) {
      await updateJobStatus(
        env.DB,
        jobId,
        {
          status: "failed",
          error:
            "POSTING_WORKER_URL is not configured: the VPS Playwright worker is not reachable, so the job cannot be executed.",
          incrementAttempts: true,
        },
        Math.floor(Date.now() / 1000),
      );
      logger.error("no posting worker configured", { jobId });
      message.ack();
      continue;
    }

    const now = Math.floor(Date.now() / 1000);
    try {
      const response = await fetch(
        `${env.POSTING_WORKER_URL.replace(/\/$/, "")}/jobs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-facade-call-token": env.POSTING_WORKER_TOKEN ?? "",
            "idempotency-key": jobId,
          },
          body: JSON.stringify({
            job_id: jobId,
            kind: job.kind,
            video_r2_key: job.video_r2_key,
            caption: job.caption,
            hashtags: job.hashtags ? JSON.parse(job.hashtags) : [],
            scheduled_at: job.scheduled_at,
            render_spec: job.render_spec ? JSON.parse(job.render_spec) : null,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`posting worker returned HTTP ${response.status}`);
      }

      await updateJobStatus(
        env.DB,
        jobId,
        { status: "running", error: null, incrementAttempts: true },
        now,
      );
      message.ack();
    } catch (error) {
      const detail = errorMessage(error);
      const isLastAttempt = message.attempts >= 2;
      await updateJobStatus(
        env.DB,
        jobId,
        {
          status: isLastAttempt ? "failed" : "queued",
          error: `dispatch failed: ${detail}`,
          incrementAttempts: true,
        },
        now,
      );
      logger.error("job dispatch failed", { jobId, detail, willRetry: !isLastAttempt });
      if (isLastAttempt) message.ack();
      else message.retry({ delaySeconds: 300 });
    }
  }
  void ctx;
}

/** Callback endpoint the VPS worker uses to report a finished post. */
export function authorizeJobCallback(request: Request, env: Env): boolean {
  const expected = env.FACADE_CALLBACK_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && token === expected;
}

export async function handleJobCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorizeJobCallback(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = (await request.json()) as {
    job_id?: string;
    status?: string;
    tiktok_url?: string | null;
    error?: string | null;
    posted_at?: number | null;
    video_r2_key?: string | null;
  };
  if (!body.job_id) return json({ error: "job_id required" }, 400);
  const now = Math.floor(Date.now() / 1000);
  await updateJobStatus(
    env.DB,
    body.job_id,
    {
      status: body.status ?? "posted",
      videoR2Key: body.video_r2_key ?? null,
      tiktokUrl: body.tiktok_url ?? null,
      error: body.error ?? null,
      postedAt: body.posted_at ?? (body.status === "posted" ? now : null),
    },
    now,
  );
  if ((body.status ?? "posted") === "failed") {
    const failures = await consecutivePostFailures(env.DB, now);
    if (failures >= 2) {
      await sendAlert(
        env,
        `posting halted: ${failures} consecutive failures (last: ${body.error ?? "unknown"})`,
        { logger: createLogger("warn", { component: "alerts" }) },
      );
    }
  }
  return json({ ok: true, job_id: body.job_id });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export { newId };
