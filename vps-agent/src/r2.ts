import { AwsClient } from "aws4fetch";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional public base URL, used as a read fallback when S3 is unavailable. */
  publicBase?: string;
}

export interface R2Env {
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_PUBLIC_BASE?: string;
}

export function r2ConfigFromEnv(env: R2Env): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
    ...(env.R2_PUBLIC_BASE ? { publicBase: env.R2_PUBLIC_BASE } : {}),
  };
}

/**
 * Minimal R2 (S3-compatible) client.
 *
 * The VPS owns the render output, so it also owns persistence: rendered MP4s
 * go straight to R2 with scoped S3 credentials, and the key travels back to
 * the facade in the job callback. Reads prefer S3 and fall back to the public
 * base URL when one is configured.
 */
export class R2Client {
  private readonly client: AwsClient;

  constructor(
    private readonly config: R2Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
    });
  }

  objectUrl(key: string): string {
    const encoded = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `https://${this.config.accountId}.r2.cloudflarestorage.com/${this.config.bucket}/${encoded}`;
  }

  async put(key: string, body: Uint8Array, contentType = "video/mp4"): Promise<void> {
    const request = await this.client.sign(this.objectUrl(key), {
      method: "PUT",
      headers: { "content-type": contentType },
      body,
    });
    const response = await this.fetcher(request);
    if (!response.ok) {
      throw new Error(`R2 upload failed for ${key}: HTTP ${response.status}`);
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const request = await this.client.sign(this.objectUrl(key));
      const response = await this.fetcher(request);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (!this.config.publicBase) throw error;
      const fallback = await this.fetcher(
        `${this.config.publicBase.replace(/\/$/, "")}/${key.replace(/^\//, "")}`,
      );
      if (!fallback.ok) {
        throw new Error(
          `artifact download failed for ${key}: S3 error (${String(error)}), public base HTTP ${fallback.status}`,
        );
      }
      return new Uint8Array(await fallback.arrayBuffer());
    }
  }
}

export function renderArtifactKey(jobId: string, now = Date.now()): string {
  return `renders/${new Date(now).toISOString().slice(0, 10)}/${jobId}.mp4`;
}
