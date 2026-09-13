import type { HashtagStats, SoundStats, Video } from "../domain/models";
import type { SourceName } from "../types";

/**
 * The accumulation layer (spec P3).
 *
 * Every read that passes through the facade lands here, fire-and-forget, via
 * `ctx.waitUntil`. Snapshotting never blocks or fails a response.
 */

function json(value: unknown): string {
  return JSON.stringify(value ?? []);
}

export interface SnapshotWrite {
  table: string;
  statement: D1PreparedStatement;
}

export function buildHashtagSnapshotStatements(
  db: D1Database,
  hashtags: HashtagStats[],
  capturedAt: number,
): D1PreparedStatement[] {
  const statement = db.prepare(
    `INSERT INTO hashtag_snapshots (hashtag, captured_at, view_count, post_count, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (hashtag, captured_at) DO UPDATE SET
       view_count = excluded.view_count,
       post_count = excluded.post_count,
       source = excluded.source`,
  );
  return hashtags
    .filter((hashtag) => hashtag.name)
    .map((hashtag) =>
      statement.bind(
        hashtag.name.toLowerCase(),
        capturedAt,
        hashtag.viewCount,
        hashtag.videoCount,
        hashtag.source,
      ),
    );
}

export function buildVideoSnapshotStatements(
  db: D1Database,
  videos: Video[],
  capturedAt: number,
  source: SourceName,
): D1PreparedStatement[] {
  const statement = db.prepare(
    `INSERT INTO video_snapshots
       (video_id, captured_at, author, play_count, like_count, comment_count, share_count,
        sound_id, hashtags, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (video_id, captured_at) DO UPDATE SET
       play_count = excluded.play_count,
       like_count = excluded.like_count,
       comment_count = excluded.comment_count,
       share_count = excluded.share_count,
       hashtags = excluded.hashtags,
       source = excluded.source`,
  );
  return videos
    .filter((video) => video.id)
    .map((video) =>
      statement.bind(
        video.id,
        capturedAt,
        video.author?.uniqueId ?? null,
        video.stats.playCount,
        video.stats.likeCount,
        video.stats.commentCount,
        video.stats.shareCount,
        video.music?.id ?? null,
        json(video.hashtags),
        source,
      ),
    );
}

export function buildSoundSnapshotStatements(
  db: D1Database,
  sounds: SoundStats[],
  capturedAt: number,
): D1PreparedStatement[] {
  const statement = db.prepare(
    `INSERT INTO sound_snapshots (sound_id, captured_at, video_count, user_count, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (sound_id, captured_at) DO UPDATE SET
       video_count = excluded.video_count,
       user_count = excluded.user_count,
       source = excluded.source`,
  );
  return sounds
    .filter((sound) => sound.id)
    .map((sound) =>
      statement.bind(sound.id, capturedAt, sound.videoCount, sound.userCount, sound.source),
    );
}

export async function writeSnapshots(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  if (statements.length === 0) return;
  // D1 caps batches; chunk so large trending pulls never reject wholesale.
  const CHUNK = 50;
  for (let index = 0; index < statements.length; index += CHUNK) {
    await db.batch(statements.slice(index, index + CHUNK));
  }
}

export interface TimeSeriesPoint {
  capturedAt: number;
  value: number | null;
  source: string;
}

export async function hashtagSeries(
  db: D1Database,
  hashtag: string,
  sinceEpoch: number,
): Promise<TimeSeriesPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT captured_at, view_count, post_count, source
         FROM hashtag_snapshots
        WHERE hashtag = ? AND captured_at >= ?
        ORDER BY captured_at ASC`,
    )
    .bind(hashtag.replace(/^#/, "").toLowerCase(), sinceEpoch)
    .all<{ captured_at: number; view_count: number | null; post_count: number | null; source: string }>();
  return (results ?? []).map((row) => ({
    capturedAt: row.captured_at,
    value: row.view_count ?? row.post_count ?? null,
    source: row.source,
  }));
}

export async function hashtagSeriesWithPosts(
  db: D1Database,
  hashtag: string,
  sinceEpoch: number,
): Promise<{ capturedAt: number; viewCount: number | null; postCount: number | null; source: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT captured_at, view_count, post_count, source
         FROM hashtag_snapshots
        WHERE hashtag = ? AND captured_at >= ?
        ORDER BY captured_at ASC`,
    )
    .bind(hashtag.replace(/^#/, "").toLowerCase(), sinceEpoch)
    .all<{ captured_at: number; view_count: number | null; post_count: number | null; source: string }>();
  return (results ?? []).map((row) => ({
    capturedAt: row.captured_at,
    viewCount: row.view_count,
    postCount: row.post_count,
    source: row.source,
  }));
}

export async function soundSeries(
  db: D1Database,
  soundId: string,
  sinceEpoch: number,
): Promise<TimeSeriesPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT captured_at, video_count, source
         FROM sound_snapshots
        WHERE sound_id = ? AND captured_at >= ?
        ORDER BY captured_at ASC`,
    )
    .bind(soundId, sinceEpoch)
    .all<{ captured_at: number; video_count: number | null; source: string }>();
  return (results ?? []).map((row) => ({
    capturedAt: row.captured_at,
    value: row.video_count,
    source: row.source,
  }));
}

export interface VideoSnapshotRow {
  videoId: string;
  capturedAt: number;
  author: string | null;
  playCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  soundId: string | null;
  hashtags: string[];
  source: string;
}

export async function videoSeries(
  db: D1Database,
  videoIds: string[],
  sinceEpoch: number,
): Promise<VideoSnapshotRow[]> {
  if (videoIds.length === 0) return [];
  const placeholders = videoIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT video_id, captured_at, author, play_count, like_count, comment_count,
              share_count, sound_id, hashtags, source
         FROM video_snapshots
        WHERE video_id IN (${placeholders}) AND captured_at >= ?
        ORDER BY captured_at ASC`,
    )
    .bind(...videoIds, sinceEpoch)
    .all<{
      video_id: string;
      captured_at: number;
      author: string | null;
      play_count: number | null;
      like_count: number | null;
      comment_count: number | null;
      share_count: number | null;
      sound_id: string | null;
      hashtags: string | null;
      source: string;
    }>();
  return (results ?? []).map((row) => ({
    videoId: row.video_id,
    capturedAt: row.captured_at,
    author: row.author,
    playCount: row.play_count,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    shareCount: row.share_count,
    soundId: row.sound_id,
    hashtags: parseJsonArray(row.hashtags),
    source: row.source,
  }));
}

export async function latestVideoSnapshots(
  db: D1Database,
  author: string,
  limit: number,
): Promise<VideoSnapshotRow[]> {
  const { results } = await db
    .prepare(
      `SELECT video_id, captured_at, author, play_count, like_count, comment_count,
              share_count, sound_id, hashtags, source
         FROM video_snapshots
        WHERE author = ?
        ORDER BY captured_at DESC
        LIMIT ?`,
    )
    .bind(author, limit)
    .all<{
      video_id: string;
      captured_at: number;
      author: string | null;
      play_count: number | null;
      like_count: number | null;
      comment_count: number | null;
      share_count: number | null;
      sound_id: string | null;
      hashtags: string | null;
      source: string;
    }>();
  return (results ?? []).map((row) => ({
    videoId: row.video_id,
    capturedAt: row.captured_at,
    author: row.author,
    playCount: row.play_count,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    shareCount: row.share_count,
    soundId: row.sound_id,
    hashtags: parseJsonArray(row.hashtags),
    source: row.source,
  }));
}

export async function countRows(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? 0;
}

export function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
