# VENTRILOQUIST
### An Unofficial TikTok MCP — Full Technical Specification

**Version:** 1.0 · **Date:** 2026-09-14 · **Status:** Ready for implementation
**Working name:** *Ventriloquist* — because the voice appears to come from TikTok, but the skill is entirely ours. No official APIs. No OAuth. No app audit. No permission asked.

---

## 0. Thesis

TikTok's official API surface in 2026 is a walled garden with three gates, each rusted shut in a different way:

| Official API | What it gives you | Why it's useless to us |
|---|---|---|
| **Research API** | The good data: hashtags, comments, trends | Academic non-profits only, 1,000 req/day, commercial use explicitly ineligible |
| **Content Posting API** | Publishing | ~15–25 videos/day cap, sandbox posts forced private until an app audit you'll never pass for automation tooling |
| **Display API** | Read-only own-account metadata | Audit-gated, and only *your* account — no competitive intelligence |
| **Ads MCP (2026)** | Campaign management for agents | Ads only. Explicitly no organic content, no trends, no creator analytics |

Meanwhile, the unofficial ecosystem has matured: self-hostable request signers defeat `X-Bogus`/`X-Gnarly`/`msToken`, a competitive scraper-API market sells TikTok data at $0.0006–0.002/request, and Playwright can drive the entire creator web surface with session cookies.

**The gap:** nobody has assembled these pieces into a coherent, agent-native MCP server with proper abstractions, failover, risk labeling, and — most importantly — *accumulated proprietary data*. The scraper APIs are all stateless proxies. They answer "what is trending now?" Nobody answers "what will be trending in 72 hours?"

Ventriloquist is that assembly. It is a facade MCP server that:

1. **Never touches an official TikTok API.** Every capability is achieved by alternative means.
2. **Fails over gracefully.** Self-hosted signing first, managed scraper API as fallback — per capability, automatically.
3. **Accumulates instead of proxies.** Every read becomes a row in D1. Within weeks, Ventriloquist owns a time-series trend dataset that no API on earth sells.
4. **Labels its own risk.** Every tool carries a risk tier so any agent (or human) calling it knows exactly what's being touched.
5. **Closes the content flywheel.** Trend intelligence → script → render (nobodynamed-video) → post → performance → better scripts.

---

## 1. Design Principles

**P1 — Zero official surface area.** No TikTok developer app, no OAuth flows, no API keys issued by TikTok. If TikTok nuked their entire developer platform tomorrow, Ventriloquist would not notice.

**P2 — Dual-path redundancy, always.** Every read capability has at least two independent backends: a self-hosted path we own (free, fragile, fixable) and a managed path we rent (cheap, reliable, rented). Automatic failover with health probes. This mirrors the standing preference for automation + manual fallback pairs.

**P3 — Accumulate, don't proxy.** A scraper API answers questions about *now*. A database answers questions about *change*. Every response that passes through the facade is snapshotted. The data asset compounds; the API bills don't.

**P4 — Risk is a first-class type.** Every tool is labeled `GREEN` (scraped public data — no session, no account exposure), `AMBER` (session-authenticated reads — cookie exposure, soft-ban risk), or `RED` (write actions — account penalty risk). The MCP server advertises these in tool descriptions so the calling agent can reason about them.

**P5 — Account segregation.** The posting identity and the scraping identity are *never* the same account. AMBER scraping runs on sacrificial burner sessions. The nobodynamed posting account's cookies are used for RED posting actions and nothing else — its session is crown-jewel infrastructure.

**P6 — Everything is a job.** Writes and heavy scrapes are never synchronous MCP calls. Tools return job IDs; a queue executes them with human pacing; separate tools poll job status. This makes rate limits, retries, and audit trails structural rather than aspirational.

**P7 — Ship the smoke test first.** The first deliverable proves the read path for ~$0 before a single line of the posting path is written.

---

