import type { z } from "zod";
import { RISK_LABEL, type RiskTier } from "../types";
import type { AppContext } from "./context";
import type { ToolPayload } from "./result";
import { toErrorResult, toCallToolResult, type CallToolResultLike } from "./result";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  risk: RiskTier;
  title: string;
  summary: string;
  inputSchema: Shape;
  annotations?: ToolAnnotations;
  handler: (input: z.infer<z.ZodObject<Shape>>, ctx: AppContext) => Promise<ToolPayload>;
}

const RISK_ANNOTATIONS: Record<RiskTier, ToolAnnotations> = {
  GREEN: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  AMBER: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  RED: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

const RISK_CAVEAT: Record<RiskTier, string> = {
  GREEN:
    "Risk: GREEN (scraped public data). No session or account credentials are used; responses are snapshotted into D1.",
  AMBER:
    "Risk: AMBER (session-authenticated read). Uses a disposable burner session; soft-ban and cookie-exposure risk apply.",
  RED:
    "Risk: RED (write action). Uses the nobodynamed posting session. Capped at 5 posts/day with a 3h minimum spacing, human pacing, and halt-on-failure after two consecutive post failures.",
};

export function defineTool<Shape extends z.ZodRawShape>(
  definition: ToolDefinition<Shape>,
): ToolDefinition<Shape> {
  return definition;
}

/** Tool descriptions carry the risk tier so any calling agent can reason about them (P4). */
export function describeTool(definition: ToolDefinition): string {
  return `[${RISK_LABEL[definition.risk]}] ${definition.title} - ${definition.summary} ${RISK_CAVEAT[definition.risk]}`;
}

export function toolAnnotations(definition: ToolDefinition): ToolAnnotations {
  return { ...RISK_ANNOTATIONS[definition.risk], ...(definition.annotations ?? {}) };
}

/** Shared wrapper so every tool's failures come back structured, never thrown. */
export function wrapHandler(
  definition: ToolDefinition,
): (input: Record<string, unknown>, ctx: AppContext) => Promise<CallToolResultLike> {
  return async (input, ctx) => {
    try {
      const payload = await definition.handler(input, ctx);
      return toCallToolResult(payload);
    } catch (error) {
      ctx.logger.warn("tool failed", {
        tool: definition.name,
        risk: definition.risk,
        error: error instanceof Error ? error.message : String(error),
      });
      return toErrorResult(error);
    }
  };
}
