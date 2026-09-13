# Ventriloquist

An unofficial TikTok MCP facade. No official TikTok API, no OAuth, no app
audit. Every read has two independent backends with automatic failover, every
response is snapshotted into D1, and every tool advertises its own risk tier.

The full technical specification is in
[`ventriloquist-tiktok-mcp-spec.md`](./ventriloquist-tiktok-mcp-spec.md).

## What is built

| Piece | Status | Where |
|---|---|---|
| MCP facade (Streamable HTTP, 20 `tt_*` tools, risk tiers in descriptions) | working | `worker/` |
| Backend abstraction: provider registry, health probes, circuit breakers, canary recovery, cost ledger, daily budget | working, tested | `worker/src/backends/` |
| D1 accumulation schema + snapshot writers + 90-day rollup compaction | working | `worker/migrations/`, `worker/src/storage/` |
| Velocity engine: velocity, acceleration, lifecycle stage, saturation, actionability, breakout detection | working, tested | `worker/src/velocity/` |
| Comment mining + sentiment (deterministic clustering, persisted backlog) | working, tested | `worker/src/velocity/ideas.ts` |
| 7 cron jobs (watchlist, Creative Center, cohort, own account, Studio, session, signer canary) | implemented | `worker/src/cron/` |
| Queued posting path (cap, spacing, R2 check, halt-on-failure, callbacks) | working | `worker/src/mcp/tools/posting.ts`, `worker/src/jobs/` |
| Self-hosted signer gateway (Puppeteer pool, dual strategy, mock mode) | working (mock verified; live path needs real Chromium + TikTok reachability) | `signer/` |
| Playwright posting worker (session custody, pacing, Studio scrape hook) | implemented (upload flow unverified against live Studio) | `vps-agent/` |
| End-to-end smoke test through the MCP transport, incl. kill-the-signer failover | passing, 40/40 | `scripts/smoke.mjs` |

Not built: the pure-Python signer prototype, Whisper transcription on the VPS,
and the 50-account cohort curation pass (see
[`docs/decisions.md`](./docs/decisions.md)).

## Quickstart

```bash
pnpm install
pnpm migrate:local
pnpm smoke
```

`pnpm smoke` runs the whole pipeline offline: it boots the signer gateway in
mock mode plus a mock vendor, boots the facade on local D1/KV/R2/Queues, and
drives the real MCP endpoint. Among the 40 checks it kills the signer to prove
the paid fallback takes over, trips the circuit breaker, and confirms the
velocity engine classifies an accelerating hashtag as `GROWTH`.

Driving it by hand:

```bash
MCP_AUTH_TOKEN=secret pnpm dev          # http://127.0.0.1:8787/mcp
curl -s localhost:8787/ | jq '.tools[] | {name, risk}'
```

## Tool surface

Every description begins with `[TIER · label]` and ends with the tier's caveat,
so a calling agent can reason about what it is touching.

| Trend intelligence (GREEN) | Account & video (GREEN) | Comments (GREEN) | Own account | Publishing |
|---|---|---|---|---|
| `tt_trending_hashtags` | `tt_profile` | `tt_video_comments` | `tt_own_video_metrics` (GREEN) | `tt_queue_post` (RED) |
| `tt_trending_sounds` | `tt_video_detail` | `tt_mine_comment_ideas` | `tt_own_deep_analytics` (AMBER) | `tt_job_status` (GREEN) |
| `tt_hashtag_momentum` | `tt_shadow_cohort` | `tt_comment_sentiment` | `tt_what_worked` (GREEN) | `tt_render_and_post` (RED) |
| `tt_emerging_in_niche` | `tt_compare_accounts` | | | |
| `tt_search_videos` | | | | |
| `tt_sound_lifecycle` | | | | |

`tt_system_status` (GREEN) reports provider health, breakers, budget and
accumulation counters. It is an addition to the spec's table, documented in
[`docs/decisions.md`](./docs/decisions.md).

## How a read flows

```
agent -> /mcp -> tool registry (risk tier + zod schema)
              -> backend router: candidates sorted by cost, breaker-aware
                   signer (owned, $0) -> Creative Center (public, $0) -> ScrapeBadger (paid)
              -> normalize into one domain model
              -> respond now; snapshot to D1 via ctx.waitUntil
              -> ledger row per attempt (success, failure, skipped)
      later -> velocity engine reads the accumulated snapshots
```

Design notes that matter in practice:

- **Failures are classified.** A bad video id is recorded but does not trip a
  breaker; only real provider faults count toward the three-strike threshold.
- **Canary probes.** While a breaker is open, one trial call is allowed every
  five minutes so recovery is early rather than after the full cooldown.
- **Budget degrades gracefully.** Once the daily paid budget is spent, paid
  providers are skipped and only free paths run; `tt_system_status` says so.
- **Posting is structurally throttled.** The cap and spacing are enforced before
  the job reaches the queue, and two consecutive failures halt posting.

## Repository layout

```
worker/      Cloudflare Worker: MCP server, routing, D1 schema, crons, queue consumer
signer/      self-hosted signer gateway (Puppeteer + TikTok's web SDK), with MOCK=1 fixtures
vps-agent/   Playwright posting worker + AMBER Studio scrape + session custody
scripts/     smoke.mjs (end-to-end), seed-cohort.mjs
docs/        decisions.md (spec decisions + deviations), runbook.md (deploy + ops)
```

## Spec phases

Phase 0 (smoke test / signer plumbing) and Phase 1 (read facade) are complete in
code and verified offline. Phase 2 (velocity engine) is implemented and covered
by tests plus the smoke run. Phase 3 (comment mining) is implemented. Phase 4
(posting) is implemented but unverified against live Studio, and Phases 5-6
(AMBER deep analytics, productization) are scaffolds.

Becoming a live deployment needs three things that cannot live in this
repository: a VPS with Chromium, a real posting session, and vendor API keys.
See [`docs/runbook.md`](./docs/runbook.md).

## Risks, in the open

- Signing breaks periodically. Budget the 2-4 hours/month from the spec; the
  gateway's `strategy` field tells you when it has degraded to the in-page path.
- RED posting violates TikTok's ToS. The mitigation here is low volume, human
  pacing, a dedicated session, and halting on the second consecutive failure -
  not immunity.
- Every scraper and vendor path is copyrighted third-party surface. This is a
  personal research tool, not something to resell without counsel.
