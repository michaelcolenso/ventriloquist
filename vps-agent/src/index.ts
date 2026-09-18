import Fastify from "fastify";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlertSender } from "./alerts";
import { buildApp, type JobBody, type JobOutcome } from "./app";
import { JobStateStore } from "./jobState";
import { R2Client, r2ConfigFromEnv, renderArtifactKey } from "./r2";
import { inspectSession, type SessionCustodyOptions } from "./sessions";
import { scrapeStudioAnalytics } from "./studio";
import { PostingWorker } from "./uploader";

/** One shared secret both directions: facade -> /jobs and VPS -> job-callback. */
const FACADE_CALLBACK_TOKEN = process.env.FACADE_CALLBACK_TOKEN ?? "";
const FACADE_URL = process.env.FACADE_URL ?? "";
const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/chromium";
const USER_DATA_DIR = process.env.POSTING_USER_DATA_DIR ?? "./sessions/posting-profile";
const BURNER_USER_DATA_DIR = process.env.BURNER_USER_DATA_DIR ?? "./sessions/burner-profile";
const SESSION_FILE = process.env.POSTING_SESSION_FILE ?? "./sessions/nobodynamed.json.age";
const BURNER_SESSION_FILE = process.env.BURNER_SESSION_FILE ?? SESSION_FILE;
const POSTING_HANDLE = process.env.POSTING_HANDLE ?? "nobodynamed";
const DRY_RUN = process.env.POSTING_DRY_RUN === "1";
const TIMEZONE_OFFSET_MINUTES = Number(process.env.POSTING_TZ_OFFSET_MINUTES ?? -420);
const SESSION_MAX_AGE_DAYS = Number(process.env.POSTING_SESSION_MAX_AGE_DAYS ?? 30);
const RENDER_COMMAND = process.env.RENDER_COMMAND ?? "";
const NBN_REPO_DIR = process.env.NBN_REPO_DIR ?? process.cwd();

function sessionOptions(file: string): SessionCustodyOptions {
  return {
    sessionFile: file,
    ...(process.env.POSTING_SESSION_AGE_CMD
      ? { decryptCommand: process.env.POSTING_SESSION_AGE_CMD }
      : {}),
    ...(process.env.POSTING_SESSION_PLAINTEXT === "1" ? { allowPlaintext: true } : {}),
  };
}

const postingSession = sessionOptions(SESSION_FILE);
const burnerSession = sessionOptions(BURNER_SESSION_FILE);
const r2Config = r2ConfigFromEnv(process.env);
const r2 = r2Config ? new R2Client(r2Config) : null;

const app = Fastify({ logger: true });
const alert = createAlertSender(process.env, app.log);

const worker = new PostingWorker({
  ...postingSession,
  executablePath: CHROME_EXECUTABLE_PATH,
  userDataDir: USER_DATA_DIR,
  headless: process.env.SIGNER_HEADLESS !== "0",
  timeoutMs: Number(process.env.POSTING_TIMEOUT_MS ?? 60_000),
  pacing: {},
  profileHandle: POSTING_HANDLE,
  dryRun: DRY_RUN,
});

async function downloadArtifact(key: string, tempFiles: string[]): Promise<string> {
  let bytes: Uint8Array;
  if (r2) {
    bytes = await r2.get(key);
  } else if (process.env.R2_PUBLIC_BASE) {
    const response = await fetch(
      `${process.env.R2_PUBLIC_BASE.replace(/\/$/, "")}/${key.replace(/^\//, "")}`,
    );
    if (!response.ok) throw new Error(`artifact download failed: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    throw new Error(
      `no artifact source configured for ${key}: set the R2 S3 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET) or R2_PUBLIC_BASE`,
    );
  }
  const path = join(tmpdir(), `ventriloquist-${Date.now()}.mp4`);
  await writeFile(path, bytes);
  tempFiles.push(path);
  return path;
}

async function renderArtifact(body: JobBody, tempFiles: string[]): Promise<string> {
  if (!RENDER_COMMAND) {
    throw new Error(
      "RENDER_COMMAND is not configured: set it to the nobodynamed-video render invocation, e.g. `nbn render --story {story} --out {out}`",
    );
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const out = join(tmpdir(), `ventriloquist-render-${body.job_id}.mp4`);
  const rendered = RENDER_COMMAND.replace("{story}", body.render_spec?.story ?? "").replace(
    "{out}",
    out,
  );
  await run("/bin/sh", ["-c", rendered], { cwd: NBN_REPO_DIR, maxBuffer: 32 * 1024 * 1024 });
  tempFiles.push(out);
  return out;
}

async function executeJob(body: JobBody): Promise<JobOutcome> {
  const tempFiles: string[] = [];
  try {
    let videoR2Key = body.video_r2_key;
    let videoPath: string;
    if (body.video_r2_key) {
      videoPath = await downloadArtifact(body.video_r2_key, tempFiles);
    } else {
      videoPath = await renderArtifact(body, tempFiles);
      if (r2) {
        const key = renderArtifactKey(body.job_id);
        await r2.put(key, await readFile(videoPath));
        videoR2Key = key;
      } else {
        app.log.warn(
          { jobId: body.job_id },
          "R2 is not configured: the rendered artifact will not be retained",
        );
      }
    }

    const result = await worker.post({
      videoPath,
      caption: body.caption,
      hashtags: body.hashtags ?? [],
      scheduledAt: body.scheduled_at,
      timezoneOffsetMinutes: TIMEZONE_OFFSET_MINUTES,
    });

    return {
      status: result.skipped ? "queued" : result.ok ? "posted" : "failed",
      tiktokUrl: result.tiktokUrl,
      videoR2Key,
      error: result.ok ? null : result.detail,
      postedAt: result.postedAt,
    };
  } finally {
    await Promise.all(
      tempFiles.map((file) => rm(file, { force: true }).catch(() => undefined)),
    );
  }
}

buildApp({
  app,
  postingWorkerToken: FACADE_CALLBACK_TOKEN,
  callbackToken: FACADE_CALLBACK_TOKEN,
  facadeUrl: FACADE_URL,
  postingHandle: POSTING_HANDLE,
  dryRun: DRY_RUN,
  sessionFile: SESSION_FILE,
  state: new JobStateStore(process.env.POSTING_STATE_FILE ?? "./sessions/job-state.json"),
  runner: executeJob,
  scraper: () =>
    scrapeStudioAnalytics({
      ...burnerSession,
      executablePath: CHROME_EXECUTABLE_PATH,
      userDataDir: BURNER_USER_DATA_DIR,
      headless: process.env.SIGNER_HEADLESS !== "0",
      timeoutMs: Number(process.env.POSTING_TIMEOUT_MS ?? 60_000),
    }),
  sessionStatus: () => inspectSession({ ...postingSession, maxAgeDays: SESSION_MAX_AGE_DAYS }),
  alert,
});

await app.listen({ port: Number(process.env.PORT ?? 8799), host: "0.0.0.0" });
app.log.info({ dryRun: DRY_RUN, r2: Boolean(r2) }, "ventriloquist posting worker up");
