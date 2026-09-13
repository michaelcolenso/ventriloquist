import Fastify from "fastify";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostingWorker } from "./uploader";
import { parseStudioAnalyticsPayload } from "./studio";
import { describeSession, loadPostingCookies, type SessionCustodyOptions } from "./sessions";

const PORT = Number(process.env.PORT ?? 8799);
const FACADE_CALLBACK_TOKEN = process.env.FACADE_CALLBACK_TOKEN ?? "";
const FACADE_URL = process.env.FACADE_URL ?? "";
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE ?? "";
const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/chromium";
const USER_DATA_DIR = process.env.POSTING_USER_DATA_DIR ?? "./sessions/posting-profile";
const SESSION_FILE = process.env.POSTING_SESSION_FILE ?? "./sessions/nobodynamed.json.age";
const POSTING_HANDLE = process.env.POSTING_HANDLE ?? "nobodynamed";
const DRY_RUN = process.env.POSTING_DRY_RUN === "1";
const TIMEZONE_OFFSET_MINUTES = Number(process.env.POSTING_TZ_OFFSET_MINUTES ?? -420);

const sessionOptions: SessionCustodyOptions = {
  sessionFile: SESSION_FILE,
  ...(process.env.POSTING_SESSION_AGE_CMD
    ? { decryptCommand: process.env.POSTING_SESSION_AGE_CMD }
    : {}),
  ...(process.env.POSTING_SESSION_PLAINTEXT === "1" ? { allowPlaintext: true } : {}),
};

const worker = new PostingWorker({
  ...sessionOptions,
  executablePath: CHROME_EXECUTABLE_PATH,
  userDataDir: USER_DATA_DIR,
  headless: process.env.SIGNER_HEADLESS !== "0",
  timeoutMs: Number(process.env.POSTING_TIMEOUT_MS ?? 60_000),
  pacing: {},
  profileHandle: POSTING_HANDLE,
  dryRun: DRY_RUN,
});

const app = Fastify({ logger: true });

function authorized(header: string | undefined): boolean {
  if (!FACADE_CALLBACK_TOKEN) return true;
  return header === FACADE_CALLBACK_TOKEN;
}

app.get("/health", async () => {
  let session: ReturnType<typeof describeSession> | null = null;
  let sessionError: string | null = null;
  try {
    session = describeSession(await loadPostingCookies(sessionOptions));
  } catch (error) {
    sessionError = error instanceof Error ? error.message : String(error);
  }
  return {
    ok: true,
    dry_run: DRY_RUN,
    posting_handle: POSTING_HANDLE,
    session,
    session_error: sessionError,
  };
});

interface JobBody {
  job_id: string;
  kind: "post" | "render_and_post";
  video_r2_key: string | null;
  caption: string;
  hashtags: string[];
  scheduled_at: number | null;
  render_spec: { story?: string; options?: Record<string, unknown> } | null;
}

app.post<{ Body: JobBody }>("/jobs", async (request, reply) => {
  if (!authorized(request.headers["x-facade-call-token"] as string | undefined)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const body = request.body;
  if (!body?.job_id) return reply.code(400).send({ error: "job_id required" });

  void execute(body);
  return reply.code(202).send({ accepted: true, job_id: body.job_id });
});

app.post("/studio-scrape", async (request, reply) => {
  if (!authorized(request.headers["x-facade-call-token"] as string | undefined)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  // Driving the logged-in Studio page is a VPS-only capability; the parser is
  // shared with whatever payload hook captures Studio's analytics response.
  const parsed = parseStudioAnalyticsPayload({ data: [] }, Math.floor(Date.now() / 1000));
  return {
    accepted: true,
    rows: parsed.length,
    detail:
      "Studio navigation runs on the burner profile; wire the response hook in uploader/studio before enabling the daily cron in production.",
  };
});

app.post("/session/refresh", async (request, reply) => {
  if (!authorized(request.headers["x-facade-call-token"] as string | undefined)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return {
    accepted: true,
    detail:
      "manual step: re-login on the VPS, then re-seal with `age -R <recipient> -o sessions/nobodynamed.json.age`",
    session_file: SESSION_FILE,
  };
});

async function execute(body: JobBody): Promise<void> {
  try {
    const videoPath = body.video_r2_key
      ? await downloadArtifact(body.video_r2_key)
      : await renderArtifact(body);

    const result = await worker.post({
      videoPath,
      caption: body.caption,
      hashtags: body.hashtags ?? [],
      scheduledAt: body.scheduled_at,
      timezoneOffsetMinutes: TIMEZONE_OFFSET_MINUTES,
    });

    await report({
      job_id: body.job_id,
      status: result.skipped ? "queued" : result.ok ? "posted" : "failed",
      tiktok_url: result.tiktokUrl,
      error: result.ok ? null : result.detail,
    });
  } catch (error) {
    app.log.error({ err: error, jobId: body.job_id }, "job execution failed");
    await report({
      job_id: body.job_id,
      status: "failed",
      tiktok_url: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function downloadArtifact(r2Key: string): Promise<string> {
  if (!R2_PUBLIC_BASE) {
    throw new Error(
      `R2_PUBLIC_BASE is not configured: cannot download ${r2Key} for posting (set an R2 public bucket URL or a signed-URL service)`,
    );
  }
  const response = await fetch(`${R2_PUBLIC_BASE.replace(/\/$/, "")}/${r2Key}`);
  if (!response.ok) throw new Error(`artifact download failed: HTTP ${response.status}`);
  const path = join(tmpdir(), `ventriloquist-${Date.now()}.mp4`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

async function renderArtifact(body: JobBody): Promise<string> {
  const command = process.env.RENDER_COMMAND;
  if (!command) {
    throw new Error(
      "RENDER_COMMAND is not configured: set it to the nobodynamed-video render invocation, e.g. `nbn render --story {story} --out {out}`",
    );
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const out = join(tmpdir(), `ventriloquist-render-${body.job_id}.mp4`);
  const rendered = command
    .replace("{story}", body.render_spec?.story ?? "")
    .replace("{out}", out);
  await run("/bin/sh", ["-c", rendered], {
    cwd: process.env.NBN_REPO_DIR ?? process.cwd(),
    maxBuffer: 32 * 1024 * 1024,
  });
  return out;
}

async function report(payload: {
  job_id: string;
  status: string;
  tiktok_url: string | null;
  error: string | null;
}): Promise<void> {
  if (!FACADE_URL) {
    app.log.warn({ payload }, "FACADE_URL unset: job status not reported back");
    return;
  }
  try {
    await fetch(`${FACADE_URL.replace(/\/$/, "")}/admin/job-callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(FACADE_CALLBACK_TOKEN ? { authorization: `Bearer ${FACADE_CALLBACK_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    app.log.error({ err: error, jobId: payload.job_id }, "failed to report job status");
  }
}

await app.listen({ port: PORT, host: "0.0.0.0" });
app.log.info({ port: PORT, dryRun: DRY_RUN }, "ventriloquist posting worker up");
