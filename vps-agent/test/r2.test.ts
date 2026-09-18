import { describe, expect, it, vi } from "vitest";
import { R2Client, renderArtifactKey, r2ConfigFromEnv } from "../src/r2";

const config = {
  accountId: "acct",
  accessKeyId: "key",
  secretAccessKey: "secret",
  bucket: "ventriloquist-media",
};

describe("R2 client", () => {
  it("requires the full credential set", () => {
    expect(r2ConfigFromEnv({})).toBeNull();
    expect(r2ConfigFromEnv({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b" })).toBeNull();
    expect(
      r2ConfigFromEnv({
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "ventriloquist-media",
      }),
    ).not.toBeNull();
  });

  it("signs uploads and targets the bucket path", async () => {
    const fetcher = vi.fn(async (_input: Request | string | URL) => new Response(null, { status: 200 }));
    const client = new R2Client(config, fetcher as unknown as typeof fetch);
    await client.put("renders/2026-09-17/job.mp4", new Uint8Array([1, 2, 3]));

    const request = fetcher.mock.calls[0]?.[0] as unknown as Request;
    expect(request.url).toBe(
      "https://acct.r2.cloudflarestorage.com/ventriloquist-media/renders/2026-09-17/job.mp4",
    );
    expect(request.method).toBe("PUT");
    expect(request.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
  });

  it("throws when an upload is rejected", async () => {
    const fetcher = vi.fn(async (_input: Request | string | URL) => new Response("denied", { status: 403 }));
    const client = new R2Client(config, fetcher as unknown as typeof fetch);
    await expect(client.put("k", new Uint8Array([1]))).rejects.toThrow("HTTP 403");
  });

  it("falls back to the public base URL when S3 reads fail", async () => {
    const fetcher = vi.fn(async (input: Request | string | URL) => {
      if (input instanceof Request) return new Response("no", { status: 403 });
      return new Response(new Uint8Array([9, 8, 7]));
    });
    const client = new R2Client(
      { ...config, publicBase: "https://media.example.com/" },
      fetcher as unknown as typeof fetch,
    );
    const bytes = await client.get("renders/a.mp4");
    expect([...bytes]).toEqual([9, 8, 7]);
    const urls = fetcher.mock.calls.map((call) =>
      call[0] instanceof Request ? call[0].url : String(call[0]),
    );
    expect(urls.at(-1)).toBe("https://media.example.com/renders/a.mp4");
  });

  it("builds date-partitioned artifact keys", () => {
    const key = renderArtifactKey("job-1", Date.UTC(2026, 8, 17));
    expect(key).toBe("renders/2026-09-17/job-1.mp4");
  });
});
