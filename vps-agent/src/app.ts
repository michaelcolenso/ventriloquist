import type { FastifyInstance } from "fastify";
import type { AlertSender } from "./alerts";
import type { JobStateStore, JobStatus } from "./jobState";
import type { SessionStatus } from "./sessions";
import type { StudioAnalyticsRow } from "./studio";

export interface JobBody {
  job_id: string;
  kind: "post" | "render_and_post";
  video_r2_key: string | null;
  caption: string;
  hashtags: string[];
  scheduled_at: number | null;
  render_spec: { story?: string; options?: Record<string, unknown> } | null;
}

export interface JobOutcome {
  status: JobStatus;
  tiktokUrl: string | null;
  videoR2Key: string | null;
  error: string | null;
  postedAt: number | null;
}

export type JobRunner = (body: JobBody) => Promise<JobOutcome>;

export interface AppDeps {
  app: FastifyInstance;
  postingWorkerToken: string;
  callbackToken: string;
  facadeUrl: string;
  postingHandle: string;
  dryRun: boolean;
  sessionFile: string;
  state: JobStateStore;
  runner: JobRunner;
  scraper: () => Promise<StudioAnalyticsRow[]>;
  sessionStatus: () => Promise<SessionStatus>;
  alert: AlertSender;
}

/** Accept the facade header, and bearer tokens for curl/ops ergonomics. */
function authorized(
  headerToken: string | undefined,
  authorization: string | undefined,
  expected: string,
): boolean {
  if (!expected) return false;
  if (headerToken && headerToken === expected) return true;
  const bearer = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return bearer.length > 0 && bearer === expected;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { app } = deps;

  app.get("/health", async () => {
    let session: SessionStatus | null = null;
    let sessionError: string | null = null;
    try {
      session = await deps.sessionStatus();
    } catch (error) {
      sessionError = error instanceof Error ? error.message : String(error);
    }
    return {
      ok: true,
      dry_run: deps.dryRun,
      posting_handle: deps.postingHandle,
      session: session
        ? {
            stale: session.stale,
            detail: session.detail,
            file_age_days: session.file_age_days,
            expires_at: session.expires_at,
          }
        : null,
      session_error: sessionError,
    };
  });

  app.post<{ Body: JobBody }>("/jobs", async (request, reply) => {
    if (
      !authorized(
        request.headers["x-facade-call-token"] as string | undefined,
        request.headers.authorization,
        deps.postingWorkerToken,
      )
    ) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = request.body;
    if (!body?.job_id) return reply.code(400).send({ error: "job_id required" });

    const claim = await deps.state.claim(body.job_id);
    if (!claim.claimed) {
      return reply.code(200).send({
        accepted: false,
        duplicate: true,
        job_id: body.job_id,
        status: claim.record.status,
        tiktok_url: claim.record.tiktokUrl,
        video_r2_key: claim.record.videoR2Key,
        error: claim.record.error,
      });
    }

    void runJob(deps, body);
    return reply.code(202).send({ accepted: true, job_id: body.job_id });
  });

  app.post("/studio-scrape", async (request, reply) => {
    if (
      !authorized(
        request.headers["x-facade-call-token"] as string | undefined,
        request.headers.authorization,
        deps.postingWorkerToken,
      )
    ) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    try {
      const rows = await deps.scraper();
      return { accepted: true, count: rows.length, rows };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, "studio scrape failed");
      await deps.alert(`studio scrape failed: ${detail}`);
      return reply.code(502).send({ accepted: false, error: detail });
    }
  });

  app.post("/session/refresh", async (request, reply) => {
    if (
      !authorized(
        request.headers["x-facade-call-token"] as string | undefined,
        request.headers.authorization,
        deps.postingWorkerToken,
      )
    ) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    let status: SessionStatus;
    try {
      status = await deps.sessionStatus();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await deps.alert(`posting session unreadable: ${detail}`);
      return {
        accepted: false,
        stale: true,
        detail,
        session_file: deps.sessionFile,
        action: "re-login on the VPS, then re-seal the cookie file with age",
      };
    }
    if (status.stale) {
      await deps.alert(`posting session is stale: ${status.detail}`);
    }
    return {
      accepted: true,
      stale: status.stale,
      detail: status.detail,
      cookie_count: status.cookie_count,
      names: status.names,
      expires_at: status.expires_at,
      file_age_days: status.file_age_days,
      session_file: deps.sessionFile,
      action: status.stale ? "re-login on the VPS, then re-seal the cookie file with age" : null,
    };
  });

  return app;
}

async function runJob(deps: AppDeps, body: JobBody): Promise<void> {
  let outcome: JobOutcome;
  try {
    outcome = await deps.runner(body);
    await deps.state.complete(body.job_id, {
      status: outcome.status,
      tiktokUrl: outcome.tiktokUrl,
      videoR2Key: outcome.videoR2Key,
      error: outcome.error,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.app.log.error({ err: error, jobId: body.job_id }, "job execution failed");
    outcome = {
      status: "failed",
      tiktokUrl: null,
      videoR2Key: null,
      error: detail,
      postedAt: null,
    };
    await deps.state.complete(body.job_id, {
      status: "failed",
      tiktokUrl: null,
      videoR2Key: null,
      error: detail,
    });
  }

  const reported = await report(deps, {
    job_id: body.job_id,
    status: outcome.status,
    tiktok_url: outcome.tiktokUrl,
    video_r2_key: outcome.videoR2Key,
    error: outcome.error,
    posted_at: outcome.postedAt,
  });
  if (!reported) {
    await deps.alert(
      `job ${body.job_id} finished as ${outcome.status} but the facade callback failed; check FACADE_URL and FACADE_CALLBACK_TOKEN`,
    );
  }
}

async function report(deps: AppDeps, payload: Record<string, unknown>): Promise<boolean> {
  if (!deps.facadeUrl) {
    deps.app.log.warn({ payload }, "FACADE_URL unset: job status not reported back");
    return false;
  }
  try {
    const response = await fetch(`${deps.facadeUrl.replace(/\/$/, "")}/admin/job-callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.callbackToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      deps.app.log.error({ status: response.status, payload }, "job callback rejected");
      return false;
    }
    return true;
  } catch (error) {
    deps.app.log.error({ err: error, payload }, "failed to report job status");
    return false;
  }
}
