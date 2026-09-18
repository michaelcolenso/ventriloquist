import { HOUR, startOfUtcDay, utcDay } from "../lib/time";

export const MAX_POSTS_PER_DAY = 5;
export const MIN_SPACING_HOURS = 3;
export const MAX_CAPTION_LENGTH = 2200;
export const MAX_HASHTAGS = 10;

export type JobKind = "post" | "render_and_post";

export interface PostJobMessage {
  jobId: string;
  kind: JobKind;
  videoR2Key: string | null;
  caption: string;
  hashtags: string[];
  scheduledAt: number | null;
  renderSpec: Record<string, unknown> | null;
}

export interface PostJobRecord {
  job_id: string;
  status: string;
  kind: string;
  video_r2_key: string | null;
  caption: string | null;
  hashtags: string | null;
  scheduled_at: number | null;
  posted_at: number | null;
  tiktok_url: string | null;
  error: string | null;
  render_spec: string | null;
  created_at: number | null;
  updated_at: number | null;
  attempts: number;
}

export interface PostingPolicy {
  maxPostsPerDay: number;
  minSpacingHours: number;
  maxCaptionLength: number;
  maxHashtags: number;
}

export const DEFAULT_POSTING_POLICY: PostingPolicy = {
  maxPostsPerDay: MAX_POSTS_PER_DAY,
  minSpacingHours: MIN_SPACING_HOURS,
  maxCaptionLength: MAX_CAPTION_LENGTH,
  maxHashtags: MAX_HASHTAGS,
};

