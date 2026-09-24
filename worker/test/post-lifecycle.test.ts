import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/http/router";
import { consumeQueue, handleJobCallback } from "../src/jobs/consumer";
import {
  consecutivePostFailures,
  getPostJob,
  updateJobStatus,
  type PostJobMessage,
} from "../src/storage/jobs";
import { fakeKV } from "./support/fakes";
import { sqliteD1 } from "./support/sqlite";

const NOW = Math.floor(Date.now() / 1000);

function setup() {
  const { db, raw } = sqliteD1();
  const kv = fakeKV();
  const env = {
    DB: db,
    KV: kv,
    ADMIN_TOKEN: "admin-token",
    FACADE_CALLBACK_TOKEN: "callback-token",
    POSTING_WORKER_URL: "https://vps.test",
    POSTING_WORKER_TOKEN: "callback-token",
  } as never;
  const insert = (jobId: string, status: string, createdAt = NOW - 60, updatedAt = createdAt) =>
    raw
      .prepare(
        `INSERT INTO post_jobs (job_id, status, kind, caption, hashtags, created_at, updated_at)
         VALUES (?, ?, 'post', 'c', '[]', ?, ?)`,
      )
      .run(jobId, status, createdAt, updatedAt);
  return { db, raw, kv, env, insert };
}

function batchOf(jobId: string, attempts = 1) {
  const message = {
    body: { jobId, kind: "post" } as PostJobMessage,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const batch = { queue: "posting", messages: [message] } as unknown as MessageBatch<PostJobMessage>;
  return { batch, message };
}

function callback(body: Record<string, unknown>): Request {
  return new Request("https://facade.test/admin/job-callback", {
    method: "POST",
    headers: { authorization: "Bearer callback-token" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("job status guard", () => {
  it("does not let dispatch bookkeeping overwrite a recorded outcome", async () => {
    const { db, insert } = setup();
    insert("job-a", "failed");
    const changed = await updateJobStatus(db, "job-a", { status: "running", unlessTerminal: true }, NOW);
    expect(changed).toBe(false);
    expect((await getPostJob(db, "job-a"))?.status).toBe("failed");
  });

  it("still advances a job that has not settled", async () => {
    const { db, insert } = setup();
    insert("job-b", "queued");
    expect(await updateJobStatus(db, "job-b", { status: "running", unlessTerminal: true }, NOW)).toBe(true);
    expect((await getPostJob(db, "job-b"))?.status).toBe("running");
  });
});

describe("queue consumer lifecycle", () => {
  it("keeps a fast failure callback that lands before the dispatch response", async () => {
    const { db, env, insert } = setup();
    insert("job-fast", "queued");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // The VPS fails immediately and reports back before answering 202.
        await handleJobCallback(
          callback({ job_id: "job-fast", status: "failed", error: "artifact download failed" }),
          env,
        );
        return new Response(JSON.stringify({ accepted: true, job_id: "job-fast" }), { status: 202 });
      }),
    );
    const { batch, message } = batchOf("job-fast");
    await consumeQueue(batch, env, { waitUntil: () => undefined });
    const job = await getPostJob(db, "job-fast");
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("artifact download failed");
    expect(message.ack).toHaveBeenCalled();
  });

  it("adopts the VPS record when a redelivered job is a duplicate", async () => {
    const { db, env, insert } = setup();
    insert("job-dup", "queued");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ accepted: false, duplicate: true, job_id: "job-dup", status: "dry_run", error: null }),
      ),
    );
    await consumeQueue(batchOf("job-dup").batch, env, { waitUntil: () => undefined });
    expect((await getPostJob(db, "job-dup"))?.status).toBe("dry_run");
  });

  it("acks settled jobs without dispatching them again", async () => {
    const { env, insert } = setup();
    insert("job-done", "dry_run");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { batch, message } = batchOf("job-done");
    await consumeQueue(batch, env, { waitUntil: () => undefined });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it("holds already-queued jobs once posting is halted", async () => {
    const { db, env, insert } = setup();
    insert("fail-1", "failed", NOW - 600);
    insert("fail-2", "failed", NOW - 300);
    insert("job-late", "queued");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await consumeQueue(batchOf("job-late").batch, env, { waitUntil: () => undefined });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = await getPostJob(db, "job-late");
    expect(job?.status).toBe("held");
    expect(job?.error).toMatch(/halted/);
  });

  it("does not let a stale in-progress callback overwrite an outcome", async () => {
    const { db, env, insert } = setup();
    insert("job-posted", "posted");
    await handleJobCallback(callback({ job_id: "job-posted", status: "queued" }), env);
    expect((await getPostJob(db, "job-posted"))?.status).toBe("posted");
  });
});

describe("posting halt", () => {
  it("ignores dry runs and held jobs when counting a failure streak", async () => {
    const { db, insert } = setup();
    insert("fail-1", "failed", NOW - 900);
    insert("dry", "dry_run", NOW - 600);
    insert("held", "held", NOW - 450);
    insert("fail-2", "failed", NOW - 300);
    expect(await consecutivePostFailures(db, NOW)).toBe(2);
  });

  it("clears through the admin route and reports held jobs", async () => {
    const { db, env, insert } = setup();
    insert("fail-1", "failed", NOW - 600);
    insert("fail-2", "failed", NOW - 300);
    insert("job-held", "held", NOW - 200);
    expect(await consecutivePostFailures(db, NOW)).toBe(2);

    const response = await handleRequest(
      new Request("https://facade.test/admin/posting/clear-halt", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { held_jobs: { job_id: string }[]; cleared_at: number };
    expect(body.held_jobs.map((job) => job.job_id)).toEqual(["job-held"]);
    expect(await consecutivePostFailures(db, NOW, body.cleared_at)).toBe(0);
  });
});
