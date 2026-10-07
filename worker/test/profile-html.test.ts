import { describe, expect, it } from "vitest";
import { SignerProvider } from "../src/backends/providers/signer";
import { SignerClient } from "../src/backends/signerClient";
import type { CallContext } from "../src/backends/types";
import { ProviderError } from "../src/lib/errors";
import { extractUserDetailFromHtml } from "../src/domain/tiktok-web";

function pageWith(detail: unknown): string {
  const data = { __DEFAULT_SCOPE__: { "webapp.user-detail": detail } };
  return `<html><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

function providerServing(html: string): { provider: SignerProvider; signedUrls: string[] } {
  const signedUrls: string[] = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    const { url } = JSON.parse(String(init?.body)) as { url: string };
    signedUrls.push(url);
    return new Response(
      JSON.stringify({ mode: "in_page", status: 200, body: html, content_type: "text/html", strategy: "test" }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { provider: new SignerProvider(new SignerClient("https://signer.test", "t", fetcher)), signedUrls };
}

const ctx = { region: "US" } as unknown as CallContext;

describe("extractUserDetailFromHtml", () => {
  it("returns the embedded webapp.user-detail object", () => {
    const detail = { statusCode: 0, userInfo: { user: { uniqueId: "tiktok" } } };
    expect(extractUserDetailFromHtml(pageWith(detail))).toEqual(detail);
  });

  it("returns null when the script is missing or malformed", () => {
    expect(extractUserDetailFromHtml("<html></html>")).toBeNull();
    expect(
      extractUserDetailFromHtml('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{nope</script>'),
    ).toBeNull();
    expect(extractUserDetailFromHtml(pageWith(undefined))).toBeNull();
  });
});

describe("signer provider profile via the profile page", () => {
  it("maps the embedded user detail to a profile and asks for the /@handle page", async () => {
    const { provider, signedUrls } = providerServing(
      pageWith({
        statusCode: 0,
        userInfo: {
          user: { id: "6", uniqueId: "tiktok", nickname: "TikTok", verified: true, secUid: "MS4w" },
          stats: { followerCount: 96_100_000, heartCount: 465_200_000, videoCount: 1510, followingCount: 1 },
        },
      }),
    );
    const profile = (await provider.execute("profile", { username: "@tiktok" }, ctx)) as {
      uniqueId: string;
      stats: { followerCount: number };
    };
    expect(profile.uniqueId).toBe("tiktok");
    expect(profile.stats.followerCount).toBe(96_100_000);
    expect(signedUrls).toEqual(["https://www.tiktok.com/@tiktok"]);
  });

  it("treats a missing page payload as a retryable provider fault", async () => {
    const { provider } = providerServing("<html>captcha</html>");
    const error = await provider.execute("profile", { username: "x" }, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
    expect((error as ProviderError).countsTowardBreaker).toBe(true);
  });

  it("does not trip the breaker for an unknown handle", async () => {
    const { provider } = providerServing(pageWith({ statusCode: 10202, userInfo: {} }));
    const error = await provider.execute("profile", { username: "nope" }, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).countsTowardBreaker).toBe(false);
    expect((error as ProviderError).retryable).toBe(false);
  });
});
