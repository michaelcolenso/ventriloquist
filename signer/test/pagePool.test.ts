import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProxyUrl, signOrFetchImpl } from "../src/pagePool";

const fetchStub = () =>
  vi.fn(async () => ({
    status: 200,
    text: async () => '{"ok":1}',
    headers: { get: () => "application/json" },
  }));

function installPage(sign: (input: { url: string }) => unknown) {
  const fetchMock = fetchStub();
  vi.stubGlobal("window", { byted_acrawler: { sign } });
  vi.stubGlobal("document", { cookie: "msToken=abc; other=1" });
  vi.stubGlobal("navigator", { userAgent: "test-agent" });
  vi.stubGlobal("location", { href: "https://www.tiktok.com/" });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const TARGET = "https://www.tiktok.com/api/challenge/detail/?challengeName=x";

describe("signOrFetchImpl", () => {
  it("returns a signed URL when the SDK signer works", async () => {
    const fetchMock = installPage(() => ({ "X-Bogus": "sig" }));
    const outcome = await signOrFetchImpl(TARGET, false);
    expect(outcome.mode).toBe("signed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts msToken in the URL before signing it", async () => {
    const sign = vi.fn((_input: { url: string }) => ({ "X-Bogus": "sig" }));
    installPage(sign);
    await signOrFetchImpl(TARGET, false);
    expect(sign.mock.calls[0]![0].url).toContain("msToken=abc");
  });

  it("fetches inside the page without signing, leaving that to the SDK's fetch hook, when forced", async () => {
    const sign = vi.fn((_input: { url: string }) => ({ "X-Bogus": "sig" }));
    const fetchMock = installPage(sign);
    const outcome = await signOrFetchImpl(TARGET, true);
    expect(outcome).toMatchObject({ mode: "in_page", status: 200, body: '{"ok":1}', strategy: "in_page_fetch (forced)" });
    expect(sign).not.toHaveBeenCalled();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).not.toContain("X-Bogus");
  });
});

describe("parseProxyUrl", () => {
  it("returns null when unset or blank", () => {
    expect(parseProxyUrl(undefined)).toBeNull();
    expect(parseProxyUrl("  ")).toBeNull();
  });

  it("splits credentials from the proxy server", () => {
    expect(parseProxyUrl("http://us%40er:p%3Ass@proxy.example.com:8000")).toEqual({
      server: "http://proxy.example.com:8000",
      username: "us@er",
      password: "p:ss",
    });
    expect(parseProxyUrl("socks5://proxy.example.com:1080")).toEqual({ server: "socks5://proxy.example.com:1080" });
  });

  it("rejects unsupported protocols", () => {
    expect(() => parseProxyUrl("ftp://proxy.example.com")).toThrow(/unsupported proxy protocol/);
  });
});
