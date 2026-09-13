/**
 * Pacing theater (spec 7.3).
 *
 * Not an attempt to defeat fraud detection - an attempt to stay boringly
 * inside normal-creator behaviour: randomized inter-action delays, plausible
 * upload hours, the occasional no-op day.
 */

export interface PacingOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Upload window in the account's local time (24h clock). */
  windowStartHour?: number;
  windowEndHour?: number;
  /** Probability that a scheduled slot is skipped entirely. */
  noOpDayProbability?: number;
}

export const DEFAULT_PACING: Required<PacingOptions> = {
  minDelayMs: 3_000,
  maxDelayMs: 11_000,
  windowStartHour: 7,
  windowEndHour: 22,
  noOpDayProbability: 0.08,
};

export interface RandomSource {
  (): number;
}

/** Randomized inter-action delay: "3-11s between actions" (spec 2.1). */
export function actionDelayMs(
  options: PacingOptions = {},
  random: RandomSource = Math.random,
): number {
  const { minDelayMs, maxDelayMs } = { ...DEFAULT_PACING, ...options };
  const low = Math.min(minDelayMs, maxDelayMs);
  const high = Math.max(minDelayMs, maxDelayMs);
  return Math.round(low + random() * (high - low));
}

export async function sleep(
  ms: number,
  sleeper: (ms: number) => Promise<void> = (duration) =>
    new Promise((resolve) => setTimeout(resolve, duration)),
): Promise<void> {
  await sleeper(ms);
}

export function isWithinUploadWindow(hour: number, options: PacingOptions = {}): boolean {
  const { windowStartHour, windowEndHour } = { ...DEFAULT_PACING, ...options };
  return hour >= windowStartHour && hour <= windowEndHour;
}

/** Decide whether to skip a scheduled slot; deterministic under a test random source. */
export function shouldSkipSlot(
  random: RandomSource = Math.random,
  options: PacingOptions = {},
): boolean {
  const { noOpDayProbability } = { ...DEFAULT_PACING, ...options };
  return random() < noOpDayProbability;
}

/**
 * Move an out-of-window timestamp to the next in-window hour, with jitter, so
 * posts never land at 04:00 local time.
 */
export function jitterIntoWindow(
  scheduledAt: number,
  timezoneOffsetMinutes: number,
  options: PacingOptions = {},
  random: RandomSource = Math.random,
): number {
  const { windowStartHour, windowEndHour } = { ...DEFAULT_PACING, ...options };
  const local = new Date((scheduledAt + timezoneOffsetMinutes * 60) * 1000);
  const hour = local.getUTCHours();
  const jitterMinutes = Math.floor(random() * 90);
  if (hour >= windowStartHour && hour <= windowEndHour) {
    return scheduledAt + jitterMinutes * 60;
  }
  const target = new Date(local);
  if (hour > windowEndHour) target.setUTCDate(target.getUTCDate() + 1);
  target.setUTCHours(windowStartHour, jitterMinutes, 0, 0);
  return Math.floor(target.getTime() / 1000) - timezoneOffsetMinutes * 60;
}
