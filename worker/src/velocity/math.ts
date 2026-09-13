/**
 * Velocity math (spec section 5.3).
 *
 * Pure functions over a time series so the classifier can be tested against
 * synthetic curves - an accelerating hashtag, a saturating one, a decaying one -
 * without a database or a live TikTok request.
 */

export type LifecycleStage =
  | "EMBRYONIC"
  | "GROWTH"
  | "PEAK"
  | "DECAY"
  | "PLATEAU"
  | "UNKNOWN";

export interface SeriesPoint {
  /** unix epoch seconds */
  t: number;
  /** metric being tracked (views, posts, videos using a sound) */
  v: number;
}

export interface VelocityOptions {
  /** Absolute count at which this niche is considered saturated. */
  saturationThreshold: number;
  /** Product relevance multiplier (1 = perfectly on-niche). */
  nicheRelevance?: number;
  /** Minimum snapshots before GROWTH/PEAK are asserted. */
  minSamples?: number;
  /** Days of history below which an entity is EMBRYONIC. */
  embryonicDays?: number;
  /** Snapshots of consecutive negative acceleration that mean DECAY. */
  decayStreak?: number;
  now?: number;
}

export interface VelocityMetrics {
  samples: number;
  firstAt: number | null;
  lastAt: number | null;
  historyDays: number;
  current: number | null;
  /** Change per day over the trailing 24h. */
  velocity24h: number | null;
  /** Change per day over the trailing 7d window (or available history). */
  velocity7d: number | null;
  /** velocity24h - velocity7d. Positive means accelerating. */
  acceleration: number | null;
  /** Acceleration normalized to the entity's own scale, in [-1, 1]. */
  accelerationScore: number | null;
  /** Share of the niche saturation threshold already consumed, 0-1. */
  saturation: number | null;
  /** accelerationScore * (1 - saturation) * nicheRelevance. */
  actionability: number | null;
  /** Trailing consecutive negative accelerations. */
  negativeStreak: number;
  peakVelocity: number | null;
  peakAt: number | null;
  lifecycle: LifecycleStage;
  saturationEstimate: string | null;
}

export const DEFAULT_OPTIONS: Omit<Required<VelocityOptions>, "saturationThreshold"> = {
  nicheRelevance: 1,
  minSamples: 4,
  embryonicDays: 3,
  decayStreak: 3,
  now: Math.floor(Date.now() / 1000),
};

function sorted(points: SeriesPoint[]): SeriesPoint[] {
  return [...points]
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
    .sort((a, b) => a.t - b.t);
}

