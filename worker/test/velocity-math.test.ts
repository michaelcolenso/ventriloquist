import { describe, expect, it } from "vitest";
import {
  computeVelocity,
  isBreakout,
  mean,
  median,
  standardDeviation,
  type SeriesPoint,
} from "../src/velocity/math";

const DAY = 86_400;
const NOW = 1_800_000_000;

/** Four snapshots a day apart, ending "now". */
function series(values: number[], endAt = NOW): SeriesPoint[] {
  const start = endAt - (values.length - 1) * DAY;
  return values.map((value, index) => ({ t: start + index * DAY, v: value }));
}

describe("computeVelocity", () => {
  it("reports accelerating growth as GROWTH with positive actionability", () => {
    // Flat 1M/day then 2M/day then 4M/day: velocity rising => positive acceleration.
    const metrics = computeVelocity(series([1_000_000, 2_000_000, 4_000_000, 8_000_000]), {
      saturationThreshold: 50_000_000,
      now: NOW,
    });

    expect(metrics.lifecycle).toBe("GROWTH");
    expect(metrics.acceleration).toBeGreaterThan(0);
    expect(metrics.accelerationScore).toBeGreaterThan(0);
    expect(metrics.saturation).toBeLessThan(1);
    expect(metrics.actionability).toBeGreaterThan(0);
    expect(metrics.velocity24h).toBeGreaterThan(0);
  });

  it("flags an entity with fewer than 4 snapshots or <3 days as EMBRYONIC", () => {
    const metrics = computeVelocity(series([10, 20, 40]), {
      saturationThreshold: 1_000_000,
      now: NOW,
    });
    expect(metrics.lifecycle).toBe("EMBRYONIC");
  });

  it("flags a saturating curve as PEAK or PLATEAU, never GROWTH", () => {
    const metrics = computeVelocity(
      series([1_000_000, 40_000_000, 80_000_000, 95_000_000, 99_000_000]),
      { saturationThreshold: 100_000_000, now: NOW },
    );
    expect(["PEAK", "PLATEAU", "DECAY"]).toContain(metrics.lifecycle);
    expect(metrics.saturation).toBeCloseTo(0.99, 2);
  });

  it("detects DECAY after three consecutive negative accelerations", () => {
    // Slopes: 10, 8, 5, 1, -2 (per interval) => accelerations all negative.
    const metrics = computeVelocity(
      series([0, 10, 18, 23, 24, 22, 18, 12, 5], NOW - 8 * DAY - 5),
      { saturationThreshold: 1_000_000_000, now: NOW },
    );
    expect(metrics.negativeStreak).toBeGreaterThanOrEqual(3);
    expect(metrics.lifecycle).toBe("DECAY");
  });

  it("returns UNKNOWN for an empty series and never throws on one point", () => {
    expect(computeVelocity([], { saturationThreshold: 100, now: NOW }).lifecycle).toBe("UNKNOWN");
    expect(computeVelocity(series([5]), { saturationThreshold: 100, now: NOW }).lifecycle).toBe(
      "UNKNOWN",
    );
  });

  it("scales actionability by niche relevance", () => {
    const points = series([1_000_000, 2_000_000, 4_000_000, 8_000_000]);
    const onNiche = computeVelocity(points, { saturationThreshold: 50_000_000, nicheRelevance: 1, now: NOW });
    const offNiche = computeVelocity(points, {
      saturationThreshold: 50_000_000,
      nicheRelevance: 0.5,
      now: NOW,
    });
    expect(offNiche.actionability).toBeCloseTo((onNiche.actionability ?? 0) / 2, 5);
  });
});

describe("statistics helpers", () => {
  it("computes median, mean and standard deviation", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(mean([2, 4, 6])).toBe(4);
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 5);
  });

  it("detects a breakout 3 sigma above the trailing median", () => {
    const baseline = [1_000, 1_100, 950, 1_050, 1_020, 990];
    expect(isBreakout(1_050, baseline).breakout).toBe(false);
    const breakout = isBreakout(50_000, baseline);
    expect(breakout.breakout).toBe(true);
    expect(breakout.ratio).toBeGreaterThan(40);
  });

  it("does not call a breakout on sparse history", () => {
    expect(isBreakout(999_999, [100, 120]).breakout).toBe(false);
  });
});
