-- Ventriloquist initial schema.
-- Section 5.1 of the spec defines the core tables; this migration adds the
-- operational tables required by other sections (failover/cost ledger from
-- section 6, Studio deep analytics from section 2.1, transcript cache from
-- section 4.2, rollups from the risk register).

-- ---------------------------------------------------------------------------
-- Snapshot tables: raw accumulation, append-only
-- ---------------------------------------------------------------------------
CREATE TABLE hashtag_snapshots (
  hashtag TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  view_count INTEGER,
  post_count INTEGER,
  source TEXT NOT NULL,
  PRIMARY KEY (hashtag, captured_at)
);

CREATE TABLE video_snapshots (
  video_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  author TEXT,
  play_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  share_count INTEGER,
  sound_id TEXT,
  hashtags TEXT,
  source TEXT NOT NULL,
  PRIMARY KEY (video_id, captured_at)
);

CREATE TABLE sound_snapshots (
  sound_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  video_count INTEGER,
  user_count INTEGER,
  source TEXT NOT NULL,
  PRIMARY KEY (sound_id, captured_at)
);

-- ---------------------------------------------------------------------------
-- Tracked entities: what the cron watches
-- ---------------------------------------------------------------------------
CREATE TABLE watchlist (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  niche TEXT,
  added_at INTEGER,
  active INTEGER DEFAULT 1,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE shadow_cohort (
  username TEXT PRIMARY KEY,
  niche TEXT,
  added_at INTEGER,
  follower_count INTEGER
);

-- ---------------------------------------------------------------------------
-- Job queue mirror (durable record of RED actions)
-- ---------------------------------------------------------------------------
CREATE TABLE post_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  video_r2_key TEXT,
  caption TEXT,
  hashtags TEXT,
  scheduled_at INTEGER,
  posted_at INTEGER,
  tiktok_url TEXT,
  error TEXT,
  -- additions beyond the spec's core schema
  kind TEXT NOT NULL DEFAULT 'post',
  render_spec TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_post_jobs_status ON post_jobs (status, created_at);
CREATE INDEX idx_post_jobs_posted_at ON post_jobs (posted_at);

-- ---------------------------------------------------------------------------
-- Comment-derived content backlog
-- ---------------------------------------------------------------------------
CREATE TABLE content_ideas (
  idea_id TEXT PRIMARY KEY,
  source TEXT,
  payload TEXT NOT NULL,
  status TEXT DEFAULT 'backlog',
  created_at INTEGER,
  demand_score REAL
);

CREATE INDEX idx_content_ideas_status ON content_ideas (status, demand_score);

-- ---------------------------------------------------------------------------
-- Operational tables
-- ---------------------------------------------------------------------------

-- Every provider call and every failover (section 6). The monthly
-- signer-reliability-vs-paid-spend report reads from here.
CREATE TABLE provider_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  capability TEXT NOT NULL,
  outcome TEXT NOT NULL, -- success | failure | skipped_circuit_open | skipped_budget
  latency_ms INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  failover_from TEXT
);

CREATE INDEX idx_provider_events_time ON provider_events (occurred_at);
CREATE INDEX idx_provider_events_provider ON provider_events (provider, occurred_at);

-- AMBER Studio deep analytics (section 4.4): watch time, traffic sources, retention.
CREATE TABLE own_video_analytics (
  video_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  watch_time_seconds REAL,
  average_watch_time_seconds REAL,
  full_watch_rate REAL,
  traffic_sources TEXT, -- JSON array
  retention TEXT,       -- JSON array
  source TEXT NOT NULL DEFAULT 'studio',
  PRIMARY KEY (video_id, captured_at)
);

-- Lazy transcript cache (section 4.2 / capability 8).
CREATE TABLE transcripts (
  video_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  language TEXT,
  source TEXT NOT NULL, -- whisper | tiktok_caption | scrapebadger
  created_at INTEGER
);

-- Comment mining dedupe: one row per (idea, source video) so repeated runs
-- don't inflate demand scores.
CREATE TABLE idea_evidence (
  idea_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  matched_text TEXT,
  digg_count INTEGER,
  captured_at INTEGER,
  PRIMARY KEY (comment_id)
);

CREATE INDEX idx_idea_evidence_idea ON idea_evidence (idea_id);

-- Snapshot compaction for data older than 90 days (risk register).
CREATE TABLE daily_rollups (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  metric TEXT NOT NULL,
  min_value REAL,
  max_value REAL,
  avg_value REAL,
  last_value REAL,
  samples INTEGER,
  PRIMARY KEY (entity_type, entity_id, day, metric)
);
