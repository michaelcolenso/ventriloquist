import { ProviderError } from "../lib/errors";
import type { Capability } from "../types";

export function requireString(
  provider: string,
  capability: Capability,
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new ProviderError(provider, capability, `missing required parameter "${key}"`, {
    retryable: false,
    countsTowardBreaker: false,
  });
}

export function optionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function optionalNumber(
  params: Record<string, unknown>,
  key: string,
  fallback?: number,
): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

export function optionalBoolean(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = params[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function requireStringArray(
  provider: string,
  capability: Capability,
  params: Record<string, unknown>,
  key: string,
): string[] {
  const value = params[key];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as string[];
  }
  throw new ProviderError(provider, capability, `missing required string array "${key}"`, {
    retryable: false,
    countsTowardBreaker: false,
  });
}