## 2. Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │           MCP CLIENTS                        │
                        │   (Kimi, Claude, Hermes agent, scripts)     │
                        └──────────────────┬──────────────────────────┘
                                           │  Streamable HTTP / SSE
                                           ▼
        ┌────────────────────────────────────────────────────────────────┐
        │              VENTRILOQUIST FACADE (Cloudflare Worker)          │
        │                                                                │
        │  ┌──────────────┐  ┌───────────────┐  ┌─────────────────────┐  │
        │  │ Tool Router   │  │ Risk Enforcer │  │ Job Queue (Queues)  │  │
        │  │ + registry    │  │ + rate limits │  │ + status polling    │  │
        │  └──────┬───────┘  └───────────────┘  └──────────┬──────────┘  │
        │         │                                        │             │
        │  ┌──────▼───────────────────────────────────────▼──────────┐   │
        │  │           BACKEND ABSTRACTION LAYER                      │   │
        │  │  provider registry · health probes · failover ·          │   │
        │  │  cost ledger · circuit breakers                          │   │
        │  └──┬──────────────┬──────────────┬──────────────┬─────────┘   │
        └─────┼──────────────┼──────────────┼──────────────┼─────────────┘
              │              │              │              │
     ┌────────▼───┐  ┌───────▼──────┐  ┌────▼─────────┐  ┌─▼────────────┐
     │ SIGNER      │  │ SCRAPER API  │  │ PLAYWRIGHT   │  │ STORAGE      │
     │ GATEWAY     │  │ (fallback)   │  │ WORKER       │  │              │
     │ (VPS)       │  │ ScrapeBadger │  │ (VPS)        │  │ D1 · R2      │
     │             │  │ /ScrapeCreat.│  │              │  │ Workers KV   │
     │ Puppeteer + │  │              │  │ posting ·    │  │ Cron Trigger │
     │ TikTok's own│  │ pay-per-call │  │ AMBER reads  │  │ snapshots    │
     │ web SDK     │  │              │  │ via cookies  │  │              │
     └─────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

### 2.1 Component responsibilities

**Facade Worker (Cloudflare Workers, agents SDK / `@modelcontextprotocol/sdk`)**
- Hosts the remote MCP server over Streamable HTTP.
- Tool registry with risk-tier metadata baked into every tool description.
- Routes each call to the healthiest backend for that capability.
- Writes every read response to D1 (the accumulation layer) asynchronously via `ctx.waitUntil` — snapshotting never blocks the response.
- Enqueues write actions to Cloudflare Queues; never executes them inline.

**Signer Gateway (self-hosted, VPS — the Hermes box)**
- Runs the `tiktok-signature` pattern: a small pool of headless Chromium pages with TikTok's own web SDK loaded, exposing `POST /sign` which returns fully signed request URLs (`X-Bogus`, `X-Gnarly`, `msToken` refresh).
- Alternatively (v2): swap to the pure-Python signer (all three algorithms reimplemented, no JS runtime) once validated against live endpoints — lower resource footprint, higher maintenance exposure.
- Fronted by a tiny Fastify/Express API. Authenticated to the facade via a shared bearer token. This service *is* the unofficial API — everything else is plumbing.

