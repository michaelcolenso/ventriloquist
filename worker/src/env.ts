export interface Env {
  // Bindings (see wrangler.toml)
  DB: D1Database;
  KV: KVNamespace;
  MEDIA: R2Bucket;
  POSTING_QUEUE: Queue;

  // Secrets / vars
  SIGNER_GATEWAY_URL?: string;
  SIGNER_GATEWAY_TOKEN?: string;
  SCRAPEBADGER_API_KEY?: string;
  /** Override for tests/local mocks; defaults to the vendor's production host. */
  SCRAPEBADGER_BASE_URL?: string;
  SCRAPECREATORS_API_KEY?: string;
  DAILY_PAID_BUDGET_USD?: string;
  SCRAPEBADGER_USD_PER_CALL?: string;
  MCP_AUTH_TOKEN?: string;
  DEFAULT_REGION?: string;
  OWN_ACCOUNT_HANDLE?: string;
  POSTING_WORKER_URL?: string;
  POSTING_WORKER_TOKEN?: string;
  /** Override for tests/local mocks; defaults to TikTok's Creative Center host. */
  CREATIVE_CENTER_BASE_URL?: string;
  PROVIDER_FAILURE_THRESHOLD?: string;
  PROVIDER_COOLDOWN_SECONDS?: string;
  /** Hard ceiling on a single provider attempt, in milliseconds. */
  PROVIDER_TIMEOUT_MS?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