/** Value at or just before `target`, else the earliest point after it. */
function valueAt(points: SeriesPoint[], target: number): SeriesPoint | null {
  let best: SeriesPoint | null = null;
  for (const point of points) {
    if (point.t <= target) best = point;
    else if (!best) return point;
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Trailing streak of non-increasing per-interval slopes. Used for DECAY,
 * which the spec defines as "negative acceleration 3+ consecutive snapshots".
 */
function trailingNegativeStreak(points: SeriesPoint[]): number {
  const slopes: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const dt = current.t - previous.t;
    if (dt <= 0) continue;
    slopes.push((current.v - previous.v) / dt);
  }
  let streak = 0;
  for (let index = slopes.length - 1; index > 0; index -= 1) {
    const acceleration = slopes[index]! - slopes[index - 1]!;
    if (acceleration < 0) streak += 1;
    else break;
  }
  return streak;
}

export function classifyLifecycle(
  metrics: Pick<
    VelocityMetrics,
    | "samples"
    | "historyDays"
    | "acceleration"
    | "accelerationScore"
    | "negativeStreak"
    | "velocity24h"
    | "peakVelocity"
    | "current"
    | "saturation"
  >,
  options: Required<VelocityOptions>,
): LifecycleStage {
  if (metrics.samples < 2 || metrics.current === null) return "UNKNOWN";
  if (metrics.historyDays < options.embryonicDays || metrics.samples < options.minSamples) {
    return "EMBRYONIC";
  }
  if (metrics.negativeStreak >= options.decayStreak) return "DECAY";
  const saturated =
    metrics.saturation !== null && metrics.saturation >= 0.9;
  if (
    metrics.peakVelocity !== null &&
    metrics.velocity24h !== null &&
    metrics.velocity24h >= metrics.peakVelocity * 0.98 &&
    (metrics.accelerationScore ?? 0) <= 0
  ) {
    return "PEAK";
  }
  if ((metrics.accelerationScore ?? 0) > 0 && !saturated) return "GROWTH";
  if (saturated) return "PLATEAU";
  return "PLATEAU";
}

export function computeVelocity(
  rawPoints: SeriesPoint[],
  options: VelocityOptions,
): VelocityMetrics {
  const opts: Required<VelocityOptions> = { ...DEFAULT_OPTIONS, ...options };
  const points = sorted(rawPoints);
  const empty: VelocityMetrics = {
    samples: points.length,
    firstAt: points[0]?.t ?? null,
    lastAt: points.at(-1)?.t ?? null,
    historyDays: 0,
    current: points.at(-1)?.v ?? null,
    velocity24h: null,
    velocity7d: null,
    acceleration: null,
    accelerationScore: null,
    saturation: null,
    actionability: null,
    negativeStreak: 0,
    peakVelocity: null,
    peakAt: null,
    lifecycle: "UNKNOWN",
    saturationEstimate: null,
  };
  if (points.length === 0) return empty;

  const last = points.at(-1)!;
  const first = points[0]!;
  const historyDays = (last.t - first.t) / 86_400;
  const dayAgo = last.t - 86_400;
  const weekAgo = last.t - 7 * 86_400;

  const start24 = valueAt(points, dayAgo);
  const start7d = valueAt(points, weekAgo);

  const velocity24h =
    start24 && start24.t < last.t
      ? (last.v - start24.v) / ((last.t - start24.t) / 86_400)
      : null;

  // A 7d "average velocity" needs more than one data point; when history is
  // shorter than the window we divide by the actual elapsed span.
  const velocity7d =
    start7d && start7d.t < last.t
      ? (last.v - start7d.v) / ((last.t - start7d.t) / 86_400)
      : points.length > 1
        ? (last.v - first.v) / Math.max((last.t - first.t) / 86_400, 1 / 24)
        : null;

  const acceleration =
    velocity24h !== null && velocity7d !== null ? velocity24h - velocity7d : null;

  const scale = Math.max(Math.abs(velocity7d ?? 0), Math.abs(last.v) / Math.max(historyDays, 1), 1);
  const accelerationScore =
    acceleration === null ? null : clamp(acceleration / scale, -1, 1);

  const saturation =
    opts.saturationThreshold > 0
      ? clamp(last.v / opts.saturationThreshold, 0, 1)
      : null;

  const actionability =
    accelerationScore === null || saturation === null
      ? null
      : accelerationScore * (1 - saturation) * opts.nicheRelevance;

  let peakVelocity: number | null = null;
  let peakAt: number | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const dt = (current.t - previous.t) / 86_400;
    if (dt <= 0) continue;
    const slope = (current.v - previous.v) / dt;
    if (peakVelocity === null || slope > peakVelocity) {
      peakVelocity = slope;
      peakAt = current.t;
    }
  }

  const negativeStreak = trailingNegativeStreak(points);

  const partial = {
    samples: points.length,
    historyDays,
    acceleration,
    accelerationScore,
    negativeStreak,
    velocity24h,
    peakVelocity,
    current: last.v,
    saturation,
  };

  const lifecycle = classifyLifecycle(partial, opts);

  return {
    ...empty,
    samples: points.length,
    historyDays: round(historyDays, 3),
    current: last.v,
    velocity24h: velocity24h === null ? null : round(velocity24h, 2),
    velocity7d: velocity7d === null ? null : round(velocity7d, 2),
    acceleration: acceleration === null ? null : round(acceleration, 2),
    accelerationScore: accelerationScore === null ? null : round(accelerationScore, 5),
    saturation: saturation === null ? null : round(saturation, 4),
    actionability: actionability === null ? null : round(actionability, 6),
    negativeStreak,
    peakVelocity: peakVelocity === null ? null : round(peakVelocity, 2),
    peakAt,
    lifecycle,
    saturationEstimate:
      saturation === null
        ? null
        : saturation >= 0.9
          ? "saturated"
          : saturation >= 0.5
            ? "mid-life"
            : "early",
  };
}

/** Median of a numeric list; null for an empty list. */
export function median(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const middle = Math.floor(clean.length / 2);
  if (clean.length % 2 === 0) return (clean[middle - 1]! + clean[middle]!) / 2;
  return clean[middle]!;
}

export function mean(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return null;
  return clean.reduce((total, value) => total + value, 0) / clean.length;
}

export function standardDeviation(values: number[]): number | null {
  const average = mean(values);
  if (average === null) return null;
  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Breakout detection (spec 5.4): a video more than `sigmas` standard
 * deviations above an account's trailing median plays.
 */
export function isBreakout(
  plays: number,
  trailingPlays: number[],
  sigmas = 3,
): { breakout: boolean; ratio: number | null; zScore: number | null } {
  const baseline = median(trailingPlays);
  if (baseline === null || trailingPlays.length < 3) {
    return { breakout: false, ratio: null, zScore: null };
  }
  const deviation = standardDeviation(trailingPlays) ?? 0;
  const zScore = deviation === 0 ? (plays > baseline ? Infinity : 0) : (plays - baseline) / deviation;
  const ratio = baseline === 0 ? null : plays / baseline;
  return { breakout: zScore >= sigmas, ratio, zScore: Number.isFinite(zScore) ? round(zScore, 3) : zScore };
}
