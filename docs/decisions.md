# Decisions and deviations

The spec left four open decisions (section 12). All four are resolved here,
with the reasoning and the cost of being wrong.

## 1. Signer implementation: Puppeteer + TikTok's own web SDK

Implemented in `signer/`. A pool of warmed Chromium pages loads `tiktok.com`,
where TikTok's own SDK lives, and `/sign` returns a signed URL.

**Deviation worth knowing:** the gateway tries two strategies in order.

1. `signed` - call whatever signing global the page exposes
   (`byted_acrawler.frontierSign` / `.sign`), append the returned params plus
   `msToken`, and hand back a URL any HTTP client can fetch.
2. `in_page` - if no callable global exists (TikTok renamed or removed it),
   make the request from inside the warmed page instead and return the body.

Strategy 2 means a signing rotation degrades to a slower path instead of an
outage, which is what makes the "2-4 hours/month of signer maintenance" line in
the spec survivable. The response says which strategy ran, so the ledger shows
when strategy 1 stops working.

The pure-Python signer prototype the spec recommends for Phase 2 downtime is
not started. With no paid vendor key provisioned yet, this is the largest
remaining availability risk: a long signer outage is a read outage.

## 2. Paid fallback vendor: ScrapeBadger primary, ScrapeCreators emergency

`worker/src/backends/providers/scrapebadger.ts` implements the actual vendor
contract: endpoint paths, parameters and response fields were taken from
ScrapeBadger's published OpenAPI document
(`docs.scrapebadger.com/openapi-tiktok.json`, fetched 2026-09-13), and
`worker/test/scrapebadger-contract.test.ts` pins those shapes.

**Current deployment:** no vendor key is provisioned yet, so the paid providers
are disabled by configuration and every live read depends on the signer plus
the free Creative Center path. `tt_system_status` reports this explicitly. The
failover chain is exercised end to end by `pnpm smoke` against a mock vendor;
before relying on the paid path in production, add the key and repeat the
contract test against a live response.

ScrapeCreators is wired through the same adapter with a different base URL and
only activates when `SCRAPECREATORS_API_KEY` is set. **Unverified:** its
endpoint paths and response shapes have not been checked against that vendor's
docs, because it is the emergency path. Verify before relying on it.

Credit cost: 5 credits per call at roughly $0.0002/credit is the assumption
behind the default `SCRAPEBADGER_USD_PER_CALL=0.001`. Adjust it to the real
rate; the cost ledger and daily budget are exact once the number is right.

## 3. MCP transport: Streamable HTTP on Workers, stateless

`/mcp` uses `WebStandardStreamableHTTPServerTransport` with
`sessionIdGenerator: undefined` and JSON responses. Each request builds its own
server, which is the supported stateless pattern and keeps Workers isolates
from holding cross-request state. `MCP_AUTH_TOKEN` gates the endpoint when set.

## 4. Shadow cohort seed list: partially seeded

The 20 niche hashtags are seeded in `migrations/0002_seed_cohort.sql`. The 50
accounts are **not** seeded: choosing them is the curation pass the spec calls
for, and inventing 50 handles would produce a cohort that quietly measures
nothing. `tt_system_status` and `tt_shadow_cohort` both report the gap against
50, and `scripts/seed-cohort.mjs` (or `POST /admin/cohort`) loads the curated
list once it exists.

## Deviations from the spec's schema and tool surface

The spec presents its schema as "core tables", so these additions support
behaviour the spec requires elsewhere:

| Addition | Why |
|---|---|
| `provider_events` | Section 6 requires every failover logged to D1 so the monthly signer-reliability-vs-spend report exists. The ledger is derived from this table. |
| `own_video_analytics` | Section 2.1 has Studio analytics (watch time, traffic sources, retention) landing in D1; there was no table for it. |
| `transcripts` | Section 4.2 promises a lazy transcript on `tt_video_detail`. |
| `idea_evidence` | Dedupe for comment mining: a repeating comment must not inflate demand scores on every run. |
| `daily_rollups` | The risk register's snapshot compaction plan for data older than 90 days. |
| `post_jobs.kind`, `render_spec`, `created_at`, `updated_at`, `attempts` | `tt_render_and_post` needs a render job kind and a durable render spec. |
| `sound_snapshots.user_count` | Trending songs report creator counts, not video counts. |
| `tt_system_status` | Not in section 4, but every failover and budget decision is unauditable without it. GREEN, read-only. |

Two deliberate choices:

- **`tt_render_and_post` does not call an HTTP render service.** The
  nobodynamed-video pipeline is a CLI (`nbn`), not a server. The Worker
  enqueues a render job and the VPS worker shells out to `RENDER_COMMAND`
  (default `uv run nbn render --story {story} --out {out}`). If that pipeline
  grows an HTTP API, only `vps-agent/src/index.ts` changes.
- **Whisper transcription is not wired.** The Worker asks the signer path for
  TikTok's own caption track and caches it in `transcripts`. The Whisper
  fallback needs a download + transcribe step on the VPS, and the tool says so
  explicitly instead of implying coverage.

## Operational additions made during the live-readiness pass

- **Admin auth fails closed.** `/admin/*` requires `ADMIN_TOKEN` and
  `/admin/job-callback` requires `FACADE_CALLBACK_TOKEN`; an unset token denies
  the route instead of exposing budget, cohort, watchlist and breaker controls.
- **RED dispatch is idempotent.** The VPS records every claimed `job_id` on
  disk and replays the stored outcome, so a Cloudflare Queues retry cannot post
  the same video twice. A claim older than 30 minutes is treated as a crashed
  run and may be retried.
- **Rendered artifacts land in R2.** The VPS uploads `render_and_post` output
  through scoped S3 credentials and reports `video_r2_key` in the callback;
  queued posts download the same way, with `R2_PUBLIC_BASE` as a read fallback.
- **Alerts go to Telegram.** Posting halt, signer breaker trips, stale or
  unreadable posting sessions, failed Studio scrapes and failed job callbacks
  raise a Telegram message when the bot token and chat id are configured.
- **Backups.** A scheduled GitHub Actions workflow exports D1 to R2; a restore
  into a scratch database is part of the go-live checklist.
