import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type AppDeps, type JobOutcome } from "../src/app";
import { JobStateStore } from "../src/jobState";
import type { SessionStatus } from "../src/sessions";
import type { StudioAnalyticsRow } from "../src/studio";

const NOW = 1_800_000_000;
const dirs: string[] = [];
const TOKEN = "shared-token";

const session: SessionStatus = {
  cookie_count: 3,
  names: ["sessionid", "ttwid", "msToken"],
  has_sessionid: true,
  stale: false,
  detail: "session looks usable",
  file_age_days: 1,
  expires_at: null,
};

async function harness(overrides: Partial<AppDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ventriloquist-app-"));
  dirs.push(dir);
  const alerts: string[] = [];
  const runner = vi.fn(
    async (): Promise<JobOutcome> => ({
      status: "posted",
      tiktokUrl: "https://www.tiktok.com/@nobodynamed/video/1",
      videoR2Key: "renders/2026-09-17/job-1.mp4",
      error: null,
      postedAt: NOW,
    }),
  );
  const app = Fastify({ logger: false });
  buildApp({
    app,
    postingWorkerToken: TOKEN,
    callbackToken: TOKEN,
    facadeUrl: "",
    postingHandle: "nobodynamed",
    dryRun: true,
    sessionFile: "sessions/nobodynamed.json.age",
    state: new JobStateStore(join(dir, "job-state.json")),
    runner,
    scraper: async (): Promise<StudioAnalyticsRow[]> => [
      {
        video_id: "1",
        watch_time_seconds: 12,
        average_watch_time_seconds: 4,
        full_watch_rate: 0.4,
        traffic_sources: [],
        retention: [],
        captured_at: NOW,
      },
    ],
    sessionStatus: async () => session,
    alert: async (text: string) => {
      alerts.push(text);
      return true;
    },
    ...overrides,
  });
  await app.ready();
  return { app, alerts, runner };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("posting worker http surface", () => {
  it("rejects /jobs without the shared token", async () => {
    const { app } = await harness();
    const response = await app.inject({ method: "POST", url: "/jobs", payload: { job_id: "j" } });
    expect(response.statusCode).toBe(401);
  });

  it("runs a job once and replays duplicate dispatch", async () => {
    const { app, runner } = await harness();
    const payload = {
      job_id: "job-1",
      kind: "post" as const,
      video_r2_key: "renders/x.mp4",
      caption: "hi",
      hashtags: [],
      scheduled_at: null,
      render_spec: null,
    };
    const headers = { "x-facade-call-token": TOKEN };

    const first = await app.inject({ method: "POST", url: "/jobs", headers, payload });
    expect(first.statusCode).toBe(202);

    await vi.waitFor(async () => {
      const replay = await app.inject({ method: "POST", url: "/jobs", headers, payload });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ duplicate: true, status: "posted" });
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("reports a failed job and alerts when the callback cannot be delivered", async () => {
    const { app, alerts } = await harness({
      runner: async () => {
        throw new Error("render command exited 1");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { "x-facade-call-token": TOKEN },
      payload: { job_id: "job-fail", kind: "post", video_r2_key: null },
    });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(alerts.some((text) => text.includes("facade callback failed"))).toBe(true);
    });
  });

  it("returns scraped rows and alerts on scrape failure", async () => {
    const { app } = await harness();
    const ok = await app.inject({
      method: "POST",
      url: "/studio-scrape",
      headers: { "x-facade-call-token": TOKEN },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ accepted: true, count: 1 });

    const failing = await harness({
      scraper: async () => {
        throw new Error("burner session expired");
      },
    });
    const failed = await failing.app.inject({
      method: "POST",
      url: "/studio-scrape",
      headers: { "x-facade-call-token": TOKEN },
      payload: {},
    });
    expect(failed.statusCode).toBe(502);
    expect(failing.alerts.some((text) => text.includes("burner session expired"))).toBe(true);
  });

  it("reports session staleness and alerts", async () => {
    const { app, alerts } = await harness({
      sessionStatus: async () => ({
        ...session,
        stale: true,
        detail: "sessionid cookie is missing",
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/session/refresh",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stale: true });
    expect(alerts.some((text) => text.includes("sessionid cookie is missing"))).toBe(true);
  });

  it("exposes health without leaking cookie values", async () => {
    const { app } = await harness();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { session: { stale: boolean } };
    expect(body.session.stale).toBe(false);
    expect(response.body).not.toContain("cookie_value");
  });
});
