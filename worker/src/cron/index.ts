import type { AppContext } from "../mcp/context";
import { createAppContext } from "../mcp/context";
import type { Env } from "../env";
import { createLogger } from "../lib/logger";
import { DAY } from "../lib/time";
import { ProviderError, errorMessage } from "../lib/errors";
import type { TrendingHashtag, TrendingSound, Video, HashtagStats, SoundStats } from "../domain/models";
import {
  buildHashtagSnapshotStatements,
  buildSoundSnapshotStatements,
  buildVideoSnapshotStatements,
} from "../storage/snapshots";
import { writeStudioAnalytics } from "../storage/analytics";
import { compactSnapshots } from "../velocity/engine";
import { sendAlert } from "../lib/alerts";

export interface CronResult {
  summary: string;
  data?: Record<string, unknown>;
}

export type CronJob = (ctx: AppContext) => Promise<CronResult>;

/**
 * Cron dispatch (spec 5.2). Each schedule has its own expression in
 * wrangler.toml so the dispatcher can key off the cron string directly.
 */
export const CRON_JOBS: Record<string, CronJob> = {
  "*/15 * * * *": signerCanary,
  "5 */4 * * *": snapshotWatchlist,
  "35 */4 * * *": snapshotCreativeCenter,
  "15 */6 * * *": snapshotShadowCohort,
  "45 */6 * * *": snapshotOwnAccount,
  "30 9 * * *": studioDeepScrape,
  "0 7 * * 1": weeklyMaintenance,
};

export async function runCron(
  cron: string,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  const logger = createLogger("info", { cron });
  const app = createAppContext(env, {
    waitUntil: (promise) => ctx.waitUntil(promise),
    logger,
  });
  const job = CRON_JOBS[cron];
  if (!job) {
    logger.warn("no handler for cron expression");
    return;
  }
  try {
    const result = await job(app);
    logger.info("cron completed", { summary: result.summary, data: result.data });
  } catch (error) {
    logger.error("cron failed", { error: errorMessage(error) });
  }
}

/**
 * Signer canary: force one signed read through the self-hosted path so the
 * circuit breaker reflects reality. The router's normal failover would mask a
 * dead signer, so this deliberately bypasses it.
 */
async function signerCanary(ctx: AppContext): Promise<CronResult> {
  const provider = ctx.backends.registry.list().find((entry) => entry.name === "signer");
  if (!provider) {
    return { summary: "signer canary skipped: no signer provider configured" };
  }

  const startedAt = Date.now();
  try {
    const hashtag = ctx.env.DEFAULT_REGION === "GB" ? "names" : "babynames";
    await provider.execute(
      "hashtag_stats",
      { hashtag },
      {
        env: ctx.env,
        region: ctx.region,
        now: ctx.now,
        fetch: ctx.fetcher,
        logger: ctx.logger,
      },
    );
    const latencyMs = Date.now() - startedAt;
    await ctx.backends.health.recordSuccess("signer", latencyMs, ctx.now);
    return { summary: `signer healthy (${latencyMs}ms)`, data: { latencyMs } };
  } catch (error) {
    const message = errorMessage(error);
    const countsTowardBreaker = error instanceof ProviderError ? error.countsTowardBreaker : true;
    const { tripped, health } = await ctx.backends.health.recordFailure("signer", ctx.now, message, {
      countsTowardBreaker,
    });
    if (tripped) {
      await sendAlert(
        ctx.env,
        `signer circuit breaker tripped: ${message}. Reads now depend on the configured fallback providers.`,
        { fetcher: ctx.fetcher, logger: ctx.logger },
      );
    }
    return {
      summary: `signer canary failed: ${message}`,
      data: { tripped, consecutiveFailures: health.consecutiveFailures, circuitOpenUntil: health.circuitOpenUntil },
    };
  }
}

const WATCHLIST_BATCH = 40;
const COHORT_BATCH = 10;

/** Rotate through a list so one cron never exceeds its budget. */
async function rotate<T>(ctx: AppContext, key: string, items: T[], batchSize: number): Promise<T[]> {
  if (items.length <= batchSize) return items;
  const stored = await ctx.env.KV.get(`cron:cursor:${key}`);
  const cursor = stored ? Number(stored) % items.length : 0;
  const slice: T[] = [];
  for (let index = 0; index < batchSize; index += 1) {
    slice.push(items[(cursor + index) % items.length]!);
  }
  await ctx.env.KV.put(`cron:cursor:${key}`, String((cursor + batchSize) % items.length));
  return slice;
}

