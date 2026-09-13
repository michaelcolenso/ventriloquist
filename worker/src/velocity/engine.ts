import type { VideoSnapshotRow } from "../storage/snapshots";
import {
  hashtagSeriesWithPosts,
  latestVideoSnapshots,
  soundSeries,
  videoSeries,
} from "../storage/snapshots";
import { DAY } from "../lib/time";
import {
  computeVelocity,
  isBreakout,
  median,
  type LifecycleStage,
  type SeriesPoint,
  type VelocityMetrics,
} from "./math";

/**
 * Niche saturation thresholds (spec 5.3: "calibrated per niche; baby-name
 * hashtags saturate ~10-50M views, not billions"). These are starting
 * calibrations and are meant to be tuned from accumulated data.
 */
export const NICHE_SATURATION_VIEWS: Record<string, number> = {
  "baby-names": 25_000_000,
  "parenting-humor": 250_000_000,
  etymology: 15_000_000,
  "data-storytelling": 75_000_000,
  default: 100_000_000,
};

export function saturationFor(niche: string | null | undefined, override?: number): number {
  if (typeof override === "number" && override > 0) return override;
  if (niche && NICHE_SATURATION_VIEWS[niche] !== undefined) return NICHE_SATURATION_VIEWS[niche]!;
  return NICHE_SATURATION_VIEWS.default!;
}

export interface MomentumResult {
  entity: string;
  entityType: "hashtag" | "sound";
  niche: string | null;
  windowDays: number;
  nicheRelevance: number;
  metrics: VelocityMetrics;
  series: { capturedAt: number; value: number | null; source: string }[];
}

