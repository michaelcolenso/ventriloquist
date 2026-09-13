import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./context";
import { describeTool, toolAnnotations, wrapHandler, type ToolDefinition } from "./registry";
import { TOOLS } from "./tools";

export const SERVER_INSTRUCTIONS = [
  "Ventriloquist is an unofficial TikTok intelligence facade: no official TikTok APIs, no OAuth, two independent read backends with automatic failover.",
  "Every tool name is prefixed tt_* and every description starts with a risk tier.",
  "GREEN tools scrape public data and are safe to call freely; AMBER tools read session-authenticated data and may expose a burner session; RED tools are write actions against the nobodynamed posting account.",
  "Read tools accumulate their responses into D1, so repeated calls build the proprietary time-series the velocity tools (tt_hashtag_momentum, tt_emerging_in_niche, tt_sound_lifecycle, tt_what_worked) depend on. Call them on a schedule to build history.",
  "When a read tool reports no_provider_available, call tt_system_status to see circuit breakers and the paid budget before retrying.",
  "RED tools enqueue jobs; never assume a post happened until tt_job_status reports posted with a tiktok_url.",
].join(" ");

export function createMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: "ventriloquist", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of TOOLS) {
    registerTool(server, tool, ctx);
  }

  return server;
}

function registerTool(server: McpServer, tool: ToolDefinition, ctx: AppContext): void {
  const handler = wrapHandler(tool);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: describeTool(tool),
      inputSchema: tool.inputSchema,
      annotations: toolAnnotations(tool),
    },
    // The SDK types the callback against its own zod generic; the wrapper keeps
    // runtime behaviour identical while letting the registry stay declarative.
    (async (input: Record<string, unknown>) => handler(input, ctx)) as never,
  );
}