async function snapshotWatchlist(ctx: AppContext): Promise<CronResult> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT entity_type, entity_id, niche FROM watchlist WHERE active = 1 ORDER BY entity_id`,
  ).all<{ entity_type: string; entity_id: string; niche: string | null }>();

  const entities = results ?? [];
  const batch = await rotate(ctx, "watchlist", entities, WATCHLIST_BATCH);
  let hashtags = 0;
  let sounds = 0;
  let accounts = 0;
  const failures: string[] = [];

  for (const entity of batch) {
    try {
      if (entity.entity_type === "hashtag") {
        const execution = await ctx.route<HashtagStats>("hashtag_stats", {
          hashtag: entity.entity_id,
        });
        hashtags += 1;
        ctx.snapshot(
          buildHashtagSnapshotStatements(ctx.env.DB, [execution.value], ctx.now),
        );
      } else if (entity.entity_type === "sound") {
        const execution = await ctx.route<SoundStats>("sound_stats", { sound_id: entity.entity_id });
        sounds += 1;
        ctx.snapshot(buildSoundSnapshotStatements(ctx.env.DB, [execution.value], ctx.now));
      } else if (entity.entity_type === "account") {
        const execution = await ctx.route<{ items: Video[] }>("profile_videos", {
          username: entity.entity_id,
          count: 10,
        });
        accounts += 1;
        ctx.snapshot(
          buildVideoSnapshotStatements(
            ctx.env.DB,
            execution.value.items ?? [],
            ctx.now,
            execution.source,
          ),
        );
      }
    } catch (error) {
      failures.push(`${entity.entity_type}:${entity.entity_id} ${errorMessage(error)}`);
    }
  }

  return {
    summary: `watchlist snapshots: ${hashtags} hashtags, ${sounds} sounds, ${accounts} accounts (${failures.length} failures)`,
    data: { batch: batch.length, total: entities.length, failures: failures.slice(0, 10) },
  };
}

async function snapshotCreativeCenter(ctx: AppContext): Promise<CronResult> {
  const executions = await Promise.allSettled([
    ctx.route<TrendingHashtag[]>("trending", {
      mode: "hashtags",
      region: ctx.region,
      count: 200,
      period: 7,
    }),
    ctx.route<TrendingSound[]>("trending", {
      mode: "songs",
      region: ctx.region,
      count: 200,
      period: 7,
    }),
  ]);

  const errors: string[] = [];
  let hashtagRows: TrendingHashtag[] = [];
  let soundRows: TrendingSound[] = [];

  const [hashtagResult, soundResult] = executions;
  if (hashtagResult.status === "fulfilled") hashtagRows = hashtagResult.value.value ?? [];
  else errors.push(`hashtags: ${errorMessage(hashtagResult.reason)}`);
  if (soundResult.status === "fulfilled") soundRows = soundResult.value.value ?? [];
  else errors.push(`sounds: ${errorMessage(soundResult.reason)}`);

  ctx.snapshot(
    buildHashtagSnapshotStatements(
      ctx.env.DB,
      hashtagRows.map((row) => ({
        id: row.id,
        name: row.name,
        description: null,
        videoCount: row.publishCount,
        viewCount: row.viewCount,
        url: row.url,
        source: row.source,
      })),
      ctx.now,
    ),
  );
  ctx.snapshot(
    buildSoundSnapshotStatements(
      ctx.env.DB,
      soundRows.map((row) => ({
        id: row.id,
        title: row.title,
        author: row.author,
        original: false,
        durationSeconds: row.durationSeconds,
        videoCount: null,
        userCount: row.userCount,
        coverUrl: row.coverUrl,
        playUrl: row.playUrl,
        source: row.source,
      })),
      ctx.now,
    ),
  );

  // Auto-add rising entities to the watchlist (spec 5.2).
  const risingHashtags = hashtagRows
    .filter((row) => row.isNew || (row.rankDiff ?? 0) > 0)
    .slice(0, 40);
  const risingSounds = soundRows
    .filter((row) => row.isNew || (row.rankDiff ?? 0) > 0)
    .slice(0, 20);

  const statements = [
    ...risingHashtags.map((row) =>
      ctx.env.DB.prepare(
        `INSERT INTO watchlist (entity_type, entity_id, niche, added_at, active)
         VALUES ('hashtag', ?, NULL, ?, 1)
         ON CONFLICT (entity_type, entity_id) DO UPDATE SET active = 1`,
      ).bind(row.name.toLowerCase(), ctx.now),
    ),
    ...risingSounds
      .filter((row) => row.id)
      .map((row) =>
        ctx.env.DB.prepare(
          `INSERT INTO watchlist (entity_type, entity_id, niche, added_at, active)
           VALUES ('sound', ?, NULL, ?, 1)
           ON CONFLICT (entity_type, entity_id) DO UPDATE SET active = 1`,
        ).bind(row.id as string, ctx.now),
      ),
  ];
  if (statements.length > 0) await ctx.env.DB.batch(statements);

  return {
    summary: `creative center: ${hashtagRows.length} hashtags + ${soundRows.length} sounds snapshotted, ${statements.length} rising entities watchlisted`,
    data: { errors },
  };
}

async function snapshotShadowCohort(ctx: AppContext): Promise<CronResult> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT username FROM shadow_cohort ORDER BY username`,
  ).all<{ username: string }>();
  const accounts = results ?? [];
  const batch = await rotate(
    ctx,
    "cohort",
    accounts.map((row) => row.username),
    COHORT_BATCH,
  );

  let ok = 0;
  const failures: string[] = [];
  for (const username of batch) {
    try {
      const execution = await ctx.route<{ items: Video[] }>("profile_videos", {
        username,
        count: 10,
      });
      ok += 1;
      ctx.snapshot(
        buildVideoSnapshotStatements(
          ctx.env.DB,
          execution.value.items ?? [],
          ctx.now,
          execution.source,
        ),
      );
    } catch (error) {
      failures.push(`${username}: ${errorMessage(error)}`);
    }
  }

  return {
    summary: `shadow cohort: ${ok}/${batch.length} accounts snapshotted (${failures.length} failures)`,
    data: { cohortSize: accounts.length, failures: failures.slice(0, 10) },
  };
}

