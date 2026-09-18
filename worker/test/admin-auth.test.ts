import { describe, expect, it, vi } from "vitest";
import { handleRequest, authorizeAdmin } from "../src/http/router";
import { authorizeJobCallback, handleJobCallback } from "../src/jobs/consumer";
import { sendAlert } from "../src/lib/alerts";
import { fakeD1, fakeKV } from "./support/fakes";

const NOW = 1_800_000_000;

function adminRequest(path: string, token?: string, method = "POST"): Request {
  return new Request(`https://facade.test${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: method === "POST" ? JSON.stringify({ daily_usd: 1 }) : undefined,
  });
}

function env(overrides: Record<string, unknown> = {}): never {
  return {
    DB: fakeD1(() => ({})),
    KV: fakeKV(),
    ADMIN_TOKEN: "admin-token",
    FACADE_CALLBACK_TOKEN: "callback-token",
    ...overrides,
  } as never;
}

describe("admin authentication", () => {
  it("fails closed when ADMIN_TOKEN is unset", async () => {
    const response = await handleRequest(
      adminRequest("/admin/budget"),
      env({ ADMIN_TOKEN: undefined }),
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const response = await handleRequest(adminRequest("/admin/budget", "nope"), env(), {
      waitUntil: () => undefined,
    });
    expect(response.status).toBe(401);
  });

  it("allows an authenticated admin call through", async () => {
    const response = await handleRequest(
      adminRequest("/admin/budget", "admin-token"),
      env(),
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("exposes a direct predicate for reuse", () => {
    expect(authorizeAdmin(adminRequest("/admin/budget", "admin-token"), env())).toBe(true);
    expect(authorizeAdmin(adminRequest("/admin/budget"), env())).toBe(false);
  });
});

describe("job callback authentication", () => {
  function callbackRequest(token?: string): Request {
    return new Request("https://facade.test/admin/job-callback", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({
        job_id: "job-1",
        status: "posted",
        tiktok_url: "https://www.tiktok.com/@nobodynamed/video/1",
        video_r2_key: "renders/2026-09-17/job-1.mp4",
      }),
    });
  }

  it("rejects callbacks without the shared token", async () => {
    const response = await handleJobCallback(callbackRequest(), env());
    expect(response.status).toBe(401);
  });

  it("fails closed when FACADE_CALLBACK_TOKEN is unset", () => {
    expect(
      authorizeJobCallback(callbackRequest("callback-token"), env({ FACADE_CALLBACK_TOKEN: undefined })),
    ).toBe(false);
  });

  it("accepts a signed callback and records the artifact key", async () => {
    const statements: string[] = [];
    const db = fakeD1((sql) => {
      statements.push(sql);
      if (sql.includes("SELECT status FROM post_jobs")) return { all: [] };
      return {};
    });
    const response = await handleJobCallback(
      callbackRequest("callback-token"),
      env({ DB: db }) as never,
    );
    expect(response.status).toBe(200);
    expect(statements.some((sql) => sql.includes("video_r2_key = ?"))).toBe(true);
  });
});

describe("telegram alerts", () => {
  it("is a silent no-op when unconfigured", async () => {
    await expect(sendAlert({}, "hello")).resolves.toBe(false);
  });

  it("posts the message to the configured chat", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const ok = await sendAlert(
      { ALERT_TELEGRAM_BOT_TOKEN: "bot-token", ALERT_TELEGRAM_CHAT_ID: "42" },
      "posting halted",
      { fetcher: fetcher as unknown as typeof fetch },
    );
    expect(ok).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/botbot-token/sendMessage");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.chat_id).toBe("42");
    expect(String(body.text)).toContain("posting halted");
  });

  it("never throws when delivery fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      sendAlert(
        { ALERT_TELEGRAM_BOT_TOKEN: "t", ALERT_TELEGRAM_CHAT_ID: "1" },
        "x",
        { fetcher: failing as unknown as typeof fetch },
      ),
    ).resolves.toBe(false);
    const rejected = vi.fn(async () => new Response("no", { status: 500 }));
    await expect(
      sendAlert(
        { ALERT_TELEGRAM_BOT_TOKEN: "t", ALERT_TELEGRAM_CHAT_ID: "1" },
        "x",
        { fetcher: rejected as unknown as typeof fetch },
      ),
    ).resolves.toBe(false);
  });
});

describe("studio analytics writes", () => {
  it("filters unusable rows and batches the rest", async () => {
    const { buildStudioAnalyticsStatements, writeStudioAnalytics } = await import(
      "../src/storage/analytics"
    );
    const db = fakeD1(() => ({}));
    const statements = buildStudioAnalyticsStatements(db, [
      { video_id: "1", captured_at: NOW, watch_time_seconds: 12 },
      { captured_at: NOW },
      "nonsense",
    ]);
    expect(statements).toHaveLength(1);
    await expect(writeStudioAnalytics(db, [{ video_id: "1", captured_at: NOW }])).resolves.toBe(1);
  });
});

describe("cron -> posting worker dispatch", () => {
  it("authenticates with the header the VPS worker accepts", async () => {
    const { callPostingWorker } = await import("../src/cron");
    const fetcher = vi.fn(async (_input: Request | string, _init?: RequestInit) =>
      Response.json({ accepted: true, stale: false }),
    );
    const result = await callPostingWorker(
      {
        env: { POSTING_WORKER_URL: "http://vps.test:8799", POSTING_WORKER_TOKEN: "vps-token" },
        fetcher,
      } as never,
      "/session/refresh",
      { requested_at: NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({ accepted: true });
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-facade-call-token"]).toBe("vps-token");
  });
});
