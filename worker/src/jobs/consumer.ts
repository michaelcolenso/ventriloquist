import type { Env } from "../env";
import { createLogger } from "../lib/logger";
import { errorMessage } from "../lib/errors";
import {
  getPostJob,
  HELD_STATUS,
  isTerminalStatus,
  postingHalt,
  updateJobStatus,
  type PostJobMessage,
} from "../storage/jobs";
import { newId } from "../lib/ids";
import { sendAlert } from "../lib/alerts";

/** What the VPS answers on /jobs; a duplicate carries its stored record. */
interface DispatchResponse {
  accepted?: boolean;
  duplicate?: boolean;
  status?: string;
  tiktok_url?: string | null;
  video_r2_key?: string | null;
  error?: string | null;
}

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
    if (isTerminalStatus(job.status) || job.status === HELD_STATUS) {
      logger.info("post job already settled; acking", { jobId, status: job.status });
      message.ack();
      continue;
    }

    const now = Math.floor(Date.now() / 1000);

    // Spec 7.4: a halt also stops jobs that were queued before it tripped.
    const halt = await postingHalt(env, now);
    if (halt.halted) {
      await updateJobStatus(
        env.DB,
        jobId,
        {
          status: HELD_STATUS,
          error: `held: posting is halted after ${halt.failures} consecutive failures; clear the halt and re-queue`,
          unlessTerminal: true,
        },
        now,
      );
      logger.warn("posting halted; job held", { jobId, failures: halt.failures });
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
          unlessTerminal: true,
        },
        now,
      );
      logger.error("no posting worker configured", { jobId });
      message.ack();
      continue;
    }

    // Mark running before dispatch: the VPS callback for a fast failure can
    // land before the dispatch response does, and must not be overwritten.
    await updateJobStatus(
      env.DB,
      jobId,
      { status: "running", error: null, incrementAttempts: true, unlessTerminal: true },
      now,
    );

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

      const dispatch = (await response.json().catch(() => ({}))) as DispatchResponse;
      if (dispatch.duplicate && dispatch.status && isTerminalStatus(dispatch.status)) {
        // The VPS already ran this job: adopt its record instead of "running".
        await updateJobStatus(
          env.DB,
          jobId,
          {
            status: dispatch.status,
            tiktokUrl: dispatch.tiktok_url ?? null,
            videoR2Key: dispatch.video_r2_key ?? job.video_r2_key,
            error: dispatch.error ?? null,
          },
          now,
        );
        logger.info("posting worker replayed a settled job", { jobId, status: dispatch.status });
      }
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
          unlessTerminal: true,
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
  const status = body.status ?? "posted";
  await updateJobStatus(
    env.DB,
    body.job_id,
    {
      status,
      videoR2Key: body.video_r2_key ?? null,
      tiktokUrl: body.tiktok_url ?? null,
      error: body.error ?? null,
      postedAt: body.posted_at ?? (status === "posted" ? now : null),
      // An in-progress report never overwrites an outcome already recorded.
      unlessTerminal: !isTerminalStatus(status),
    },
    now,
  );
  if (status === "failed") {
    const { failures, halted } = await postingHalt(env, now);
    if (halted) {
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