async function snapshotOwnAccount(ctx: AppContext): Promise<CronResult> {
  const handle = ctx.ownHandle();
  const execution = await ctx.route<{ items: Video[] }>("profile_videos", {
    username: handle,
    count: 20,
  });
  const videos = execution.value.items ?? [];
  ctx.snapshot(buildVideoSnapshotStatements(ctx.env.DB, videos, ctx.now, execution.source));
  return {
    summary: `own account @${handle}: ${videos.length} videos snapshotted via ${execution.provider}`,
    data: { videos: videos.length, provider: execution.provider },
  };
}

/** AMBER work happens on the VPS; the Worker only schedules it. */
async function studioDeepScrape(ctx: AppContext): Promise<CronResult> {
  const dispatched = await callPostingWorker(ctx, "/studio-scrape", { requested_at: ctx.now });
  if (!dispatched.ok) {
    await sendAlert(ctx.env, `studio deep scrape failed: ${dispatched.detail}`, {
      fetcher: ctx.fetcher,
      logger: ctx.logger,
    });
    return {
      summary: `studio deep scrape not dispatched: ${dispatched.detail}`,
      data: dispatched,
    };
  }
  const rows = Array.isArray(dispatched.body?.rows) ? (dispatched.body.rows as unknown[]) : [];
  const written = await writeStudioAnalytics(ctx.env.DB, rows);
  return {
    summary: `studio deep scrape: ${written} analytics rows written from ${rows.length} scraped rows`,
    data: {
      ok: dispatched.ok,
      status: dispatched.status,
      detail: dispatched.detail,
      scraped: rows.length,
      written,
    },
  };
}

async function weeklyMaintenance(ctx: AppContext): Promise<CronResult> {
  const refresh = await callPostingWorker(ctx, "/session/refresh", { requested_at: ctx.now });
  if (refresh.ok && refresh.body?.stale === true) {
    await sendAlert(ctx.env, `posting session is stale: ${String(refresh.body.detail ?? "rotate it")}`, {
      fetcher: ctx.fetcher,
      logger: ctx.logger,
    });
  }
  const compaction = await compactSnapshots(ctx.env.DB, { now: ctx.now, olderThanDays: 90 });
  const lastPost = await ctx.env.DB.prepare(
    `SELECT MAX(posted_at) AS last_posted FROM post_jobs WHERE status = 'posted'`,
  ).first<{ last_posted: number | null }>();
  const daysSincePost =
    lastPost?.last_posted != null ? Math.floor((ctx.now - lastPost.last_posted) / (DAY / 1000)) : null;

  return {
    summary: `weekly maintenance: session refresh ${
      refresh.ok ? "dispatched" : `skipped (${refresh.detail})`
    }, ${compaction.rollupsWritten} rollups written, ${compaction.rowsRemoved} old rows removed`,
    data: {
      sessionRefresh: refresh,
      compaction,
      daysSinceLastPost: daysSincePost,
      warning:
        daysSincePost !== null && daysSincePost > 14
          ? "posting session may be stale: no successful post in 14+ days"
          : null,
    },
  };
}

export async function callPostingWorker(
  ctx: AppContext,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string; status?: number; body?: Record<string, unknown> }> {
  if (!ctx.env.POSTING_WORKER_URL) {
    return { ok: false, detail: "POSTING_WORKER_URL is not configured" };
  }
  try {
    const response = await ctx.fetcher(
      `${ctx.env.POSTING_WORKER_URL.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-facade-call-token": ctx.env.POSTING_WORKER_TOKEN ?? "",
        },
        body: JSON.stringify(body),
      },
    );
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: response.ok,
      status: response.status,
      body: parsed,
      detail: response.ok ? "ok" : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}
