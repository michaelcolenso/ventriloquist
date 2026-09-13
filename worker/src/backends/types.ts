import type { Env } from "../env";
import type { Capability, ProviderName, SourceName } from "../types";
import type { Logger } from "../lib/logger";

export interface ProviderHealth {
  consecutiveFailures: number;
  circuitOpenUntil: number | null;
  /** When the breaker tripped; gates how soon a canary probe may run. */
  circuitOpenedAt: number | null;
  lastLatencyMs: number;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
  lastSuccessAt: number | null;
  lastProbeAt: number | null;
}

export const EMPTY_HEALTH: ProviderHealth = {
  consecutiveFailures: 0,
  circuitOpenUntil: null,
  circuitOpenedAt: null,
  lastLatencyMs: 0,
  lastFailureAt: null,
  lastFailureReason: null,
  lastSuccessAt: null,
  lastProbeAt: null,
};

export interface CallContext {
  env: Env;
  region: string;
  now: number;
  fetch: typeof fetch;
  logger: Logger;
  signal?: AbortSignal;
}

export interface CapabilityProvider {
  readonly name: ProviderName;
  readonly source: SourceName;
  readonly capabilities: readonly Capability[];
  /** 0 for self-hosted and public-endpoint paths; >0 for rented backends. */
  readonly costPerCallUSD: number;
  healthCheck(ctx: CallContext): Promise<boolean>;
  execute(
    capability: Capability,
    params: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<unknown>;
}

export interface ProviderEvent {
  occurredAt: number;
  provider: ProviderName;
  capability: Capability;
  outcome: "success" | "failure" | "skipped_circuit_open" | "skipped_budget";
  latencyMs: number | null;
  costUsd: number;
  error: string | null;
  failoverFrom: ProviderName | null;
}

export interface ExecutionResult<T = unknown> {
  value: T;
  provider: ProviderName;
  source: SourceName;
  attemptChain: ProviderName[];
  failover: boolean;
  latencyMs: number;
  costUsd: number;
}

export interface SkippedProvider {
  provider: ProviderName;
  reason: "circuit_open" | "budget_exceeded";
}

export class NoProviderAvailableError extends Error {
  readonly capability: Capability;
  readonly skipped: SkippedProvider[];
  readonly attempts: { provider: ProviderName; error: string }[];

  constructor(
    capability: Capability,
    skipped: SkippedProvider[],
    attempts: { provider: ProviderName; error: string }[],
  ) {
    const detail = attempts.length
      ? attempts.map((a) => `${a.provider}: ${a.error}`).join("; ")
      : "no provider registered";
    super(`all providers for "${capability}" are unavailable (${detail})`);
    this.name = "NoProviderAvailableError";
    this.capability = capability;
    this.skipped = skipped;
    this.attempts = attempts;
  }
}
