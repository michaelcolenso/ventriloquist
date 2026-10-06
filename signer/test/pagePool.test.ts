import { afterEach, describe, expect, it, vi } from "vitest";
import { signOrFetchImpl } from "../src/pagePool";

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

  it("signs, then fetches the signed URL inside the page, when forced", async () => {
    const sign = vi.fn(() => ({ "X-Bogus": "sig" }));
    const fetchMock = installPage(sign);
    const outcome = await signOrFetchImpl(TARGET, true);
    expect(outcome).toMatchObject({
      mode: "in_page",
      status: 200,
      body: '{"ok":1}',
      strategy: "byted_acrawler.sign + in_page_fetch (forced)",
    });
    expect(sign).toHaveBeenCalledOnce();
    const fetchedUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(fetchedUrl).toContain("X-Bogus=sig");
    expect(fetchedUrl).toContain("msToken=abc");
  });
});
