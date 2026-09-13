import type { ProviderName } from "../types";
import type { ProviderHealth } from "./types";
import { EMPTY_HEALTH } from "./types";

export interface HealthOptions {
  failureThreshold: number;
  cooldownSeconds: number;
  probeIntervalSeconds?: number;
}

const DEFAULT_PROBE_INTERVAL_SECONDS = 300;

/**
 * Circuit-breaker state lives in KV (spec 2.1: "signer health state,
 * circuit-breaker flags"). Losing a KV write is survivable: the breaker fails
 * closed toward trying the provider again, which is the safe direction for a
 * read path.
 */
export class HealthStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly options: HealthOptions,
  ) {}

  private key(provider: ProviderName): string {
    return `health:${provider}`;
  }

  async get(provider: ProviderName): Promise<ProviderHealth> {
    const stored = await this.kv.get<Partial<ProviderHealth>>(this.key(provider), "json");
    return { ...EMPTY_HEALTH, ...(stored ?? {}) };
  }

  async isOpen(provider: ProviderName, now: number): Promise<boolean> {
    const health = await this.get(provider);
    return health.circuitOpenUntil !== null && health.circuitOpenUntil > now;
  }

  /**
   * Canary probes for early recovery (spec 6, routing policy step 3): while a
   * breaker is open, allow one trial call every `probeIntervalSeconds`.
   */
  async claimProbe(provider: ProviderName, now: number): Promise<boolean> {
    const health = await this.get(provider);
    if (health.circuitOpenUntil === null || health.circuitOpenUntil <= now) return false;
    const interval = this.options.probeIntervalSeconds ?? DEFAULT_PROBE_INTERVAL_SECONDS;
    // A canary probe is allowed only after the breaker has been open for a full
    // probe interval, so tripping is not immediately undone by the next call.
    const openedAt = health.circuitOpenedAt ?? 0;
    if (now - openedAt < interval) return false;
    if (health.lastProbeAt !== null && now - health.lastProbeAt < interval) return false;
    await this.put(provider, { ...health, lastProbeAt: now });
    return true;
  }

  async recordSuccess(provider: ProviderName, latencyMs: number, now: number): Promise<void> {
    await this.put(provider, {
      ...EMPTY_HEALTH,
      lastLatencyMs: latencyMs,
      lastSuccessAt: now,
      lastProbeAt: null,
    });
  }

  async recordFailure(
    provider: ProviderName,
    now: number,
    reason: string,
    options: { countsTowardBreaker: boolean },
  ): Promise<{ tripped: boolean; health: ProviderHealth }> {
    const health = await this.get(provider);
    if (!options.countsTowardBreaker) {
      const next = { ...health, lastFailureAt: now, lastFailureReason: reason };
      await this.put(provider, next);
      return { tripped: false, health: next };
    }

    const consecutiveFailures = health.consecutiveFailures + 1;
    const tripped = consecutiveFailures >= this.options.failureThreshold;
    const next: ProviderHealth = {
      ...health,
      consecutiveFailures,
      lastFailureAt: now,
      lastFailureReason: reason,
      circuitOpenUntil: tripped ? now + this.options.cooldownSeconds : health.circuitOpenUntil,
      circuitOpenedAt: tripped ? now : health.circuitOpenedAt,
      lastProbeAt: tripped ? null : health.lastProbeAt,
    };
    await this.put(provider, next);
    return { tripped, health: next };
  }

  async reset(provider: ProviderName): Promise<void> {
    await this.kv.delete(this.key(provider));
  }

  private async put(provider: ProviderName, health: ProviderHealth): Promise<void> {
    await this.kv.put(this.key(provider), JSON.stringify(health));
  }
}
