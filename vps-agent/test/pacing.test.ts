import { describe, expect, it } from "vitest";
import {
  actionDelayMs,
  isWithinUploadWindow,
  jitterIntoWindow,
  shouldSkipSlot,
  DEFAULT_PACING,
} from "../src/pacing";
import { parseStudioAnalyticsPayload } from "../src/studio";

describe("pacing theater", () => {
  it("keeps inter-action delays inside the 3-11s envelope", () => {
    expect(actionDelayMs({}, () => 0)).toBe(3_000);
    expect(actionDelayMs({}, () => 1)).toBe(11_000);
    const seen = Array.from({ length: 200 }, () => actionDelayMs());
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(3_000);
    expect(Math.max(...seen)).toBeLessThanOrEqual(11_000);
  });

  it("honours a custom envelope and tolerates a reversed one", () => {
    expect(actionDelayMs({ minDelayMs: 5_000, maxDelayMs: 6_000 }, () => 0.5)).toBe(5_500);
    expect(actionDelayMs({ minDelayMs: 9_000, maxDelayMs: 1_000 }, () => 0)).toBe(1_000);
  });

  it("treats the upload window as local hours 7-22", () => {
    expect(isWithinUploadWindow(6)).toBe(false);
    expect(isWithinUploadWindow(7)).toBe(true);
    expect(isWithinUploadWindow(22)).toBe(true);
    expect(isWithinUploadWindow(23)).toBe(false);
    expect(DEFAULT_PACING.windowStartHour).toBe(7);
  });

  it("skips roughly noOpDayProbability of slots", () => {
    expect(shouldSkipSlot(() => 0.01)).toBe(true);
    expect(shouldSkipSlot(() => 0.9)).toBe(false);
  });

  it("jitters within the window and never leaves an in-window post untouched by jitter", () => {
    const inWindowLocal7 = 1_789_322_400; // 2026-09-13T14:00:00Z == 07:00 at UTC-7
    const jittered = jitterIntoWindow(inWindowLocal7, -420, {}, () => 0.5);
    expect(jittered).toBeGreaterThanOrEqual(inWindowLocal7);
    expect(jittered).toBeLessThanOrEqual(inWindowLocal7 + 90 * 60);
  });

  it("moves an out-of-window timestamp forward into the window", () => {
    const earlyMorning = 1_789_296_000; // 04:00 UTC == 21:00 local previous day
    const moved = jitterIntoWindow(earlyMorning, -420, {}, () => 0.25);
    const movedHour = new Date((moved - 420 * 60) * 1000).getUTCHours();
    expect(moved).toBeGreaterThan(earlyMorning);
    expect(movedHour).toBeGreaterThanOrEqual(7);
  });
});

describe("studio analytics parsing", () => {
  it("maps a normalized analytics payload", () => {
    const rows = parseStudioAnalyticsPayload(
      {
        data: [
          {
            item_id: "741",
            stats: {
              total_watch_time: 12_345.6,
              average_watch_time: 9.1,
              full_watch_rate: 0.42,
              traffic_sources: [{ source: "fyp", share: 0.88 }],
              retention: [1, 0.8, 0.5],
            },
          },
        ],
      },
      1_800_000_000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.video_id).toBe("741");
    expect(rows[0]!.average_watch_time_seconds).toBe(9.1);
    expect(rows[0]!.full_watch_rate).toBe(0.42);
    expect(rows[0]!.captured_at).toBe(1_800_000_000);
  });

  it("ignores entries without a video id", () => {
    expect(parseStudioAnalyticsPayload({ data: [{ stats: {} }] }, 1)).toEqual([]);
    expect(parseStudioAnalyticsPayload(null, 1)).toEqual([]);
  });
});
