import { NoProviderAvailableError } from "../backends/types";
import { ProviderError, VentriloquistError, errorMessage } from "../lib/errors";

export interface ToolPayload {
  /** One-line, human-readable answer to "what came back?". */
  summary: string;
  data?: unknown;
  warnings?: string[];
  meta?: Record<string, unknown>;
}

export interface CallToolResultLike {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function toCallToolResult(payload: ToolPayload): CallToolResultLike {
  const lines = [payload.summary];
  if (payload.warnings?.length) {
    lines.push(...payload.warnings.map((warning) => `⚠ ${warning}`));
  }
  if (payload.meta && Object.keys(payload.meta).length > 0) {
    lines.push(`meta: ${JSON.stringify(payload.meta)}`);
  }
  if (payload.data !== undefined) {
    lines.push("", JSON.stringify(payload.data, null, 2));
  }

  const result: CallToolResultLike = {
    content: [{ type: "text", text: lines.join("\n") }],
  };
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    result.structuredContent = payload.data as Record<string, unknown>;
  }
  return result;
}

export function toErrorResult(error: unknown): CallToolResultLike {
  const detail = describeError(error);
  return {
    content: [{ type: "text", text: `error ${detail.code}: ${detail.message}` }],
    structuredContent: { error: detail },
    isError: true,
  };
}

export function describeError(error: unknown): {
  code: string;
  message: string;
  hint?: string;
  attempts?: { provider: string; error: string }[];
  skipped?: { provider: string; reason: string }[];
} {
  if (error instanceof NoProviderAvailableError) {
    return {
      code: "no_provider_available",
      message: error.message,
      hint:
        "Every backend for this capability failed or is circuit-broken. Check tt_system_status, then the signer gateway and the paid fallback key.",
      attempts: error.attempts.map((attempt) => ({
        provider: attempt.provider,
        error: attempt.error,
      })),
      skipped: error.skipped.map((skip) => ({ provider: skip.provider, reason: skip.reason })),
    };
  }
  if (error instanceof ProviderError) {
    return {
      code: `provider_${error.provider}`,
      message: error.message,
      hint: error.retryable ? "Retryable backend failure." : "Request-level failure: fix the input.",
    };
  }
  if (error instanceof VentriloquistError) {
    return { code: error.code, message: error.message };
  }
  return { code: "internal_error", message: errorMessage(error) };
}
