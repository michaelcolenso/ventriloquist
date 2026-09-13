import type { Capability, ProviderName } from "../types";
import type { Logger } from "../lib/logger";
import { ProviderError, errorMessage } from "../lib/errors";
import { DEFAULT_PROVIDER_TIMEOUT_MS, timeoutSignal, withTimeout } from "../lib/timeout";
import type { HealthStore } from "./health";
import type { Ledger } from "./ledger";
import {
  NoProviderAvailableError,
  type CallContext,
  type CapabilityProvider,
  type ExecutionResult,
  type ProviderEvent,
  type SkippedProvider,
} from "./types";

export interface RegistryDeps {
  providers: CapabilityProvider[];
  health: HealthStore;
  ledger: Ledger;
  logger: Logger;
  /** Hard ceiling per provider attempt; defaults to 15s. */
  timeoutMs?: number;
  /** Fire-and-forget sink; the request path never awaits ledger writes. */
  emit?: (event: ProviderEvent) => void;
}

/**
 * Backend abstraction layer routing policy (spec section 6):
 *
 *   1. providers sorted by costPerCallUSD ascending (self-hosted first)
 *   2. providers with an open breaker are skipped, except one canary probe
 *      every five minutes so recovery is early rather than after the cooldown
 *   3. failures cascade to the next provider and trip the breaker at three
 *      consecutive failures
 *   4. paid providers are skipped once the daily budget is spent, degrading
 *      to free paths only
 */
export class BackendRegistry {
  private readonly providers: CapabilityProvider[];
  private readonly health: HealthStore;
  private readonly ledger: Ledger;
  private readonly logger: Logger;
  private readonly emit: (event: ProviderEvent) => void;
  private readonly timeoutMs: number;

  constructor(deps: RegistryDeps) {
    this.providers = [...deps.providers];
    this.health = deps.health;
    this.ledger = deps.ledger;
    this.logger = deps.logger;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.emit = deps.emit ?? ((event) => void this.ledger.recordSafe(event));
  }

  list(): CapabilityProvider[] {
    return [...this.providers];
  }

  providersFor(capability: Capability): CapabilityProvider[] {
    return this.providers
      .filter((provider) => provider.capabilities.includes(capability))
      .sort((a, b) => a.costPerCallUSD - b.costPerCallUSD || a.name.localeCompare(b.name));
  }

  async execute<T = unknown>(
    capability: Capability,
    params: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<ExecutionResult<T>> {
    const candidates = this.providersFor(capability);
    const skipped: SkippedProvider[] = [];
    const attempts: { provider: ProviderName; error: string }[] = [];
    const attemptChain: ProviderName[] = [];
    let failoverFrom: ProviderName | null = null;

    if (candidates.length === 0) {
      throw new NoProviderAvailableError(capability, [], []);
    }

    const budget = await this.ledger.budgetState(ctx.now);

    for (const provider of candidates) {
      const open = await this.health.isOpen(provider.name, ctx.now);
      let probing = false;
      if (open) {
        probing = await this.health.claimProbe(provider.name, ctx.now);
        if (!probing) {
          skipped.push({ provider: provider.name, reason: "circuit_open" });
          this.emit({
            occurredAt: ctx.now,
            provider: provider.name,
            capability,
            outcome: "skipped_circuit_open",
            latencyMs: null,
            costUsd: 0,
            error: null,
            failoverFrom,
          });
          continue;
        }
      }

      if (provider.costPerCallUSD > 0 && budget.exceeded) {
        skipped.push({ provider: provider.name, reason: "budget_exceeded" });
        this.emit({
          occurredAt: ctx.now,
          provider: provider.name,
          capability,
          outcome: "skipped_budget",
          latencyMs: null,
          costUsd: 0,
          error: `daily budget of $${budget.budgetUSD} spent ($${budget.spentUSD.toFixed(4)})`,
          failoverFrom,
        });
        continue;
      }

      attemptChain.push(provider.name);
      const startedAt = Date.now();
      try {
        const value = (await withTimeout(
          provider.execute(capability, params, {
            ...ctx,
            signal: timeoutSignal(this.timeoutMs, ctx.signal),
          }),
          this.timeoutMs,
          () =>
            new ProviderError(
              provider.name,
              capability,
              `timed out after ${this.timeoutMs}ms`,
              { retryable: true },
            ),
        )) as T;
        const latencyMs = Date.now() - startedAt;
        await this.health.recordSuccess(provider.name, latencyMs, ctx.now);
        this.emit({
          occurredAt: ctx.now,
          provider: provider.name,
          capability,
          outcome: "success",
          latencyMs,
          costUsd: provider.costPerCallUSD,
          error: null,
          failoverFrom,
        });
        if (attemptChain.length > 1) {
          this.logger.warn("provider failover succeeded", {
            capability,
            provider: provider.name,
            attemptChain,
          });
        }
        return {
          value,
          provider: provider.name,
          source: provider.source,
          attemptChain,
          failover: attemptChain.length > 1,
          latencyMs,
          costUsd: provider.costPerCallUSD,
        };
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const message = errorMessage(error);
        const countsTowardBreaker =
          error instanceof ProviderError ? error.countsTowardBreaker : true;
        const { tripped } = await this.health.recordFailure(provider.name, ctx.now, message, {
          countsTowardBreaker,
        });
        attempts.push({ provider: provider.name, error: message });
        this.emit({
          occurredAt: ctx.now,
          provider: provider.name,
          capability,
          outcome: "failure",
          latencyMs,
          costUsd: 0,
          error: message,
          failoverFrom,
        });
        this.logger.warn("provider failed", {
          capability,
          provider: provider.name,
          tripped,
          probing,
          error: message,
        });
        failoverFrom = provider.name;
      }
    }

    throw new NoProviderAvailableError(capability, skipped, attempts);
  }
}
