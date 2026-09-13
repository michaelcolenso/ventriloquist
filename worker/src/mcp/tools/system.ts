import { z } from "zod";
import { countRows } from "../../storage/snapshots";
import { consecutivePostFailures } from "../../storage/jobs";
import { defineTool } from "../registry";

/**
 * Ops visibility. Not in the spec's tool table, but every failover/cost
 * decision in section 6 is unauditable without it, and it is the first thing
 * an agent should call when another tool reports `no_provider_available`.
 */
export const systemStatusTool = defineTool({
  name: "tt_system_status",
  risk: "GREEN",
  title: "System status",
  summary:
    "Health of every backend (circuit breakers, last latency, last failure), the daily paid-budget state, and accumulation counters (snapshots, watchlist, cohort, jobs, ideas).",
  inputSchema: {
    include_health_probe: z
      .boolean()
      .default(false)
      .describe("Actively probe each provider (costs a call per provider)"),
  },
  handler: async (input, ctx) => {
    const providers = ctx.backends.registry.list();
    const health: Record<string, unknown>[] = [];

    for (const provider of providers) {
      const state = await ctx.backends.health.get(provider.name);
      let probe: boolean | null = null;
      if (input.include_health_probe) {
        try {
          probe = await provider.healthCheck({
            env: ctx.env,
            region: ctx.region,
            now: ctx.now,
            fetch: ctx.fetcher,
            logger: ctx.logger,
          });
        } catch (error) {
          probe = false;
          ctx.logger.warn("health probe threw", {
            provider: provider.name,
            error: String(error),
          });
        }
      }
      health.push({
        provider: provider.name,
        capabilities: provider.capabilities,
        cost_per_call_usd: provider.costPerCallUSD,
        circuit_open_until: state.circuitOpenUntil,
        circuit_open: state.circuitOpenUntil !== null && state.circuitOpenUntil > ctx.now,
        consecutive_failures: state.consecutiveFailures,
        last_latency_ms: state.lastLatencyMs,
        last_success_at: state.lastSuccessAt,
        last_failure_at: state.lastFailureAt,
        last_failure_reason: state.lastFailureReason,
        probe_ok: probe,
      });
    }

    const budget = await ctx.backends.ledger.budgetState(ctx.now);
    const failures = await consecutivePostFailures(ctx.env.DB, ctx.now);

    const [hashtagSnapshots, videoSnapshots, soundSnapshots, watchlistSize, cohortSize, ideas, jobs] =
      await Promise.all([
        countRows(ctx.env.DB, "hashtag_snapshots"),
        countRows(ctx.env.DB, "video_snapshots"),
        countRows(ctx.env.DB, "sound_snapshots"),
        countRows(ctx.env.DB, "watchlist"),
        countRows(ctx.env.DB, "shadow_cohort"),
        countRows(ctx.env.DB, "content_ideas"),
        countRows(ctx.env.DB, "post_jobs"),
      ]);

    const warnings: string[] = [];
    if (cohortSize < 50) {
      warnings.push(`Shadow cohort is ${cohortSize}/50 accounts (spec 12.4 is still open).`);
    }
    if (budget.exceeded) {
      warnings.push(
        `Daily paid budget spent ($${budget.spentUSD.toFixed(4)}/$${budget.budgetUSD}): paid fallback is skipped and only free paths run.`,
      );
    }
    if (failures >= 2) {
      warnings.push(`Posting is halted after ${failures} consecutive failures.`);
    }
    if (!ctx.env.SIGNER_GATEWAY_URL) {
      warnings.push("SIGNER_GATEWAY_URL is unset: the self-hosted path is disabled in this deployment.");
    }

    return {
      summary: `Providers: ${providers.length} configured, ${
        health.filter((row) => row.circuit_open).length
      } circuit-broken. Budget $${budget.spentUSD.toFixed(4)}/$${budget.budgetUSD} used. ${
        hashtagSnapshots + videoSnapshots + soundSnapshots
      } snapshot rows accumulated.`,
      data: {
        now: ctx.now,
        region: ctx.region,
        own_account: `@${ctx.ownHandle()}`,
        providers: health,
        budget,
        accumulation: {
          hashtag_snapshots: hashtagSnapshots,
          video_snapshots: videoSnapshots,
          sound_snapshots: soundSnapshots,
          watchlist: watchlistSize,
          shadow_cohort: cohortSize,
          content_ideas: ideas,
          post_jobs: jobs,
        },
        posting: { consecutive_failures: failures, halted: failures >= 2 },
      },
      warnings: warnings.length ? warnings : undefined,
      meta: { provider: "worker", source: "ventriloquist" },
    };
  },
});
