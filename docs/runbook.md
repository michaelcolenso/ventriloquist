# Runbook

## Local development (no Chromium, no TikTok, no spend)

```bash
pnpm install
pnpm migrate:local          # apply D1 migrations to the local database
pnpm smoke                  # boot mock signer + worker, drive the real MCP endpoint
```

`pnpm smoke` starts two mock processes (the signer gateway on `:8788`, the
vendor/Creative-Center mock on `:8789`), boots `wrangler dev` on `:8787` with
hermetic local state in `.wrangler-smoke/`, and runs 43 assertions through
`POST /mcp` - including killing the signer mid-run to prove failover, and
checking that anonymous `/admin/*` calls are rejected. It writes
`worker/.dev.vars` (gitignored) for mock mode, including the smoke-only
`ADMIN_TOKEN` and `FACADE_CALLBACK_TOKEN`.

Running pieces by hand:

```bash
MOCK=1 SIGNER_TOKEN=dev pnpm signer:dev     # gateway on :8788
pnpm dev                                    # wrangler dev on :8787
curl -s localhost:8787/ | jq '.tools[].name'
ADMIN_TOKEN=dev-token pnpm dev
curl -s localhost:8787/admin/providers -H "authorization: Bearer dev-token" | jq
```

## Tests

```bash
pnpm test        # worker + signer + vps-agent suites
pnpm typecheck
```

The Worker suite covers velocity math, routing/failover/breaker/budget, posting
validation, TikTok + trending + vendor payload mapping, and the tool surface
(every spec tool exists, every description carries a risk tier).

## Deploying the facade

```bash
cd worker
npx wrangler d1 create ventriloquist          # put the id in wrangler.toml
npx wrangler kv namespace create KV
npx wrangler r2 bucket create ventriloquist-media
npx wrangler queues create ventriloquist-posting
npx wrangler queues create ventriloquist-posting-dlq
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put SIGNER_GATEWAY_URL
npx wrangler secret put SIGNER_GATEWAY_TOKEN
npx wrangler secret put SCRAPEBADGER_API_KEY
npx wrangler secret put POSTING_WORKER_URL
npx wrangler secret put POSTING_WORKER_TOKEN
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put FACADE_CALLBACK_TOKEN
npx wrangler secret put ALERT_TELEGRAM_BOT_TOKEN   # optional
npx wrangler secret put ALERT_TELEGRAM_CHAT_ID     # optional
npx wrangler deploy
```

`ADMIN_TOKEN` gates `/admin/*`. Three values must be identical or jobs will be
rejected in one direction: this Worker's `POSTING_WORKER_TOKEN` (sent to the
VPS as `x-facade-call-token`), this Worker's `FACADE_CALLBACK_TOKEN`, and the
VPS's `FACADE_CALLBACK_TOKEN`. Both admin and callback routes fail closed, so
deploy the secrets before exposing the Worker.

## Continuous integration

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile`,
`pnpm typecheck`, `pnpm test` and `pnpm smoke` on every push and pull request
against `main`. `.github/workflows/d1-backup.yml` exports D1 to the backup
bucket weekly; it needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and the
`BACKUP_BUCKET` repository variable.

Cron triggers are declared in `wrangler.toml`; each schedule maps to one job in
`worker/src/cron/index.ts`. Fire one by hand with
`wrangler dev --test-scheduled`:

```bash
curl "localhost:8787/__scheduled?cron=5+*/4+*+*+*"
```

## Deploying the signer gateway (VPS)

```bash
cd signer
docker build -t ventriloquist-signer .
docker run -d --name signer -p 8788:8788 \
  -e SIGNER_TOKEN="$(openssl rand -hex 24)" \
  -e SIGNER_PAGE_POOL_SIZE=2 \
  ventriloquist-signer
curl -s localhost:8788/health | jq
```

Without Docker: install Chromium, then
`CHROME_EXECUTABLE_PATH=/usr/bin/chromium SIGNER_TOKEN=... npx tsx src/index.ts`.

Check which signing strategy is live:

```bash
curl -s localhost:8788/sign -H "authorization: Bearer $SIGNER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.tiktok.com/api/challenge/detail/?challengeName=babynames"}' \
  | jq '.mode, .strategy'
