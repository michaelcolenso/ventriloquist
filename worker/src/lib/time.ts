export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** UTC day key, e.g. "2026-09-13". Used for budget buckets and rollups. */
export function utcDay(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** UTC day index (days since epoch) for rollup rows. */
export function utcDayIndex(epochSeconds: number): number {
  return Math.floor(epochSeconds / 86_400);
}

export function startOfUtcDay(epochSeconds: number): number {
  return utcDayIndex(epochSeconds) * 86_400;
}
