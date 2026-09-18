import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type JobStatus = "running" | "posted" | "failed" | "queued";

export interface JobRecord {
  status: JobStatus;
  tiktokUrl: string | null;
  videoR2Key: string | null;
  error: string | null;
  updatedAt: number;
}

export interface ClaimResult {
  claimed: boolean;
  record: JobRecord;
}

/**
 * Durable dispatch ledger for RED jobs.
 *
 * Cloudflare Queues retries dispatch when a response is lost, and a retried
 * RED action must never post twice. A job id is claimed once and replayed
 * from this file afterwards; a claim older than `staleAfterSeconds` is
 * treated as a crashed run and may be retried.
 */
export class JobStateStore {
  private cache: Record<string, JobRecord> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly staleAfterSeconds = 30 * 60,
  ) {}

  private async load(): Promise<Record<string, JobRecord>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file, "utf8");
      this.cache = JSON.parse(raw) as Record<string, JobRecord>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.cache ?? {}, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, this.file);
    });
    await this.writeChain;
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const state = await this.load();
    return state[jobId] ?? null;
  }

  async claim(jobId: string, now = Math.floor(Date.now() / 1000)): Promise<ClaimResult> {
    const state = await this.load();
    const existing = state[jobId];
    if (existing) {
      const inFlight = existing.status === "running" || existing.status === "queued";
      const stale = now - existing.updatedAt > this.staleAfterSeconds;
      if (!inFlight || !stale) return { claimed: false, record: existing };
    }
    const record: JobRecord = {
      status: "running",
      tiktokUrl: existing?.tiktokUrl ?? null,
      videoR2Key: existing?.videoR2Key ?? null,
      error: existing?.error ?? null,
      updatedAt: now,
    };
    state[jobId] = record;
    await this.persist();
    return { claimed: true, record };
  }

  async complete(
    jobId: string,
    patch: Partial<Omit<JobRecord, "updatedAt">>,
    now = Math.floor(Date.now() / 1000),
  ): Promise<JobRecord> {
    const state = await this.load();
    const record: JobRecord = {
      status: patch.status ?? "failed",
      tiktokUrl: patch.tiktokUrl ?? null,
      videoR2Key: patch.videoR2Key ?? null,
      error: patch.error ?? null,
      updatedAt: now,
    };
    state[jobId] = record;
    await this.persist();
    return record;
  }
}
