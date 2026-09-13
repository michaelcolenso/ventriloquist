import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "../env";
import { createAppContext } from "../mcp/context";
import { createMcpServer } from "../mcp/server";
import { TOOLS } from "../mcp/tools";
import { describeTool } from "../mcp/registry";
import { buildBackends } from "../backends/providers";
import { createLogger } from "../lib/logger";
import { DAY } from "../lib/time";

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: WorkerContext,
): Promise<Response> {
  const url = new URL(request.url);
  const logger = createLogger("info", { path: url.pathname });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, accept, mcp-session-id",
      },
    });
  }

  if (url.pathname === "/healthz") {
    return json({
      ok: true,
      service: "ventriloquist",
      version: "0.1.0",
      time: Math.floor(Date.now() / 1000),
    });
  }

  if (url.pathname === "/" && request.method === "GET") {
    return json({
      service: "ventriloquist",
      description: "Unofficial TikTok MCP facade",
      mcp_endpoint: "/mcp",
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        risk: tool.risk,
        title: tool.title,
        description: describeTool(tool),
      })),
    });
  }

  if (url.pathname === "/mcp") {
    if (!authorize(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }
    return handleMcp(request, env, ctx, logger);
  }

  if (url.pathname.startsWith("/admin/")) {
    return handleAdmin(request, env, ctx, url);
  }

  return json({ error: "not_found", path: url.pathname }, 404);
}

function authorize(request: Request, env: Env): boolean {
  if (!env.MCP_AUTH_TOKEN) return true;
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token === env.MCP_AUTH_TOKEN;
}

async function handleMcp(
  request: Request,
  env: Env,
  ctx: WorkerContext,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const appContext = createAppContext(env, {
    waitUntil: (promise) => ctx.waitUntil(promise),
    logger,
  });
  const server = createMcpServer(appContext);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } catch (error) {
    logger.error("mcp request failed", { error: String(error) });
    return json({ error: "mcp_transport_error", detail: String(error) }, 500);
  }
}

async function handleAdmin(
  request: Request,
  env: Env,
  ctx: WorkerContext,
  url: URL,
): Promise<Response> {
  const logger = createLogger("info", { path: url.pathname });
  const appContext = createAppContext(env, {
    waitUntil: (promise) => ctx.waitUntil(promise),
    logger,
  });

  try {
    if (url.pathname === "/admin/providers" && request.method === "GET") {
      const rows = [];
      for (const provider of appContext.backends.registry.list()) {
        const health = await appContext.backends.health.get(provider.name);
        rows.push({
          provider: provider.name,
          capabilities: provider.capabilities,
          cost_per_call_usd: provider.costPerCallUSD,
          health,
          circuit_open: health.circuitOpenUntil !== null && health.circuitOpenUntil > appContext.now,
        });
      }
      return json({ providers: rows });
    }

    if (url.pathname === "/admin/providers/reset" && request.method === "POST") {
      const provider = url.searchParams.get("provider");
      if (!provider) return json({ error: "provider query parameter required" }, 400);
      await appContext.backends.health.reset(provider as never);
      return json({ ok: true, provider, reset: true });
    }

    if (url.pathname === "/admin/ledger" && request.method === "GET") {
      const days = Number(url.searchParams.get("days") ?? "30");
      const since = appContext.now - Math.max(1, days) * (DAY / 1000);
      const [rows, budget] = await Promise.all([
        appContext.backends.ledger.reliability(Math.floor(since)),
        appContext.backends.ledger.budgetState(appContext.now),
      ]);
      return json({ window_days: days, budget, reliability: rows });
    }

    if (url.pathname === "/admin/cohort" && request.method === "POST") {
      const body = (await request.json()) as {
        accounts?: { username: string; niche?: string; follower_count?: number }[];
      };
      const accounts = body.accounts ?? [];
      if (accounts.length === 0) return json({ error: "accounts[] required" }, 400);
      const statements = accounts.map((account) =>
        env.DB.prepare(
          `INSERT INTO shadow_cohort (username, niche, added_at, follower_count)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (username) DO UPDATE SET
             niche = COALESCE(excluded.niche, shadow_cohort.niche),
             follower_count = COALESCE(excluded.follower_count, shadow_cohort.follower_count)`,
        ).bind(
          account.username.replace(/^@/, ""),
          account.niche ?? null,
          appContext.now,
          account.follower_count ?? null,
        ),
      );
      await env.DB.batch(statements);
      const size = await env.DB.prepare(`SELECT COUNT(*) AS count FROM shadow_cohort`).first<{
        count: number;
      }>();
      return json({ ok: true, added: accounts.length, cohort_size: size?.count ?? null });
    }

    if (url.pathname === "/admin/watchlist" && request.method === "POST") {
      const body = (await request.json()) as {
        entities?: { entity_type: string; entity_id: string; niche?: string }[];
      };
      const entities = body.entities ?? [];
      if (entities.length === 0) return json({ error: "entities[] required" }, 400);
      const statements = entities.map((entity) =>
        env.DB.prepare(
          `INSERT INTO watchlist (entity_type, entity_id, niche, added_at, active)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT (entity_type, entity_id) DO UPDATE SET
             niche = COALESCE(excluded.niche, watchlist.niche),
             active = 1`,
        ).bind(entity.entity_type, entity.entity_id, entity.niche ?? null, appContext.now),
      );
      await env.DB.batch(statements);
      return json({ ok: true, added: entities.length });
    }

    if (url.pathname === "/admin/budget" && request.method === "POST") {
      const body = (await request.json()) as { daily_usd?: number };
      if (typeof body.daily_usd !== "number" || body.daily_usd < 0) {
        return json({ error: "daily_usd must be a non-negative number" }, 400);
      }
      await env.KV.put("budget:daily_usd", String(body.daily_usd));
      return json({ ok: true, daily_usd: body.daily_usd });
    }

    return json({ error: "not_found", path: url.pathname }, 404);
  } catch (error) {
    logger.error("admin request failed", { error: String(error) });
    return json({ error: "admin_error", detail: String(error) }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