```

`mode: "signed"` is the fast path. `mode: "in_page"` means TikTok rotated the
SDK global and the gateway is fetching inside the page - reads keep working,
but this is the signal to spend maintenance time, and `strategy` says why.

## Deploying the posting worker (VPS, RED)

1. `POSTING_SESSION_AGE_CMD="age -d -i /etc/ventriloquist/posting.key"` plus
   `sessions/nobodynamed.json.age` holding the posting cookies. Never put that
   file in D1, in the Worker, or in logs; `GET /health` reports only cookie
   names and a count.
2. `RENDER_COMMAND="uv run nbn render --story {story} --out {out}"` and
   `NBN_REPO_DIR=/opt/nobodynamed-video`.
3. `R2_PUBLIC_BASE` (or a signed-URL service) so artifacts can be downloaded.
4. `FACADE_URL` + `FACADE_CALLBACK_TOKEN` so job outcomes land back in
   `post_jobs`.
5. `POSTING_DRY_RUN=1` first: the worker walks the upload flow and stops before
   submitting. Confirm the selectors in `vps-agent/src/uploader.ts` still match
   TikTok Studio, then set `POSTING_DRY_RUN=0`.
6. `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`:
   scoped R2 S3 credentials. Rendered artifacts are uploaded here and queued
   artifacts are downloaded with the same credentials; `R2_PUBLIC_BASE` stays a
   read fallback only.
7. `ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID` (same values as the
   Worker) so halts and stale sessions reach you.
8. `BURNER_SESSION_FILE` + `BURNER_USER_DATA_DIR`: a separate burner login for
   the AMBER Studio scrape, so the posting session is never used for scraping.
9. Restart the worker after changing any of these; `GET /health` reports the
   posting session's staleness without ever printing cookie values.

Expose both VPS services through Cloudflare Tunnel (`cloudflared tunnel`) rather
than opening inbound ports: one hostname for the signer (`SIGNER_GATEWAY_URL`)
and one for the posting worker (`POSTING_WORKER_URL`). Keep the bearer tokens -
the tunnel is transport, not authorization.

### Posting session rotation (manual, monthly)

1. Re-login to TikTok as @nobodynamed in a browser on the VPS.
2. Export the cookies for `.tiktok.com` as JSON.
3. Re-seal: `age -R <recipient> -o sessions/nobodynamed.json.age cookies.json`.
4. Confirm with `curl -s localhost:8799/health | jq` (`stale: false`).
5. Delete the plaintext export. Never commit or copy the sealed file off the VPS.

`POSTING_SESSION_MAX_AGE_DAYS` (default 30) decides when the weekly cron starts
alerting that the seal is old, even if the cookies have not expired.

## Shadow cohort curation

```bash
node scripts/draft-cohort.mjs --facade https://$FACADE   # writes cohort-draft.json
# review/edit the handles and niches, then:
node scripts/seed-cohort.mjs --facade https://$FACADE cohort-draft.json
```

The draft script profiles each candidate for a follower count. A cohort that
is still short of 50 is reported by `tt_system_status` and `tt_shadow_cohort`;
do not pad it with guessed handles - a bad cohort measures nothing.

## Operations

| Need | Command |
|---|---|
| Provider health + breakers | `curl -s $FACADE/admin/providers -H "authorization: Bearer $ADMIN_TOKEN" \| jq` |
| Clear a breaker after a fix | `curl -X POST "$FACADE/admin/providers/reset?provider=signer" -H "authorization: Bearer $ADMIN_TOKEN"` |
| Signer reliability vs paid spend | `curl -s "$FACADE/admin/ledger?days=30" -H "authorization: Bearer $ADMIN_TOKEN" \| jq` |
| Tighten today's paid budget | `curl -X POST $FACADE/admin/budget -H "authorization: Bearer $ADMIN_TOKEN" -d '{"daily_usd":1}'` |
| Add cohort accounts | `node scripts/seed-cohort.mjs accounts.json` |

| Symptom | First move |
|---|---|
| `no_provider_available` on reads | `tt_system_status`; if the signer breaker is open, check `/health` on the gateway, then reset the breaker after a fix. |
| Paid spend climbing | `/admin/ledger` shows which capability and provider; a healthy signer keeps cost at $0. |
| Posts stuck `queued` | The facade consumer records dispatch failures in `post_jobs.error`; check `POSTING_WORKER_URL` reachability and the VPS worker log. |
| Two consecutive post failures | Posting halts automatically. Fix the cause (session expiry, selector drift, Studio redesign) before clearing. |
| Studio analytics empty | The daily AMBER scrape runs on the VPS; `tt_own_deep_analytics` reports the gap rather than guessing. |
| No Telegram messages arriving | `tt_system_status` -> `configuration.alerts_configured`; the VPS logs "alert suppressed" when its token or chat id is missing. |
| Duplicate concern after a queue retry | `POST /jobs` is idempotent per `job_id`; a replay returns `duplicate: true` with the stored outcome instead of posting again. |

## Go-live checklist

1. `pnpm test`, `pnpm typecheck` and `pnpm smoke` pass locally and in CI.
2. Worker secrets set (including `ADMIN_TOKEN` and `FACADE_CALLBACK_TOKEN`);
   anonymous `curl` of `/admin/providers` returns 401.
3. Signer `/health` is green and a live read shows `mode: "signed"` or the
   documented `mode: "in_page"` fallback.
4. Real reads land in D1: run `tt_profile`, then confirm
   `tt_system_status.accumulation.video_snapshots` increased.
5. Cohort seeded to 50/50 via the draft-and-review flow.
6. `POSTING_DRY_RUN=1` walkthrough against live Studio confirms the upload
   selectors; then one real post completes with a `tiktok_url` in `post_jobs`.
7. A synthetic failed job raises the Telegram halt alert.
8. Studio scrape returns rows and `tt_own_deep_analytics` shows them.
9. D1 export restores into a scratch database.
10. `tt_system_status` warnings are understood: no vendor key means signer-only
    reads, and Whisper remains a documented non-goal.
