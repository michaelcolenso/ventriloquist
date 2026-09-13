import Fastify, { type FastifyInstance } from "fastify";
import { assertAllowedTarget, type Signer } from "./pagePool";
import {
  mockCreativeCenterResponse,
  mockScrapeBadgerResponse,
  mockTikTokResponse,
} from "./mock";

export interface ServerDeps {
  signer: Signer;
  token: string;
  mock: boolean;
  logger?: boolean;
}

export interface SignRequestBody {
  url?: string;
  region?: string;
}

/**
 * The signer gateway HTTP surface (spec 2.1).
 *
 *   GET  /health              -> pool readiness
 *   POST /sign                -> signed URL, or the in-page fetched body
 *   GET  /mock/tiktok/*       -> deterministic fixtures (MOCK=1 only)
 *   GET  /mock/creative_center/* -> deterministic fixtures (MOCK=1 only)
 *
 * /sign is authenticated with a shared bearer token and restricted to TikTok
 * hosts so the gateway cannot be turned into an open proxy.
 */
export function createServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  app.get("/health", async () => {
    const health = await deps.signer.health();
    return {
      ok: health.ok,
      pool_size: health.poolSize,
      ready: health.ready,
      detail: health.detail,
      mock: deps.mock,
      mode: deps.mock ? "mock" : "browser",
    };
  });

  app.post<{ Body: SignRequestBody }>("/sign", async (request, reply) => {
    if (!authorized(request.headers.authorization, deps.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const url = request.body?.url;
    if (typeof url !== "string" || url.trim() === "") {
      return reply.code(400).send({ error: "url is required" });
    }

    const now = Math.floor(Date.now() / 1000);
    if (deps.mock) {
      const parsed = new URL(url);
      const body = mockTikTokResponse(parsed.pathname, parsed.searchParams, now);
      if (body === null) {
        return reply.code(404).send({ error: "no mock fixture for path", path: parsed.pathname });
      }
      return {
        mode: "in_page",
        status: 200,
        body: JSON.stringify(body),
        content_type: "application/json",
        strategy: "mock",
      };
    }

    try {
      assertAllowedTarget(url);
    } catch (error) {
      return reply.code(400).send({ error: String(error instanceof Error ? error.message : error) });
    }

    try {
      const outcome = await deps.signer.sign(url);
      return outcome.mode === "signed"
        ? {
            mode: "signed",
            signed_url: outcome.url,
            headers: outcome.headers,
            expires_at: outcome.expiresAt,
            strategy: outcome.strategy,
          }
        : {
            mode: "in_page",
            status: outcome.status,
            body: outcome.body,
            content_type: outcome.contentType,
            strategy: outcome.strategy,
          };
    } catch (error) {
      request.log.error({ err: error }, "sign failed");
      return reply.code(502).send({
        error: "sign_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Mock-only fixture endpoints. The facade points its Creative Center base
  // URL here when running end to end without network access.
  app.get("/mock/creative_center/*", async (request, reply) => {
    if (!deps.mock) return reply.code(404).send({ error: "not found" });
    const parsed = new URL(request.url, "http://mock.local");
    const path = parsed.pathname.replace("/mock/creative_center", "");
    const body = mockCreativeCenterResponse(path, parsed.searchParams, Math.floor(Date.now() / 1000));
    if (body === null) {
      return reply.code(404).send({ error: "no mock fixture for path", path });
    }
    return body;
  });

  app.get("/mock/tiktok/*", async (request, reply) => {
    if (!deps.mock) return reply.code(404).send({ error: "not found" });
    const parsed = new URL(request.url, "http://mock.local");
    const path = parsed.pathname.replace("/mock/tiktok", "");
    const body = mockTikTokResponse(path, parsed.searchParams, Math.floor(Date.now() / 1000));
    if (body === null) {
      return reply.code(404).send({ error: "no mock fixture for path", path });
    }
    return body;
  });

  app.get("/mock/scrapebadger/*", async (request, reply) => {
    if (!deps.mock) return reply.code(404).send({ error: "not found" });
    const parsed = new URL(request.url, "http://mock.local");
    const path = parsed.pathname.replace("/mock/scrapebadger", "");
    const body = mockScrapeBadgerResponse(path, parsed.searchParams, Math.floor(Date.now() / 1000));
    if (body === null) {
      return reply.code(404).send({ error: "no mock fixture for path", path });
    }
    return body;
  });

  return app;
}

function authorized(header: string | undefined, token: string): boolean {
  if (!token) return true;
  if (!header) return false;
  return header.replace(/^Bearer\s+/i, "").trim() === token;
}
