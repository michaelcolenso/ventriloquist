import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobStateStore } from "../src/jobState";

const NOW = 1_800_000_000;
const dirs: string[] = [];

async function store(staleAfterSeconds = 1_800): Promise<JobStateStore> {
  const dir = await mkdtemp(join(tmpdir(), "ventriloquist-jobs-"));
  dirs.push(dir);
  return new JobStateStore(join(dir, "job-state.json"), staleAfterSeconds);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("job idempotency", () => {
  it("claims a job once and replays the recorded outcome", async () => {
    const state = await store();
    const first = await state.claim("job-1", NOW);
    expect(first.claimed).toBe(true);

    const second = await state.claim("job-1", NOW + 5);
    expect(second.claimed).toBe(false);
    expect(second.record.status).toBe("running");

    await state.complete("job-1", { status: "posted", tiktokUrl: "https://t/v/1" }, NOW + 10);
    const third = await state.claim("job-1", NOW + 20);
    expect(third.claimed).toBe(false);
    expect(third.record.tiktokUrl).toBe("https://t/v/1");
  });

  it("survives a restart by reading the state file", async () => {
    const state = await store();
    const file = (state as unknown as { file: string }).file;
    await state.claim("job-2", NOW);
    await state.complete("job-2", { status: "failed", error: "selector drift" }, NOW + 1);

    const reloaded = new JobStateStore(file);
    const record = await reloaded.get("job-2");
    expect(record?.status).toBe("failed");
    expect((await reloaded.claim("job-2", NOW + 2)).claimed).toBe(false);
  });

  it("re-claims a stale in-flight job after a crashed run", async () => {
    const state = await store(60);
    await state.claim("job-3", NOW);
    expect((await state.claim("job-3", NOW + 30)).claimed).toBe(false);
    expect((await state.claim("job-3", NOW + 120)).claimed).toBe(true);
  });
});