export interface PostRequest {
  caption: string;
  hashtags: string[];
  scheduledAt: number | null;
  now: number;
  videoR2Key: string | null;
  videoObjectExists: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface PostingContext {
  postsToday: number;
  lastScheduledAt: number | null;
}

/**
 * Pre-enqueue validation (spec section 7.1).
 *
 * The daily cap and minimum spacing are the structural part of the pacing
 * theater: they cannot be bypassed by a retry, because the queue simply never
 * receives the job.
 */
export function validatePostRequest(
  request: PostRequest,
  context: PostingContext,
  policy: PostingPolicy = DEFAULT_POSTING_POLICY,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const caption = request.caption ?? "";
  if (caption.trim() === "" && request.hashtags.length === 0) {
    errors.push("caption and hashtags are both empty; TikTok requires at least a caption");
  }
  if (caption.length > policy.maxCaptionLength) {
    errors.push(
      `caption is ${caption.length} characters; the limit is ${policy.maxCaptionLength}`,
    );
  }
  if (request.hashtags.length > policy.maxHashtags) {
    errors.push(
      `${request.hashtags.length} hashtags exceeds the ${policy.maxHashtags} configured for this account`,
    );
  }
  if (request.hashtags.some((tag) => /[\s#]/.test(tag))) {
    errors.push("hashtags must be bare words without spaces or leading #");
  }

  if (!request.videoObjectExists) {
    errors.push(
      request.videoR2Key
        ? `no R2 object at key "${request.videoR2Key}"`
        : "no video artifact provided (video_r2_key or render_spec is required)",
    );
  }

  if (context.postsToday >= policy.maxPostsPerDay) {
    errors.push(
      `daily cap reached: ${context.postsToday}/${policy.maxPostsPerDay} posts already queued or posted today (${utcDay(request.now)} UTC)`,
    );
  }

  const target = request.scheduledAt ?? request.now;
  if (
    context.lastScheduledAt !== null &&
    target - context.lastScheduledAt < policy.minSpacingHours * 3600
  ) {
    const hoursAway = ((policy.minSpacingHours * 3600 - (target - context.lastScheduledAt)) / 3600).toFixed(2);
    errors.push(
      `minimum spacing is ${policy.minSpacingHours}h between posts; ${hoursAway}h short of the previous job`,
    );
  }

  const hourUtc = new Date(target * 1000).getUTCHours();
  if (hourUtc < 11 || hourUtc > 23) {
    warnings.push(
      `scheduled hour ${hourUtc}:00 UTC is outside US business-ish hours; pacing theater prefers 11:00-23:00 UTC`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

export async function postingContext(db: D1Database, now: number): Promise<PostingContext> {
  const dayStart = startOfUtcDay(now);
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM post_jobs
        WHERE status IN ('queued', 'running', 'posted')
          AND COALESCE(posted_at, scheduled_at, created_at) >= ?`,
    )
    .bind(dayStart)
    .first<{ count: number }>();

  const last = await db
    .prepare(
      `SELECT MAX(COALESCE(posted_at, scheduled_at, created_at)) AS last_at
         FROM post_jobs
        WHERE status IN ('queued', 'running', 'posted')`,
    )
    .first<{ last_at: number | null }>();

  return {
    postsToday: counts?.count ?? 0,
    lastScheduledAt: last?.last_at ?? null,
  };
}

export interface CreatePostJobInput {
  jobId: string;
  kind: JobKind;
  videoR2Key: string | null;
  caption: string;
  hashtags: string[];
  scheduledAt: number | null;
  renderSpec: Record<string, unknown> | null;
  now: number;
}

export async function insertPostJob(db: D1Database, input: CreatePostJobInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO post_jobs
         (job_id, status, kind, video_r2_key, caption, hashtags, scheduled_at, render_spec,
          created_at, updated_at, attempts)
       VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(
      input.jobId,
      input.kind,
      input.videoR2Key,
      input.caption,
      JSON.stringify(input.hashtags),
      input.scheduledAt,
      input.renderSpec ? JSON.stringify(input.renderSpec) : null,
      input.now,
      input.now,
    )
    .run();
}

export async function getPostJob(db: D1Database, jobId: string): Promise<PostJobRecord | null> {
  return await db
    .prepare(`SELECT * FROM post_jobs WHERE job_id = ?`)
    .bind(jobId)
    .first<PostJobRecord>();
}

export async function listPostJobs(db: D1Database, limit: number): Promise<PostJobRecord[]> {
  const { results } = await db
    .prepare(`SELECT * FROM post_jobs ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all<PostJobRecord>();
  return results ?? [];
}

export async function updateJobStatus(
  db: D1Database,
  jobId: string,
  patch: {
    status?: string;
    videoR2Key?: string | null;
    tiktokUrl?: string | null;
    error?: string | null;
    postedAt?: number | null;
    incrementAttempts?: boolean;
  },
  now: number,
): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const values: (string | number | null)[] = [now];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.tiktokUrl !== undefined) {
    sets.push("tiktok_url = ?");
    values.push(patch.tiktokUrl);
  }
  if (patch.videoR2Key !== undefined) {
    sets.push("video_r2_key = ?");
    values.push(patch.videoR2Key);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    values.push(patch.error);
  }
  if (patch.postedAt !== undefined) {
    sets.push("posted_at = ?");
    values.push(patch.postedAt);
  }
  if (patch.incrementAttempts) {
    sets.push("attempts = attempts + 1");
  }
  await db
    .prepare(`UPDATE post_jobs SET ${sets.join(", ")} WHERE job_id = ?`)
    .bind(...values, jobId)
    .run();
}

/** Failure doctrine (spec 7.4): two consecutive post failures halt posting. */
export async function consecutivePostFailures(db: D1Database, now: number): Promise<number> {
  const windowStart = now - 24 * HOUR;
  const { results } = await db
    .prepare(
      `SELECT status FROM post_jobs
        WHERE COALESCE(posted_at, created_at) >= ?
        ORDER BY COALESCE(posted_at, created_at) DESC
        LIMIT 10`,
    )
    .bind(windowStart)
    .all<{ status: string }>();
  let consecutive = 0;
  for (const row of results ?? []) {
    if (row.status === "failed") consecutive += 1;
    else break;
  }
  return consecutive;
}