**Scraper API fallback**
- ScrapeBadger or ScrapeCreators (both ~$1–2 per 1,000 calls; pick one primary, keep the other's SDK warm).
- Activated automatically per-capability when the signer's circuit breaker is open.

**Playwright Worker (VPS, co-located with signer)**
- Holds two classes of session cookies: **burner sessions** (AMBER reads: TikTok Studio analytics, anything behind login) and the **nobodynamed posting session** (RED writes only).
- Executes posting jobs from the queue: `tiktok-uploader`-style automation — navigate to upload page, set file, fill caption/hashtags, submit, confirm.
- Human pacing: randomized delays (3–11s between actions), max 5 posts/day (far below the unofficial soft limits), business-hours jitter aligned to US timezones.

**Storage**
- **D1:** all accumulated time-series data (the crown jewel — see §5).
- **R2:** video thumbnails, downloaded media for transcription, render artifacts handed off from nobodynamed-video.
- **Workers KV:** signer health state, circuit-breaker flags, msToken cache.
- **Cron Triggers:** snapshot schedules (see §5.2).

---

## 3. Capability Matrix — Official → Unofficial

| # | Official capability | Official gate | Ventriloquist replacement | Risk tier |
|---|---|---|---|---|
| 1 | Search videos by keyword/hashtag | Research API (academics only) | Signer → `tiktok.com/api/search/` endpoints; fallback: scraper API | GREEN |
| 2 | Trending hashtags/sounds/creators | *Not offered to anyone* | TikTok Creative Center public endpoints + self-snapshotted velocity | GREEN |
| 3 | Profile/video metadata | Display API (audit, own-account) | Signer → public web endpoints; fallback: scraper API | GREEN |
| 4 | Comments on any video | Research API only | Signer → comment list endpoint; fallback: scraper API | GREEN |
| 5 | Own-account analytics (deep) | Analytics API (audit) | Playwright → TikTok Studio web UI, burner-scoped, scheduled | AMBER |
| 6 | Own-account video metrics (public) | Display API | Public profile scrape — plays/likes/comments/shares are all public | GREEN |
| 7 | Post video | Content Posting API (15–25/day, audit) | Playwright upload worker, session cookies, ≤5/day pacing | RED |
| 8 | Video transcript | Research API only | Download via signer → Whisper (already-in-house pattern) | GREEN |

**The honest caveats, in writing:**
- Signing is an arms race. TikTok rotates `X-Bogus`/`X-Gnarly` parameters; the signer will break periodically. That's why P2 exists — circuit breaker flips to the paid fallback, alert fires, we patch. Budget ~2–4 hours/month of signer maintenance.
- RED-tier posting via automation violates TikTok ToS. Mitigation: low volume, human pacing, dedicated session, and accepting that the posting account carries residual risk. For nobodynamed's cadence (3–5 videos/day) this is well within observed community norms, but the risk is nonzero and acknowledged.
- AMBER scraping sessions (burners) should be treated as disposable. Rotate every 2–4 weeks.

---

## 4. MCP Tool Surface

All tools are namespaced `tt_*`. Every tool description embeds its risk tier, e.g. `[GREEN · scraped-public]`. Read tools return data *and* write a snapshot row to D1.

### 4.1 Trend Intelligence (the differentiator)

| Tool | Description | Tier |
|---|---|---|
| `tt_trending_hashtags` | Current trending hashtags by region/category, with our historical velocity annotations when available | GREEN |
| `tt_trending_sounds` | Trending sounds; flags sounds in **growth phase** (see §5.3) | GREEN |
| `tt_hashtag_momentum` | `{hashtag, window}` → time series of view/post counts + velocity + acceleration + lifecycle stage | GREEN |
| `tt_emerging_in_niche` | `{niche_keywords[]}` → ranked list of videos/sounds/hashtags gaining velocity before saturation | GREEN |
| `tt_search_videos` | `{query, filters}` → videos with full public metrics | GREEN |
| `tt_sound_lifecycle` | `{sound_id}` → birth date, growth curve, peak detection, saturation estimate | GREEN |

### 4.2 Account & Video Intelligence

| Tool | Description | Tier |
|---|---|---|
| `tt_profile` | Public profile: stats, recent videos with metrics | GREEN |
| `tt_video_detail` | Single video: all public metrics, music, hashtags, transcript (lazy Whisper) | GREEN |
| `tt_shadow_cohort` | The tracked competitor set (§5.4): latest posts, per-account velocity, breakouts | GREEN |
| `tt_compare_accounts` | Side-by-side metrics + posting cadence analysis | GREEN |

### 4.3 Comment Mining (the ideation engine)

| Tool | Description | Tier |
|---|---|---|
| `tt_video_comments` | `{video_id, sort}` → comments with likes/replies | GREEN |
| `tt_mine_comment_ideas` | Cluster comments across recent own+competitor videos into a ranked content-request backlog ("do Karen next!"). Returns structured ideas with demand scores | GREEN |
| `tt_comment_sentiment` | Aggregate sentiment/topics for a video or account | GREEN |

### 4.4 Own-Account Analytics

| Tool | Description | Tier |
|---|---|---|
| `tt_own_video_metrics` | Public metrics for all own videos (GREEN path) | GREEN |
| `tt_own_deep_analytics` | Watch time, traffic sources, retention — via Studio scrape, scheduled snapshots only | AMBER |
| `tt_what_worked` | `{window}` → ranked analysis of own videos: hooks, sounds, topics correlated with performance | GREEN (reads D1) |

### 4.5 Publishing (queued, RED)

| Tool | Description | Tier |
|---|---|---|
| `tt_queue_post` | `{video_r2_key, caption, hashtags, schedule_at?}` → `job_id`. Validates daily cap before enqueueing | RED |
| `tt_job_status` | `{job_id}` → queued/running/posted/failed + TikTok URL when live | GREEN |
| `tt_render_and_post` | The flywheel primitive: hand a nobodynamed-video render spec → render → R2 → queue post → return job_id | RED |

---

## 5. The Trend Velocity Engine (the crown jewel)

This is the part no scraper API sells, because they're all stateless. Ventriloquist accumulates.

### 5.1 D1 schema (core tables)

```sql
-- Snapshot tables: raw accumulation, append-only
CREATE TABLE hashtag_snapshots (
  hashtag TEXT NOT NULL,
  captured_at INTEGER NOT NULL,        -- unix epoch
  view_count INTEGER, post_count INTEGER,
  source TEXT NOT NULL,                -- 'signer' | 'scrapebadger' | 'creative_center'
  PRIMARY KEY (hashtag, captured_at)
);

CREATE TABLE video_snapshots (
  video_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  author TEXT, play_count INTEGER, like_count INTEGER,
  comment_count INTEGER, share_count INTEGER,
  sound_id TEXT, hashtags TEXT,          -- JSON array
  source TEXT NOT NULL,
  PRIMARY KEY (video_id, captured_at)
);

CREATE TABLE sound_snapshots (
  sound_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  video_count INTEGER,                   -- videos using this sound
  source TEXT NOT NULL,
  PRIMARY KEY (sound_id, captured_at)
);

-- Tracked entities: what the cron watches
CREATE TABLE watchlist (
  entity_type TEXT NOT NULL,             -- 'hashtag' | 'sound' | 'account'
  entity_id TEXT NOT NULL,
  niche TEXT,                            -- 'baby-names' | 'family' | ...
  added_at INTEGER, active INTEGER DEFAULT 1,
  PRIMARY KEY (entity_type, entity_id)
);

-- The shadow cohort: 50 accounts in/adjacent to our niche
CREATE TABLE shadow_cohort (
  username TEXT PRIMARY KEY,
  niche TEXT, added_at INTEGER,
  follower_count INTEGER                 -- refreshed on snapshot
);

-- Job queue mirror (durable record of RED actions)
CREATE TABLE post_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                  -- queued|running|posted|failed
  video_r2_key TEXT, caption TEXT, hashtags TEXT,
  scheduled_at INTEGER, posted_at INTEGER,
  tiktok_url TEXT, error TEXT
);

-- Comment-derived content backlog
CREATE TABLE content_ideas (
  idea_id TEXT PRIMARY KEY,
  source TEXT,                           -- 'comments' | 'trend' | 'manual'
  payload TEXT NOT NULL,                 -- JSON: {concept, name_suggestions[], demand_score}
  status TEXT DEFAULT 'backlog',         -- backlog|scripted|rendered|posted|rejected
  created_at INTEGER
);
```

### 5.2 Snapshot crons

| Cron | Schedule | Action |
|---|---|---|
| `snapshot-watchlist` | every 4h | Pull current stats for all active watchlist entities via healthiest backend → append snapshot rows |
| `snapshot-shadow-cohort` | every 6h | Latest 10 videos per cohort account → video_snapshots |
| `snapshot-creative-center` | every 4h | Trending hashtags/sounds top-200 → snapshots + auto-add rising entities to watchlist |
| `snapshot-own-account` | every 6h | Own video public metrics → snapshots |
| `studio-deep-scrape` | daily (AMBER) | Playwright → Studio analytics → D1 (watch time, traffic sources) |
| `session-refresh` | weekly | Playwright login flow to refresh burner cookies; alert if posting session is stale |
| `signer-canary` | every 15min | Signed probe request against a known-stable endpoint; trip circuit breaker on failure |

### 5.3 Velocity math — detecting trends before they peak

For each entity with ≥4 snapshots in a window, compute:

- **Velocity** `v = Δmetric / Δt` over the trailing 24h and 7d windows.
- **Acceleration** `a = v_24h − v_7d_avg`. Positive acceleration on a low-base entity is the early-warning signal.
- **Lifecycle stage** classifier:
  - `EMBRYONIC` — <3 days of history, any velocity
  - `GROWTH` — positive acceleration, absolute count below niche saturation threshold (calibrated per niche; baby-name hashtags saturate ~10–50M views, not billions)
  - `PEAK` — velocity max, acceleration ≈ 0
  - `DECAY` — negative acceleration 3+ consecutive snapshots
- **Actionability score** = acceleration × (1 − saturation%) × niche_relevance. This is what `tt_emerging_in_niche` ranks by. The product question it answers: *"what should nobodynamed make a video about this week that hasn't been done to death yet?"*

### 5.4 The Shadow Cohort

Seed 50 accounts: baby-name content, family/parenting humor, name-etymology, adjacent data-storytelling accounts. Everything they post is snapshotted. Consequences:

- **Breakout detection:** any cohort video >3σ above that account's trailing median plays within 48h → alert + auto-enqueue for hook/format analysis.
- **Format arbitrage:** when a cohort account pioneers a format that works, we see it within 6 hours, not when it hits the mainstream FYP.
- **Idea provenance:** the cohort is also the mining ground for `tt_mine_comment_ideas` — their comment sections reveal unmet demand in our exact niche.

---

## 6. Backend Abstraction Layer

```typescript
interface CapabilityProvider {
  name: string;                        // 'signer' | 'scrapebadger' | 'scrapecreators'
  capabilities: Capability[];          // 'search' | 'profile' | 'comments' | ...
  healthCheck(): Promise<boolean>;
  execute(cap: Capability, params: unknown): Promise<unknown>;
  costPerCallUSD: number;              // 0 for signer
}

interface ProviderHealth {
  consecutiveFailures: number;
  circuitOpenUntil: number | null;     // epoch; null = closed/healthy
  lastLatencyMs: number;
}
```

**Routing policy per capability:**
1. Providers sorted by `costPerCallUSD` ascending (self-hosted first).
2. Skip any provider with an open circuit breaker.
3. On failure: increment failure count, trip breaker at 3 consecutive failures (15-min cooldown, canary probes for early recovery), cascade to next provider.
4. Every failover event is logged to D1 — a monthly report on signer reliability vs. paid spend is generated from this (the cost ledger). This is how we quantify whether the signer is worth its maintenance hours.

**Cost ceiling:** KV-stored daily budget for paid providers (default $3/day ≈ 3–5k calls). Breach → degrade gracefully to GREEN-public endpoints only + alert.

---

## 7. The Posting Path (RED) — engineered paranoia

1. **Queue semantics.** `tt_queue_post` validates: daily cap (≤5), minimum spacing (≥3h between posts), R2 object exists, caption length. Enqueues to Cloudflare Queues.
2. **Worker execution (VPS).** Consumer picks job → Playwright with the nobodynamed session (persistent context, cookies refreshed weekly) → `tiktok-uploader`-style flow → success confirmed by polling the profile for the new video → `tiktok_url` written to job record.
3. **Pacing theater.** Randomized inter-action delays, human-plausible upload hours, occasional no-op days. Not to defeat fraud detection per se — to stay boringly within normal-creator behavior envelopes.
4. **Failure doctrine.** Two consecutive post failures → posting halts automatically, alert fires. Never retry-loop a RED action; that's how sessions get flagged.
5. **Session custody.** Posting-session cookies live in an encrypted file on the VPS (age-encrypted, key in env), never in D1, never in the Worker, never in logs. Rotation: manual monthly re-login; staleness detected by the weekly `session-refresh` cron.

---

## 8. Flywheel Integration (nobodynamed-video)

The end state is a single agent instruction per content cycle:

```
Human: "Run this week's name-content cycle."

Agent:
 1. tt_emerging_in_niche(['baby names','name meanings','family']) 
    → "Vintage 'nickname-proof' names are accelerating; sound X is in GROWTH"
 2. tt_mine_comment_ideas → "14 comments across cohort asking for '80s names that vanished'"
 3. tt_what_worked('30d') → "graveyard-format + count-up hook outperforms 2.3×"
 4. Compose script (existing nobodynamed-video pipeline), tt_render_and_post
 5. 72h later: tt_own_video_metrics shows result → snapshot → next week's 
    tt_what_worked is smarter
```

Every stage of that loop is a tool; every tool's output feeds the next. The compounding asset is the D1 history that makes step 3 sharper each week.

---

## 9. Implementation Phases

| Phase | Scope | Exit criteria | Effort |
|---|---|---|---|
| **0 — Smoke test** | Stand up `tiktok-signature` on VPS; snapshot 5 cohort accounts + 20 niche hashtags daily into D1 | 14 consecutive days of data; ≤2 signer outages | 1 weekend |
| **1 — Read facade** | Worker + MCP server; tools §4.1–4.2 via signer with scraper-API failover; circuit breakers; cost ledger | All GREEN read tools live; failover demonstrated by killing the signer | 3–4 days |
| **2 — Velocity engine** | Watchlist crons, shadow cohort, velocity/lifecycle math, `tt_emerging_in_niche`, `tt_sound_lifecycle` | Correctly flags ≥1 known breakout retroactively from accumulated data | 3 days |
| **3 — Comment mining** | §4.3 tools, clustering pipeline, content_ideas backlog | First ranked idea backlog generated from real comments | 2 days |
| **4 — Posting path** | Queue, Playwright worker, pacing, session custody, `tt_queue_post`/`tt_render_and_post` | One nobodynamed video posted end-to-end via MCP | 3–4 days |
| **5 — Deep analytics** | AMBER Studio scrape on burner session, daily cron | Watch-time data flowing into `tt_what_worked` | 2 days |
| **6 — Productize (optional)** | Multi-tenant keys, per-user rate limits, public pricing | External user pays for access | later |

**Total to full flywheel: ~3 weeks of part-time work**, with monetizable data accumulating from day one.

---

## 10. Monetization Optionality (the cunning part)

Once Phase 2 lands, Ventriloquist sits on an asset nobody else has: **time-series niche-trend data with velocity metrics**. Three ways to cash it, in increasing ambition:

1. **Internal edge only** — nobodynamed simply out-publishes the niche because it sees trends 48–72h early. Free, immediate.
2. **Niche trend report** — a weekly "Name Trends Brief" ($9–19/mo Substack-style), generated automatically from D1. Zero marginal cost, markets nobodynamed as a byproduct.
3. **The MCP as a product** — the ScrapeBadger insight applies: people pay for *one consistent interface with failover*, not for scraping. Ventriloquist's velocity tools are genuinely novel — no scraper API offers momentum/lifecycle because they're stateless. Multi-tenant the facade, charge $29/mo for the trend-intelligence tier. The pSEO playbook applies to marketing it.

---

## 11. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| TikTok rotates signing; signer breaks | Certain (recurring) | Read outage ≤ hours | Paid fallback + circuit breaker + canary alerts; ~2–4h/mo maintenance budget |
| Posting account flagged | Low–medium | Loss of posting channel | Pacing theater, ≤5/day, dedicated session, halt-on-failure doctrine |
| Scraper-API vendor degrades | Medium | Fallback cost spike | Second vendor kept warm; signer is primary anyway |
| Burner sessions die | Medium | AMBER analytics gap | Weekly session-refresh cron; treat burners as disposable |
| Legal/ToS exposure | Structural | — | Public-data scraping only for GREEN tier; no PII collection; Cease-and-desist response = retire facade, keep the accumulated D1 data (it's ours) |
| D1 size limits (10GB) | Low (years away) | Storage pressure | Snapshot compaction job: hourly → daily rollups for data >90 days old |

---

## 12. Open Decisions (pick before Phase 1)

1. **Signer implementation:** `tiktok-signature` (Puppeteer+SDK, battle-tested, heavier) vs. pure-Python signer (no JS runtime, more maintenance exposure). *Recommendation: start with tiktok-signature; prototype the Python one in Phase 2 downtime.*
2. **Paid fallback vendor:** ScrapeBadger vs. ScrapeCreators. *Recommendation: ScrapeBadger (cheapest at scale), ScrapeCreators credentials stored for emergency.*
3. **MCP transport:** Streamable HTTP on Workers (recommended) vs. SSE. Agents SDK handles either; pick Streamable HTTP, it's the 2026 standard.
4. **Shadow cohort seed list:** needs one curation pass — 50 accounts across baby-names/parenting-humor/etymology/data-storytelling. *Can be semi-automated via Creative Center category leaders.*

---

## Appendix A — Environment & Secrets

```
# Facade Worker (wrangler secrets)
SIGNER_GATEWAY_URL          # https://signer.<vps-domain>
SIGNER_GATEWAY_TOKEN        # shared bearer
SCRAPEBADGER_API_KEY        # paid fallback
SCRAPECREATORS_API_KEY      # emergency fallback
DAILY_PAID_BUDGET_USD=3

# VPS (signer + playwright worker)
POSTING_SESSION_AGE_KEY     # decrypts posting-session cookies
BURNER_COOKIES_DIR          # rotating burner session files
FACADE_CALLBACK_TOKEN       # worker authenticates job status callbacks
```

## Appendix B — Reference implementations to crib from

- **Signing:** `carcabot/tiktok-signature` (Puppeteer + TikTok SDK injection, `/signature` endpoint pattern); pure-Python signer implementations for `X-Bogus`/`X-Gnarly`/`msToken`
- **Read scraping:** `Evil0ctal/Douyin_TikTok_Download_API` (endpoint coverage map + signing docs); `TikTok-Api` (Python, msToken flow)
- **Posting:** `tiktok-uploader` (Playwright session-cookie upload flow, pacing patterns)
- **MCP hosting:** Cloudflare agents SDK remote MCP server pattern
- **Trend sources:** TikTok Creative Center public endpoints (hashtags/sounds/creators)

---

*Ventriloquist doesn't ask TikTok for permission to understand TikTok. It watches, it remembers, and — unlike every scraper API on the market — it never forgets.*
