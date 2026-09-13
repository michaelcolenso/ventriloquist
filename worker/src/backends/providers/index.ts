import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { boundFetch } from "../../lib/fetch";
import type { CapabilityProvider, ProviderEvent } from "../types";
import { HealthStore } from "../health";
import { Ledger } from "../ledger";
import { BackendRegistry } from "../registry";
import { SignerClient } from "../signerClient";
import { CreativeCenterProvider } from "./creativeCenter";
import { ScrapeBadgerProvider } from "./scrapebadger";
import { SignerProvider } from "./signer";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "../../lib/timeout";

export const DEFAULT_PAID_COST_USD = 0.001;

function numberFrom(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Provider registry for one request.
 *
 * Order matters only in that the router sorts by cost; the wiring here is
 * about which paths are configured at all. A missing signer URL or vendor key
 * simply removes that provider from the rotation, which keeps local
 * development and partial deployments working.
 */
export function buildProviders(env: Env, fetcher: typeof fetch, logger: Logger): CapabilityProvider[] {
  const providers: CapabilityProvider[] = [];

  if (env.SIGNER_GATEWAY_URL) {
    providers.push(
      new SignerProvider(
        new SignerClient(env.SIGNER_GATEWAY_URL, env.SIGNER_GATEWAY_TOKEN ?? "", fetcher),
      ),
    );
  } else {
    logger.warn("SIGNER_GATEWAY_URL is not set: self-hosted path disabled");
  }

  providers.push(new CreativeCenterProvider(env.CREATIVE_CENTER_BASE_URL || undefined));

  const paidCost = numberFrom(env.SCRAPEBADGER_USD_PER_CALL, DEFAULT_PAID_COST_USD);
  if (env.SCRAPEBADGER_API_KEY) {
    providers.push(
      new ScrapeBadgerProvider({
        name: "scrapebadger",
        source: "scrapebadger",
        apiKey: env.SCRAPEBADGER_API_KEY,
        costPerCallUSD: paidCost,
        ...(env.SCRAPEBADGER_BASE_URL ? { baseUrl: env.SCRAPEBADGER_BASE_URL } : {}),
      }),
    );
  } else {
    logger.warn("SCRAPEBADGER_API_KEY is not set: paid fallback disabled");
  }

  if (env.SCRAPECREATORS_API_KEY) {
    // Emergency fallback. Only enabled when a key is present; verify the
    // vendor's endpoint paths against their docs before relying on it.
    providers.push(
      new ScrapeBadgerProvider({
        name: "scrapecreators",
        source: "scrapecreators",
        apiKey: env.SCRAPECREATORS_API_KEY,
        costPerCallUSD: paidCost * 2,
        baseUrl: "https://api.scrapecreators.com/v1/tiktok",
        apiKeyHeader: "x-api-key",
      }),
    );
  }

  return providers;
}

export interface BackendBundle {
  registry: BackendRegistry;
  health: HealthStore;
  ledger: Ledger;
}

export function buildBackends(
  env: Env,
  logger: Logger,
  options: { fetcher?: typeof fetch; emit?: (event: ProviderEvent) => void } = {},
): BackendBundle {
  const health = new HealthStore(env.KV, {
    failureThreshold: numberFrom(env.PROVIDER_FAILURE_THRESHOLD, 3),
    cooldownSeconds: numberFrom(env.PROVIDER_COOLDOWN_SECONDS, 900),
  });
  const ledger = new Ledger(env.DB, env.KV, {
    dailyBudgetUSD: numberFrom(env.DAILY_PAID_BUDGET_USD, 3),
  });
  const registry = new BackendRegistry({
    providers: buildProviders(env, options.fetcher ?? boundFetch(), logger),
    health,
    ledger,
    logger,
    timeoutMs: numberFrom(env.PROVIDER_TIMEOUT_MS, DEFAULT_PROVIDER_TIMEOUT_MS),
    ...(options.emit ? { emit: options.emit } : {}),
  });
  return { registry, health, ledger };
}

export { CreativeCenterProvider, ScrapeBadgerProvider, SignerProvider };
