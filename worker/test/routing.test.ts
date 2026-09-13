import { describe, expect, it, vi } from "vitest";
import { BackendRegistry } from "../src/backends/registry";
import { HealthStore } from "../src/backends/health";
import { Ledger } from "../src/backends/ledger";
import { ProviderError } from "../src/lib/errors";
import { createLogger } from "../src/lib/logger";
import { NoProviderAvailableError } from "../src/backends/types";
import type { CallContext, CapabilityProvider, ProviderEvent } from "../src/backends/types";
import type { Capability, ProviderName } from "../src/types";
import { fakeD1, fakeKV } from "./support/fakes";

const NOW = 1_800_000_000;

function provider(
  name: ProviderName,
  cost: number,
  capabilities: Capability[],
  behaviour: () => Promise<unknown>,
): CapabilityProvider {
  return {
    name,
    source: name,
    capabilities,
    costPerCallUSD: cost,
    async healthCheck() {
      return true;
    },
    execute: behaviour,
  };
}

function harness(options: {
  providers: CapabilityProvider[];
  spend?: number;
  budget?: number;
  kv?: KVNamespace;
  timeoutMs?: number;
}) {
  const events: ProviderEvent[] = [];
  const kv = options.kv ?? fakeKV();
  const db = fakeD1((sql) => {
    if (sql.includes("SUM(cost_usd)")) return { first: { spend: options.spend ?? 0 } };
    return {};
  });
  const health = new HealthStore(kv, { failureThreshold: 3, cooldownSeconds: 900 });
  const ledger = new Ledger(db, kv, { dailyBudgetUSD: options.budget ?? 3 });
  const registry = new BackendRegistry({
    providers: options.providers,
    health,
    ledger,
    logger: createLogger("error"),
    timeoutMs: options.timeoutMs ?? 1_000,
    emit: (event) => events.push(event),
  });
  const ctx: CallContext = {
    env: {} as never,
    region: "US",
    now: NOW,
    fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    logger: createLogger("error"),
  };
  return { registry, health, ledger, ctx, events };
}

describe("BackendRegistry routing policy", () => {
  it("prefers the self-hosted (free) provider and never touches paid on success", async () => {
    const paid = vi.fn(async () => "paid");
    const free = vi.fn(async () => "free");
    const { registry, ctx, events } = harness({
      providers: [
        provider("scrapebadger", 0.001, ["search"], paid),
        provider("signer", 0, ["search"], free),
      ],
    });

    const result = await registry.execute("search", {}, ctx);
    expect(result.value).toBe("free");
    expect(result.provider).toBe("signer");
    expect(paid).not.toHaveBeenCalled();
    expect(events.some((event) => event.outcome === "success" && event.costUsd === 0)).toBe(true);
  });

  it("cascades to the paid fallback when the signer fails and marks the failover", async () => {
    const { registry, ctx, events } = harness({
      providers: [
        provider("signer", 0, ["search"], async () => {
          throw new ProviderError("signer", "search", "gateway unreachable", { retryable: true });
        }),
        provider("scrapebadger", 0.001, ["search"], async () => "paid-result"),
      ],
    });

    const result = await registry.execute("search", {}, ctx);
    expect(result.value).toBe("paid-result");
    expect(result.failover).toBe(true);
    expect(result.attemptChain).toEqual(["signer", "scrapebadger"]);
    const paidEvent = events.find((event) => event.provider === "scrapebadger");
    expect(paidEvent?.failoverFrom).toBe("signer");
    expect(paidEvent?.costUsd).toBe(0.001);
  });

  it("trips the breaker after three consecutive failures and skips the provider", async () => {
    const failing = vi.fn(async () => {
      throw new ProviderError("signer", "search", "boom", { retryable: true });
    });
    const { registry, ctx, health } = harness({
      providers: [
        provider("signer", 0, ["search"], failing),
        provider("scrapebadger", 0.001, ["search"], async () => "paid"),
      ],
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await registry.execute("search", {}, ctx);
    }
    const state = await health.get("signer");
    expect(state.consecutiveFailures).toBe(3);
    expect(state.circuitOpenUntil).toBe(NOW + 900);

    const callsBefore = failing.mock.calls.length;
    const result = await registry.execute("search", {}, ctx);
    expect(result.provider).toBe("scrapebadger");
    expect(failing.mock.calls.length).toBe(callsBefore);
  });

  it("does not count caller-caused failures toward the breaker", async () => {
    const { registry, ctx, health } = harness({
      providers: [
        provider("signer", 0, ["search"], async () => {
          throw new ProviderError("signer", "search", "missing required parameter", {
            retryable: false,
            countsTowardBreaker: false,
          });
        }),
        provider("scrapebadger", 0.001, ["search"], async () => "paid"),
      ],
    });
    await registry.execute("search", {}, ctx);
    const state = await health.get("signer");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.circuitOpenUntil).toBeNull();
  });

  it("degrades to free providers once the daily budget is spent", async () => {
    const paid = vi.fn(async () => "paid");
    const { registry, ctx, events } = harness({
      spend: 3,
      budget: 3,
      providers: [
        provider("signer", 0, ["search"], async () => {
          throw new ProviderError("signer", "search", "down", { retryable: true });
        }),
        provider("scrapebadger", 0.001, ["search"], paid),
      ],
    });

    await expect(registry.execute("search", {}, ctx)).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(paid).not.toHaveBeenCalled();
    expect(events.some((event) => event.outcome === "skipped_budget")).toBe(true);
  });

  it("allows a single canary probe while the breaker is open, then resets on success", async () => {
    const kv = fakeKV({
      "health:signer": JSON.stringify({
        consecutiveFailures: 3,
        circuitOpenUntil: NOW + 900,
        circuitOpenedAt: NOW - 600,
        lastLatencyMs: 0,
        lastFailureAt: NOW - 60,
        lastFailureReason: "boom",
        lastSuccessAt: null,
        lastProbeAt: null,
      }),
    });
    const probe = vi.fn(async () => "recovered");
    const { registry, ctx, health } = harness({
      kv,
      providers: [provider("signer", 0, ["search"], probe)],
    });

    const result = await registry.execute("search", {}, ctx);
    expect(result.provider).toBe("signer");
    expect(probe).toHaveBeenCalledTimes(1);
    const state = await health.get("signer");
    expect(state.circuitOpenUntil).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
  });

  it("fails clearly when no provider supports a capability", async () => {
    const { registry, ctx } = harness({
      providers: [provider("signer", 0, ["search"], async () => "x")],
    });
    await expect(registry.execute("download", {}, ctx)).rejects.toBeInstanceOf(
      NoProviderAvailableError,
    );
  });

  it("bounds a hanging provider and cascades instead of stalling the caller", async () => {
    const { registry, ctx, events } = harness({
      timeoutMs: 25,
      providers: [
        provider("signer", 0, ["search"], () => new Promise(() => {})),
        provider("scrapebadger", 0.001, ["search"], async () => "paid"),
      ],
    });

    const result = await registry.execute("search", {}, ctx);
    expect(result.value).toBe("paid");
    expect(result.attemptChain).toEqual(["signer", "scrapebadger"]);
    const failure = events.find(
      (event) => event.provider === "signer" && event.outcome === "failure",
    );
    expect(failure?.error).toMatch(/timed out after 25ms/);
  });
});
