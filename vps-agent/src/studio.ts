/**
 * AMBER deep analytics (spec 4.4 / capability 5).
 *
 * The Studio UI changes more often than anything else in this repo, so this
 * module intentionally stops at "drive the page, parse whatever analytics JSON
 * came back" rather than reading numbers off the DOM. When TikTok renames a
 * route the hook still captures it and only the parser needs updating.
 */

export interface StudioAnalyticsRow {
  video_id: string;
  watch_time_seconds: number | null;
  average_watch_time_seconds: number | null;
  full_watch_rate: number | null;
  traffic_sources: unknown;
  retention: unknown;
  captured_at: number;
}

export function parseStudioAnalyticsPayload(
  payload: unknown,
  capturedAt: number,
): StudioAnalyticsRow[] {
  const root = payload as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return [];
  const list = (root.data ?? root.list ?? root.items ?? root) as unknown;
  const rows = Array.isArray(list) ? list : [];

  return rows
    .map((entry): StudioAnalyticsRow | null => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const videoId = row.item_id ?? row.video_id ?? row.aweme_id ?? row.id;
      if (typeof videoId !== "string" && typeof videoId !== "number") return null;
      const stats = (row.stats ?? row.metrics ?? row) as Record<string, unknown>;
      return {
        video_id: String(videoId),
        watch_time_seconds: numberOrNull(stats.total_watch_time ?? stats.watch_time),
        average_watch_time_seconds: numberOrNull(stats.average_watch_time ?? stats.avg_watch_time),
        full_watch_rate: numberOrNull(stats.full_watch_rate ?? stats.completion_rate),
        traffic_sources: stats.traffic_sources ?? stats.traffic_source ?? null,
        retention: stats.retention ?? stats.retention_curve ?? null,
        captured_at: capturedAt,
      };
    })
    .filter((row): row is StudioAnalyticsRow => row !== null);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