export async function hashtagMomentum(
  db: D1Database,
  hashtag: string,
  options: {
    windowDays?: number;
    now: number;
    niche?: string | null;
    nicheRelevance?: number;
    saturationThreshold?: number;
  },
): Promise<MomentumResult> {
  const windowDays = options.windowDays ?? 14;
  const since = options.now - windowDays * (DAY / 1000);
  const rows = await hashtagSeriesWithPosts(db, hashtag, Math.floor(since));

  const views: SeriesPoint[] = rows
    .filter((row) => row.viewCount !== null)
    .map((row) => ({ t: row.capturedAt, v: row.viewCount as number }));
  const posts: SeriesPoint[] = rows
    .filter((row) => row.postCount !== null)
    .map((row) => ({ t: row.capturedAt, v: row.postCount as number }));

  // Prefer views; fall back to post count when view count is not exposed.
  const series = views.length >= posts.length ? views : posts;

  const metrics = computeVelocity(series, {
    saturationThreshold: saturationFor(options.niche, options.saturationThreshold),
    nicheRelevance: options.nicheRelevance ?? 1,
    now: options.now,
  });

  const usedViews = views.length >= posts.length;
  return {
    entity: hashtag.replace(/^#/, ""),
    entityType: "hashtag",
    niche: options.niche ?? null,
    windowDays,
    nicheRelevance: options.nicheRelevance ?? 1,
    metrics: {
      ...metrics,
      saturationEstimate: metrics.saturationEstimate
        ? `${metrics.saturationEstimate} (${usedViews ? "views" : "posts"} basis)`
        : metrics.saturationEstimate,
    },
    series: rows.map((row) => ({
      capturedAt: row.capturedAt,
      value: usedViews ? row.viewCount : row.postCount,
      source: row.source,
    })),
  };
}

export interface SoundLifecycleResult {
  soundId: string;
  windowDays: number;
  birthAt: number | null;
  metrics: VelocityMetrics;
  curve: { capturedAt: number; value: number | null; source: string }[];
  stage: LifecycleStage;
}

export async function soundLifecycle(
  db: D1Database,
  soundId: string,
  options: { now: number; windowDays?: number; saturationThreshold?: number },
): Promise<SoundLifecycleResult> {
  const windowDays = options.windowDays ?? 30;
  const since = Math.floor(options.now - windowDays * (DAY / 1000));
  const rows = await soundSeries(db, soundId, since);
  const points: SeriesPoint[] = rows
    .filter((row) => row.value !== null)
    .map((row) => ({ t: row.capturedAt, v: row.value as number }));

  const birthRow = await db
    .prepare(`SELECT MIN(captured_at) AS birth FROM sound_snapshots WHERE sound_id = ?`)
    .bind(soundId)
    .first<{ birth: number | null }>();

  const metrics = computeVelocity(points, {
    saturationThreshold: saturationFor(null, options.saturationThreshold),
    now: options.now,
  });

  return {
    soundId,
    windowDays,
    birthAt: birthRow?.birth ?? points[0]?.t ?? null,
    metrics,
    curve: rows,
    stage: metrics.lifecycle,
  };
}

export interface EmergingCandidate {
  entityType: "hashtag" | "sound";
  entityId: string;
  niche: string | null;
  relevance: number;
  lifecycle: LifecycleStage;
  actionability: number | null;
  metrics: VelocityMetrics;
  reason: string;
}

/**
 * The product question this answers (spec 5.3): "what should nobodynamed make
 * a video about this week that hasn't been done to death yet?"
 */
export async function emergingInNiche(
  db: D1Database,
  options: {
    now: number;
    keywords?: string[];
    niches?: string[];
    limit?: number;
    windowDays?: number;
    minSamples?: number;
  },
): Promise<{ candidates: EmergingCandidate[]; evaluated: number; skippedForHistory: number }> {
  const limit = options.limit ?? 10;
  const windowDays = options.windowDays ?? 14;
  const minSamples = options.minSamples ?? 4;
  const keywords = (options.keywords ?? []).map((keyword) => keyword.toLowerCase());
  const niches = new Set((options.niches ?? []).map((niche) => niche.toLowerCase()));

  // Keyword matching is token-based so "baby names" matches the hashtag
  // `babynames` and the niche slug `baby-names`.
  const keywordTokens = [
    ...new Set(
      keywords
        .flatMap((keyword) => keyword.split(/[^a-z0-9]+/))
        .filter((token) => token.length >= 4),
    ),
  ];
  const matchesKeyword = (entityId: string, niche: string | null): boolean | null => {
    if (keywordTokens.length === 0) return null;
    const haystack = `${entityId} ${niche ?? ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
    return keywordTokens.some((token) => haystack.includes(token));
  };

  const { results: watchlistRows } = await db
    .prepare(`SELECT entity_type, entity_id, niche FROM watchlist WHERE active = 1`)
    .all<{ entity_type: string; entity_id: string; niche: string | null }>();

  type CandidateSeed = { entityType: "hashtag" | "sound"; entityId: string; niche: string | null; relevance: number };
  const seeds = new Map<string, CandidateSeed>();

  for (const row of watchlistRows ?? []) {
    const entityType = row.entity_type === "sound" ? "sound" : "hashtag";
    const nicheMatch = row.niche !== null && niches.size > 0 ? niches.has(row.niche.toLowerCase()) : null;
    const keywordMatch = matchesKeyword(row.entity_id, row.niche);
    const relevant = nicheMatch === true || keywordMatch === true;
    if (niches.size > 0 || keywords.length > 0) {
      if (!relevant) continue;
    }
    const relevance = nicheMatch === true ? 1 : keywordMatch === true ? 0.8 : 0.6;
    seeds.set(`${entityType}:${row.entity_id}`, {
      entityType,
      entityId: row.entity_id,
      niche: row.niche,
      relevance,
    });
  }

  // Hashtags discovered by the trending cron but never explicitly watchlisted
  // still count if they match the requested keywords.
  if (keywords.length > 0) {
    const since = Math.floor(options.now - windowDays * (DAY / 1000));
    const { results: seen } = await db
      .prepare(
        `SELECT DISTINCT hashtag FROM hashtag_snapshots WHERE captured_at >= ? LIMIT 1000`,
      )
      .bind(since)
      .all<{ hashtag: string }>();
    for (const row of seen ?? []) {
      const matches = keywords.some((keyword) => row.hashtag.includes(keyword));
      if (!matches) continue;
      const key = `hashtag:${row.hashtag}`;
      if (!seeds.has(key)) {
        seeds.set(key, {
          entityType: "hashtag",
          entityId: row.hashtag,
          niche: null,
          relevance: 0.7,
        });
      }
    }
  }

  const candidates: EmergingCandidate[] = [];
  let skippedForHistory = 0;

  for (const seed of seeds.values()) {
    const result =
      seed.entityType === "hashtag"
        ? await hashtagMomentum(db, seed.entityId, {
            now: options.now,
            windowDays,
            niche: seed.niche,
            nicheRelevance: seed.relevance,
          })
        : await soundMomentum(db, seed.entityId, {
            now: options.now,
            windowDays,
            niche: seed.niche,
            nicheRelevance: seed.relevance,
          });

    if (result.metrics.samples < minSamples) {
      skippedForHistory += 1;
      continue;
    }

    candidates.push({
      entityType: seed.entityType,
      entityId: seed.entityId,
      niche: seed.niche,
      relevance: seed.relevance,
      lifecycle: result.metrics.lifecycle,
      actionability: result.metrics.actionability,
      metrics: result.metrics,
      reason: describeCandidate(result.metrics, seed.entityType, seed.entityId),
    });
  }

  candidates.sort(
    (a, b) =>
      (b.actionability ?? Number.NEGATIVE_INFINITY) -
        (a.actionability ?? Number.NEGATIVE_INFINITY) ||
      (b.metrics.acceleration ?? 0) - (a.metrics.acceleration ?? 0),
  );

  return { candidates: candidates.slice(0, limit), evaluated: seeds.size, skippedForHistory };
}

function describeCandidate(
  metrics: VelocityMetrics,
  entityType: "hashtag" | "sound",
  entityId: string,
): string {
  const label = entityType === "hashtag" ? `#${entityId}` : `sound ${entityId}`;
  const accel = metrics.acceleration;
  const saturation = metrics.saturation;
  const parts: string[] = [`${label} is ${metrics.lifecycle.toLowerCase()}`];
  if (accel !== null) {
    parts.push(`${accel >= 0 ? "+" : ""}${accel.toLocaleString()} views/day acceleration`);
  }
  if (saturation !== null) {
    parts.push(`${(saturation * 100).toFixed(1)}% of niche saturation`);
  }
  return parts.join("; ");
}

async function soundMomentum(
  db: D1Database,
  soundId: string,
  options: { now: number; windowDays: number; niche: string | null; nicheRelevance: number },
): Promise<MomentumResult> {
  const result = await soundLifecycle(db, soundId, {
    now: options.now,
    windowDays: options.windowDays,
  });
  return {
    entity: soundId,
    entityType: "sound",
    niche: options.niche,
    windowDays: options.windowDays,
    nicheRelevance: options.nicheRelevance,
    metrics: result.metrics,
    series: result.curve,
  };
}

export interface AccountVelocity {
  username: string;
  videosTracked: number;
  latestAt: number | null;
  medianPlays: number | null;
  medianLikes: number | null;
  velocity24h: number | null;
  velocity7d: number | null;
  acceleration: number | null;
  lifecycle: LifecycleStage;
  recent: {
    videoId: string;
    playCount: number | null;
    likeCount: number | null;
    capturedAt: number;
    hashtags: string[];
  }[];
}

export async function accountVelocity(
  db: D1Database,
  username: string,
  options: { now: number; windowDays?: number; limit?: number },
): Promise<AccountVelocity> {
  const handle = username.replace(/^@/, "");
  const windowDays = options.windowDays ?? 30;
  const since = Math.floor(options.now - windowDays * (DAY / 1000));

  const { results } = await db
    .prepare(
      `SELECT video_id, captured_at, play_count, like_count, hashtags
         FROM video_snapshots
        WHERE author = ? AND captured_at >= ?
        ORDER BY captured_at ASC`,
    )
    .bind(handle, since)
    .all<{
      video_id: string;
      captured_at: number;
      play_count: number | null;
      like_count: number | null;
      hashtags: string | null;
    }>();

  const byVideo = new Map<string, VideoSnapshotRow[]>();
  for (const row of results ?? []) {
    const bucket = byVideo.get(row.video_id) ?? [];
    bucket.push({
      videoId: row.video_id,
      capturedAt: row.captured_at,
      author: handle,
      playCount: row.play_count,
      likeCount: row.like_count,
      commentCount: null,
      shareCount: null,
      soundId: null,
      hashtags: row.hashtags ? (JSON.parse(row.hashtags) as string[]) : [],
      source: "signer",
    });
    byVideo.set(row.video_id, bucket);
  }

  const latestPerVideo = [...byVideo.values()]
    .map((rows) => rows.at(-1)!)
    .sort((a, b) => b.capturedAt - a.capturedAt);

  const totals: SeriesPoint[] = [];
  let runningTotal = 0;
  for (const point of latestPerVideo) {
    runningTotal += point.playCount ?? 0;
  }

  // Aggregate plays across the account at each capture instant, so velocity is
  // "the account's catalogue is accumulating N plays/day".
  const byInstant = new Map<number, number>();
  for (const rows of byVideo.values()) {
    for (const row of rows) {
      byInstant.set(row.capturedAt, (byInstant.get(row.capturedAt) ?? 0) + (row.playCount ?? 0));
    }
  }
  for (const [t, v] of byInstant) totals.push({ t, v });
  totals.sort((a, b) => a.t - b.t);

  const metrics = computeVelocity(totals, {
    saturationThreshold: saturationFor(null),
    now: options.now,
  });

  const limit = options.limit ?? 10;
  return {
    username: handle,
    videosTracked: latestPerVideo.length,
    latestAt: latestPerVideo[0]?.capturedAt ?? null,
    medianPlays: median(latestPerVideo.map((row) => row.playCount ?? 0)) ?? null,
    medianLikes: median(latestPerVideo.map((row) => row.likeCount ?? 0)) ?? null,
    velocity24h: metrics.velocity24h,
    velocity7d: metrics.velocity7d,
    acceleration: metrics.acceleration,
    lifecycle: metrics.lifecycle,
    recent: latestPerVideo.slice(0, limit).map((row) => ({
      videoId: row.videoId,
      playCount: row.playCount,
      likeCount: row.likeCount,
      capturedAt: row.capturedAt,
      hashtags: row.hashtags,
    })),
  };
}

export interface Breakout {
  username: string;
  videoId: string;
  playCount: number | null;
  baselineMedianPlays: number | null;
  ratio: number | null;
  zScore: number | null;
  capturedAt: number;
}

/** Shadow-cohort breakout detection (spec 5.4). */
export async function detectBreakouts(
  db: D1Database,
  options: { now: number; sinceHours?: number; sigmas?: number; limit?: number },
): Promise<Breakout[]> {
  const sinceHours = options.sinceHours ?? 48;
  const sigmas = options.sigmas ?? 3;
  const since = Math.floor(options.now - sinceHours * 3600);

  const { results: cohort } = await db
    .prepare(`SELECT username FROM shadow_cohort ORDER BY username`)
    .all<{ username: string }>();

  const breakouts: Breakout[] = [];
  for (const row of cohort ?? []) {
    const snapshots = await latestVideoSnapshots(db, row.username, 60);
    const byVideo = new Map<string, VideoSnapshotRow>();
    for (const snapshot of snapshots) {
      const existing = byVideo.get(snapshot.videoId);
      if (!existing || existing.capturedAt < snapshot.capturedAt) {
        byVideo.set(snapshot.videoId, snapshot);
      }
    }
    const videos = [...byVideo.values()];
    const baseline = videos.map((video) => video.playCount ?? 0);
    for (const video of videos) {
      if (video.capturedAt < since) continue;
      const result = isBreakout(video.playCount ?? 0, baseline, sigmas);
      if (!result.breakout) continue;
      breakouts.push({
        username: row.username,
        videoId: video.videoId,
        playCount: video.playCount,
        baselineMedianPlays: median(baseline),
        ratio: result.ratio,
        zScore: result.zScore,
        capturedAt: video.capturedAt,
      });
    }
  }

  return breakouts
    .sort((a, b) => (b.zScore ?? 0) - (a.zScore ?? 0))
    .slice(0, options.limit ?? 25);
}

export interface WhatWorkedGroup {
  key: string;
  videos: number;
  medianPlays: number | null;
  medianLikes: number | null;
  liftVsAccountMedian: number | null;
}

export interface WhatWorkedResult {
  handle: string;
  windowDays: number;
  videosAnalyzed: number;
  accountMedianPlays: number | null;
  byHashtag: WhatWorkedGroup[];
  bySound: WhatWorkedGroup[];
  topVideos: {
    videoId: string;
    playCount: number | null;
    likeCount: number | null;
    hashtags: string[];
    soundId: string | null;
    capturedAt: number;
  }[];
}

/** "What worked" reads only D1 (spec 4.4): the accumulation layer paying off. */
export async function whatWorked(
  db: D1Database,
  handle: string,
  options: { now: number; windowDays?: number; limit?: number },
): Promise<WhatWorkedResult> {
  const username = handle.replace(/^@/, "");
  const windowDays = options.windowDays ?? 30;
  const since = Math.floor(options.now - windowDays * (DAY / 1000));
  const rows = await latestVideoSnapshots(db, username, 500);
  const inWindow = rows.filter((row) => row.capturedAt >= since);
  const videos = [...inWindow.reduce((map, row) => {
    const existing = map.get(row.videoId);
    if (!existing || existing.capturedAt < row.capturedAt) map.set(row.videoId, row);
    return map;
  }, new Map<string, VideoSnapshotRow>()).values()];

  const accountMedian = median(videos.map((video) => video.playCount ?? 0));

  return {
    handle: username,
    windowDays,
    videosAnalyzed: videos.length,
    accountMedianPlays: accountMedian,
    byHashtag: groupBy(videos, (video) => video.hashtags, accountMedian),
    bySound: groupBy(
      videos,
      (video) => (video.soundId ? [video.soundId] : []),
      accountMedian,
    ),
    topVideos: [...videos]
      .sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0))
      .slice(0, options.limit ?? 10)
      .map((video) => ({
        videoId: video.videoId,
        playCount: video.playCount,
        likeCount: video.likeCount,
        hashtags: video.hashtags,
        soundId: video.soundId,
        capturedAt: video.capturedAt,
      })),
  };
}

