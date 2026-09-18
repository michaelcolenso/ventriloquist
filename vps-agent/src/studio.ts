/**
 * AMBER deep analytics (spec 4.4 / capability 5).
 *
 * The Studio UI changes more often than anything else in this repo, so this
 * module intentionally stops at "drive the page, parse whatever analytics JSON
 * came back" rather than reading numbers off the DOM. When TikTok renames a
 * route the hook still captures it and only the parser needs updating.
 */

import { chromium, type Response } from "playwright-core";
import { loadPostingCookies, type SessionCustodyOptions } from "./sessions";

export interface StudioAnalyticsRow {
  video_id: string;
  watch_time_seconds: number | null;
  average_watch_time_seconds: number | null;
  full_watch_rate: number | null;
  traffic_sources: unknown;
  retention: unknown;
  captured_at: number;
}

export const STUDIO_ANALYTICS_URL =
  "https://www.tiktok.com/tiktokstudio/analytics?from=web&lang=en";

/** Studio route names drift; match the family rather than one exact path. */
const ANALYTICS_RESPONSE_PATTERN = /(analytics|dashboard|overview|item_list|video_(list|stats))/i;

export interface StudioScrapeOptions extends SessionCustodyOptions {
  executablePath: string;
  userDataDir: string;
  headless: boolean;
  timeoutMs: number;
  /** Safety valve so a chatty page cannot buffer unbounded responses. */
  maxCaptures?: number;
}

/**
 * Drive the logged-in Studio analytics page with a burner session and capture
 * whatever JSON the page fetches. Parsing stays in
 * `parseStudioAnalyticsPayload`, so a TikTok route rename costs a selector or
 * URL-pattern tweak here, not a rewrite of the data mapping.
 */
export async function scrapeStudioAnalytics(
  options: StudioScrapeOptions,
): Promise<StudioAnalyticsRow[]> {
  const cookies = await loadPostingCookies(options);
  const maxCaptures = options.maxCaptures ?? 40;
  const captured: unknown[] = [];

  const context = await chromium.launchPersistentContext(options.userDataDir, {
    executablePath: options.executablePath,
    headless: options.headless,
    viewport: { width: 1366, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const capture = async (response: Response): Promise<void> => {
    if (captured.length >= maxCaptures) return;
    if (!ANALYTICS_RESPONSE_PATTERN.test(response.url())) return;
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("json")) return;
    try {
      captured.push(await response.json());
    } catch {
      /* redirects and aborted requests are expected; ignore them */
    }
  };
  context.on("response", (response) => void capture(response));

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(STUDIO_ANALYTICS_URL, { timeout: options.timeoutMs });
    await page.waitForTimeout(3_000);
    for (let scroll = 0; scroll < 3; scroll += 1) {
      await page.mouse.wheel(0, 1_200);
      await page.waitForTimeout(1_500);
    }
    await page.waitForTimeout(2_000);
  } finally {
    await context.close();
  }

  const capturedAt = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const rows: StudioAnalyticsRow[] = [];
  for (const payload of captured) {
    for (const row of parseStudioAnalyticsPayload(payload, capturedAt)) {
      const key = `${row.video_id}:${row.captured_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
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
