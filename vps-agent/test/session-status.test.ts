import { describe, expect, it } from "vitest";
import { evaluateSession, type SessionCookie } from "../src/sessions";

const NOW_MS = 1_800_000_000_000;

function cookie(overrides: Partial<SessionCookie> = {}): SessionCookie {
  return { name: "sessionid", value: "secret", domain: ".tiktok.com", path: "/", ...overrides };
}

describe("session staleness", () => {
  it("is fresh when the sessionid cookie exists and the file is recent", () => {
    const status = evaluateSession([cookie()], { fileMtimeMs: NOW_MS - 86_400_000, nowMs: NOW_MS });
    expect(status.stale).toBe(false);
    expect(status.has_sessionid).toBe(true);
  });

  it("flags a missing sessionid", () => {
    const status = evaluateSession([cookie({ name: "ttwid" })], { fileMtimeMs: NOW_MS, nowMs: NOW_MS });
    expect(status.stale).toBe(true);
    expect(status.detail).toContain("sessionid");
  });

  it("flags an expired cookie", () => {
    const status = evaluateSession([cookie({ expires: NOW_MS / 1000 - 60 })], {
      fileMtimeMs: NOW_MS,
      nowMs: NOW_MS,
    });
    expect(status.stale).toBe(true);
    expect(status.detail).toContain("expired");
  });

  it("flags an old sealed file even when cookies look valid", () => {
    const status = evaluateSession([cookie()], {
      fileMtimeMs: NOW_MS - 45 * 86_400_000,
      nowMs: NOW_MS,
      maxAgeDays: 30,
    });
    expect(status.stale).toBe(true);
    expect(status.detail).toContain("days old");
  });
});