function groupBy(
  videos: VideoSnapshotRow[],
  keysOf: (video: VideoSnapshotRow) => string[],
  accountMedian: number | null,
): WhatWorkedGroup[] {
  const groups = new Map<string, VideoSnapshotRow[]>();
  for (const video of videos) {
    for (const key of new Set(keysOf(video))) {
      const bucket = groups.get(key) ?? [];
      bucket.push(video);
      groups.set(key, bucket);
    }
  }
  return [...groups.entries()]
    .map(([key, bucket]) => {
      const plays = median(bucket.map((video) => video.playCount ?? 0));
      return {
        key,
        videos: bucket.length,
        medianPlays: plays,
        medianLikes: median(bucket.map((video) => video.likeCount ?? 0)),
        liftVsAccountMedian:
          plays === null || accountMedian === null || accountMedian === 0
            ? null
            : Math.round((plays / accountMedian) * 100) / 100,
      };
    })
    .sort((a, b) => (b.medianPlays ?? 0) - (a.medianPlays ?? 0));
}

/** Snapshot compaction (risk register): hourly rows older than N days -> daily rollups. */
export async function compactSnapshots(
  db: D1Database,
  options: { now: number; olderThanDays?: number },
): Promise<{ rollupsWritten: number; rowsRemoved: number }> {
  const olderThanDays = options.olderThanDays ?? 90;
  const cutoff = Math.floor(options.now - olderThanDays * (DAY / 1000));

  const { results } = await db
    .prepare(
      `SELECT hashtag AS entity_id,
              CAST(captured_at / 86400 AS INTEGER) AS day,
              MIN(view_count) AS min_value,
              MAX(view_count) AS max_value,
              AVG(view_count) AS avg_value,
              COUNT(*) AS samples
         FROM hashtag_snapshots
        WHERE captured_at < ? AND view_count IS NOT NULL
        GROUP BY hashtag, day`,
    )
    .bind(cutoff)
    .all<{
      entity_id: string;
      day: number;
      min_value: number;
      max_value: number;
      avg_value: number;
      samples: number;
    }>();

  const statements = (results ?? []).map((row) =>
    db
      .prepare(
        `INSERT INTO daily_rollups
           (entity_type, entity_id, day, metric, min_value, max_value, avg_value, last_value, samples)
         VALUES ('hashtag', ?, ?, 'view_count', ?, ?, ?, ?, ?)
         ON CONFLICT (entity_type, entity_id, day, metric) DO UPDATE SET
           min_value = excluded.min_value,
           max_value = excluded.max_value,
           avg_value = excluded.avg_value,
           last_value = excluded.last_value,
           samples = excluded.samples`,
      )
      .bind(
        row.entity_id,
        row.day,
        row.min_value,
        row.max_value,
        row.avg_value,
        row.max_value,
        row.samples,
      ),
  );

  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }

  const deleted = await db
    .prepare(`DELETE FROM hashtag_snapshots WHERE captured_at < ?`)
    .bind(cutoff)
    .run();

  return {
    rollupsWritten: statements.length,
    rowsRemoved: deleted.meta?.changes ?? 0,
  };
}

export { videoSeries };
