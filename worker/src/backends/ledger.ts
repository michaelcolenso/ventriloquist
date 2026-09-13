import type { ProviderEvent } from "./types";
import type { ProviderName } from "../types";
import { startOfUtcDay, utcDay } from "../lib/time";
import { DAY } from "../lib/time";

export interface LedgerOptions {
  dailyBudgetUSD: number;
}

export interface BudgetState {
  day: string;
  budgetUSD: number;
  spentUSD: number;
  remainingUSD: number;
  exceeded: boolean;
}

export interface ProviderReliabilityRow {
  provider: ProviderName;
  capability: string;
  calls: number;
  successes: number;
  failures: number;
  failoversReceived: number;
  spendUSD: number;
  avgLatencyMs: number | null;
}

/**
 * Cost ledger + daily paid budget (spec section 6).
 *
 * Every provider call - free or paid - lands in `provider_events`, which is
 * what makes the monthly "is the signer worth its maintenance hours?" report
 * possible. The budget ceiling is stored in KV so it can be tightened without
 * a deploy.
 */
export class Ledger {
  constructor(
    private readonly db: D1Database,
    private readonly kv: KVNamespace,
    private readonly options: LedgerOptions,
  ) {}

  async record(event: ProviderEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_events
           (occurred_at, provider, capability, outcome, latency_ms, cost_usd, error, failover_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.occurredAt,
        event.provider,
        event.capability,
        event.outcome,
        event.latencyMs,
        event.costUsd,
        event.error,
        event.failoverFrom,
      )
      .run();
  }

  async recordSafe(event: ProviderEvent): Promise<void> {
    try {
      await this.record(event);
    } catch {
      // Ledger writes must never break a read path.
    }
  }

  async dailySpendUSD(now: number): Promise<number> {
    const start = startOfUtcDay(now);
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS spend
           FROM provider_events
          WHERE occurred_at >= ? AND occurred_at < ?`,
      )
      .bind(start, start + DAY)
      .first<{ spend: number | null }>();
    return row?.spend ?? 0;
  }

  async dailyBudgetUSD(): Promise<number> {
    const override = await this.kv.get("budget:daily_usd");
    if (override !== null) {
      const parsed = Number(override);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return this.options.dailyBudgetUSD;
  }

  async budgetState(now: number): Promise<BudgetState> {
    const [budgetUSD, spentUSD] = await Promise.all([
      this.dailyBudgetUSD(),
      this.dailySpendUSD(now),
    ]);
    const remainingUSD = Math.max(0, budgetUSD - spentUSD);
    return {
      day: utcDay(now),
      budgetUSD,
      spentUSD,
      remainingUSD,
      exceeded: spentUSD >= budgetUSD,
    };
  }

  async reliability(sinceEpoch: number): Promise<ProviderReliabilityRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT provider,
                capability,
                COUNT(*)                                                        AS calls,
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)             AS successes,
                SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END)             AS failures,
                SUM(CASE WHEN failover_from IS NOT NULL THEN 1 ELSE 0 END)       AS failoversReceived,
                COALESCE(SUM(cost_usd), 0)                                       AS spend_usd,
                AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END)        AS avg_latency_ms
           FROM provider_events
          WHERE occurred_at >= ?
          GROUP BY provider, capability
          ORDER BY provider, capability`,
      )
      .bind(sinceEpoch)
      .all<{
        provider: ProviderName;
        capability: string;
        calls: number;
        successes: number;
        failures: number;
        failoversReceived: number;
        spend_usd: number;
        avg_latency_ms: number | null;
      }>();

    return (results ?? []).map((row) => ({
      provider: row.provider,
      capability: row.capability,
      calls: row.calls,
      successes: row.successes,
      failures: row.failures,
      failoversReceived: row.failoversReceived,
      spendUSD: row.spend_usd,
      avgLatencyMs: row.avg_latency_ms,
    }));
  }
}
