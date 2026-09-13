import { ProviderError } from "../lib/errors";

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  /** msToken freshness deadline reported by the gateway, if it knows. */
  expiresAt: number | null;
  strategy: string;
}

export interface InPageResponse {
  status: number;
  body: string;
  contentType: string | null;
  strategy: string;
}

/**
 * The gateway has two ways to answer (see signer/src/pagePool.ts):
 * a signed URL any client can fetch, or the body of a request it made itself
 * from inside the warmed page when no signing global exists.
 */
export type SignerResponse =
  | ({ mode: "signed" } & SignedRequest)
  | ({ mode: "in_page" } & InPageResponse);

export interface SignerHealth {
  ok: boolean;
  poolSize: number | null;
  ready: number | null;
  detail: string | null;
}

/**
 * Client for the self-hosted signer gateway (spec 2.1).
 *
 * Gateway contract:
 *   GET  /health -> { ok, pool_size, ready, detail? }
 *   POST /sign   -> { signed_url, headers?, expires_at? }   body: { url, region? }
 */
export class SignerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async health(signal?: AbortSignal): Promise<SignerHealth> {
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/health`, {
        headers: this.headers(),
        signal,
      });
      if (!response.ok) {
        return { ok: false, poolSize: null, ready: null, detail: `HTTP ${response.status}` };
      }
      const body = (await response.json()) as Record<string, unknown>;
      return {
        ok: body.ok === true,
        poolSize: typeof body.pool_size === "number" ? body.pool_size : null,
        ready: typeof body.ready === "number" ? body.ready : null,
        detail: typeof body.detail === "string" ? body.detail : null,
      };
    } catch (error) {
      return {
        ok: false,
        poolSize: null,
        ready: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async sign(
    url: string,
    options: { region?: string; signal?: AbortSignal } = {},
  ): Promise<SignerResponse> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/sign`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ url, region: options.region }),
        signal: options.signal,
      });
    } catch (error) {
      throw new ProviderError("signer", "sign", `signer gateway unreachable: ${String(error)}`, {
        retryable: true,
      });
    }

    if (!response.ok) {
      throw new ProviderError("signer", "sign", `signer gateway returned HTTP ${response.status}`, {
        status: response.status,
        retryable: true,
      });
    }

    const body = (await response.json()) as Record<string, unknown>;

    if (body.mode === "in_page") {
      if (typeof body.body !== "string") {
        throw new ProviderError("signer", "sign", "gateway returned in_page without a body", {
          retryable: true,
        });
      }
      return {
        mode: "in_page",
        status: typeof body.status === "number" ? body.status : 200,
        body: body.body,
        contentType: typeof body.content_type === "string" ? body.content_type : null,
        strategy: typeof body.strategy === "string" ? body.strategy : "in_page",
      };
    }

    const signedUrl = typeof body.signed_url === "string" ? body.signed_url : null;
    if (!signedUrl) {
      throw new ProviderError("signer", "sign", "signer gateway response missing signed_url", {
        retryable: true,
      });
    }
    return {
      mode: "signed",
      url: signedUrl,
      headers:
        body.headers && typeof body.headers === "object"
          ? (body.headers as Record<string, string>)
          : {},
      expiresAt: typeof body.expires_at === "number" ? body.expires_at : null,
      strategy: typeof body.strategy === "string" ? body.strategy : "unknown",
    };
  }
}
