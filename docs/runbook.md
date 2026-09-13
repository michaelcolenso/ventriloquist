# Runbook

## Local development (no Chromium, no TikTok, no spend)

```bash
pnpm install
pnpm migrate:local          # apply D1 migrations to the local database
pnpm smoke                  # boot mock signer + worker, drive the real MCP endpoint
```

`pnpm smoke` starts two mock processes (the signer gateway on `:8788`, the
vendor/Creative-Center mock on `:8789`), boots `wrangler dev` on `:8787` with
hermetic local state in `.wrangler-smoke/`, and runs 40 assertions through
`POST /mcp` - including killing the signer mid-run to prove failover. It writes
`worker/.dev.vars` (gitignored) for mock mode.

Running pieces by hand:

```bash
MOCK=1 SIGNER_TOKEN=dev pnpm signer:dev     # gateway on :8788
pnpm dev                                    # wrangler dev on :8787
curl -s localhost:8787/ | jq '.tools[].name'
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
npx wrangler deploy
```

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

## Operations

| Need | Command |
|---|---|
| Provider health + breakers | `curl -s $FACADE/admin/providers \| jq` |
| Clear a breaker after a fix | `curl -X POST "$FACADE/admin/providers/reset?provider=signer"` |
| Signer reliability vs paid spend | `curl -s "$FACADE/admin/ledger?days=30" \| jq` |
| Tighten today's paid budget | `curl -X POST $FACADE/admin/budget -d '{"daily_usd":1}'` |
| Add cohort accounts | `node scripts/seed-cohort.mjs accounts.json` |

| Symptom | First move |
|---|---|
| `no_provider_available` on reads | `tt_system_status`; if the signer breaker is open, check `/health` on the gateway, then reset the breaker after a fix. |
| Paid spend climbing | `/admin/ledger` shows which capability and provider; a healthy signer keeps cost at $0. |
| Posts stuck `queued` | The facade consumer records dispatch failures in `post_jobs.error`; check `POSTING_WORKER_URL` reachability and the VPS worker log. |
| Two consecutive post failures | Posting halts automatically. Fix the cause (session expiry, selector drift, Studio redesign) before clearing. |
| Studio analytics empty | The daily AMBER scrape runs on the VPS; `tt_own_deep_analytics` reports the gap rather than guessing. |
