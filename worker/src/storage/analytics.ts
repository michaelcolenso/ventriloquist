/**
 * AMBER Studio analytics writes (spec 4.4).
 *
 * The VPS Playwright worker scrapes Studio and posts rows back through the
 * facade; this module owns validation and the idempotent D1 write so a rerun
 * of the same capture cannot duplicate rows.
 */
export interface StudioAnalyticsRow {
  video_id: string;
  captured_at: number;
  watch_time_seconds: number | null;
  average_watch_time_seconds: number | null;
  full_watch_rate: number | null;
  traffic_sources: unknown;
  retention: unknown;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isStudioAnalyticsRow(value: unknown): value is StudioAnalyticsRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    (typeof row.video_id === "string" || typeof row.video_id === "number") &&
    typeof row.captured_at === "number" &&
    Number.isFinite(row.captured_at)
  );
}

export function buildStudioAnalyticsStatements(
  db: D1Database,
  rows: unknown[],
): D1PreparedStatement[] {
  return rows.filter(isStudioAnalyticsRow).map((row) =>
    db
      .prepare(
        `INSERT INTO own_video_analytics
           (video_id, captured_at, watch_time_seconds, average_watch_time_seconds,
            full_watch_rate, traffic_sources, retention, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'studio')
         ON CONFLICT (video_id, captured_at) DO UPDATE SET
           watch_time_seconds = excluded.watch_time_seconds,
           average_watch_time_seconds = excluded.average_watch_time_seconds,
           full_watch_rate = excluded.full_watch_rate,
           traffic_sources = excluded.traffic_sources,
           retention = excluded.retention`,
      )
      .bind(
        String(row.video_id),
        Math.floor(row.captured_at),
        numberOrNull(row.watch_time_seconds),
        numberOrNull(row.average_watch_time_seconds),
        numberOrNull(row.full_watch_rate),
        row.traffic_sources == null ? null : JSON.stringify(row.traffic_sources),
        row.retention == null ? null : JSON.stringify(row.retention),
      ),
  );
}

export async function writeStudioAnalytics(db: D1Database, rows: unknown[]): Promise<number> {
  const statements = buildStudioAnalyticsStatements(db, rows);
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
  return statements.length;
}
