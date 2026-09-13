import type { Env } from "../env";
import { createLogger, type Logger } from "../lib/logger";
import { buildBackends, type BackendBundle } from "../backends/providers";
import type { Capability } from "../types";
import type { ExecutionResult } from "../backends/types";
import { writeSnapshots } from "../storage/snapshots";
import type { TranscriptResult } from "../domain/models";
import { boundFetch } from "../lib/fetch";

export interface AppContext {
  env: Env;
  logger: Logger;
  now: number;
  region: string;
  fetcher: typeof fetch;
  waitUntil: (promise: Promise<unknown>) => void;
  backends: BackendBundle;
  /** Route a read through the backend abstraction layer. */
  route<T = unknown>(
    capability: Capability,
    params: Record<string, unknown>,
  ): Promise<ExecutionResult<T>>;
  /** Fire-and-forget snapshot writes (spec P3). */
  snapshot(statements: D1PreparedStatement[]): void;
  /** Fire-and-forget transcript cache write. */
  cacheTranscript(videoId: string, transcript: TranscriptResult): void;
  ownHandle(): string;
}

export interface ContextOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: number;
  region?: string;
  fetcher?: typeof fetch;
  logger?: Logger;
}

export function createAppContext(env: Env, options: ContextOptions = {}): AppContext {
  const logger = options.logger ?? createLogger("info", { app: "ventriloquist" });
  const fetcher = options.fetcher ?? boundFetch();
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const region = (options.region ?? env.DEFAULT_REGION ?? "US").toUpperCase();
  const waitUntil = options.waitUntil ?? ((promise: Promise<unknown>) => void promise.catch(() => {}));
  const backends = buildBackends(env, logger, { fetcher });

  const context: AppContext = {
    env,
    logger,
    now,
    region,
    fetcher,
    waitUntil,
    backends,
    async route<T>(capability: Capability, params: Record<string, unknown>) {
      return backends.registry.execute<T>(capability, params, {
        env,
        region,
        now,
        fetch: fetcher,
        logger,
      });
    },
    snapshot(statements) {
      if (statements.length === 0) return;
      waitUntil(
        writeSnapshots(env.DB, statements).catch((error) => {
          logger.warn("snapshot write failed", { error: String(error) });
        }),
      );
    },
    cacheTranscript(videoId, transcript) {
      waitUntil(
        env.DB.prepare(
          `INSERT INTO transcripts (video_id, text, language, source, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (video_id) DO UPDATE SET
             text = excluded.text,
             language = excluded.language,
             source = excluded.source,
             created_at = excluded.created_at`,
        )
          .bind(videoId, transcript.text, transcript.language, transcript.source, now)
          .run()
          .catch((error) => {
            logger.warn("transcript cache write failed", { videoId, error: String(error) });
          }),
      );
    },
    ownHandle() {
      return (env.OWN_ACCOUNT_HANDLE ?? "nobodynamed").replace(/^@/, "");
    },
  };

  return context;
}
