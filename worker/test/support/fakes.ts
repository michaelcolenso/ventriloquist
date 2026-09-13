/** Minimal in-memory stand-ins for the Cloudflare bindings the core uses. */

export function fakeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string, type?: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      if (type === "json") return JSON.parse(value);
      return value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true, cacheStatus: null };
    },
    async getWithMetadata() {
      return { value: null, metadata: null, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

export interface D1Responder {
  (sql: string): { first?: unknown; all?: unknown[]; run?: unknown };
}

export function fakeD1(responder: D1Responder): D1Database {
  const makeStatement = (sql: string): D1PreparedStatement =>
    ({
      bind: (..._values: unknown[]) => makeStatement(sql),
      first: async () => responder(sql).first ?? null,
      all: async () => ({ results: responder(sql).all ?? [], success: true, meta: {} }),
      run: async () => ({
        success: true,
        meta: { changes: 1 },
        results: responder(sql).run ?? [],
      }),
      raw: async () => [],
    }) as unknown as D1PreparedStatement;

  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: async (statements: D1PreparedStatement[]) => statements.map(() => ({ success: true })),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

export function fakeR2(objects: Record<string, { size: number }> = {}): R2Bucket {
  return {
    async head(key: string) {
      const object = objects[key];
      return object ? ({ key, size: object.size, etag: "fake" } as unknown as R2Object) : null;
    },
  } as unknown as R2Bucket;
}

export function fakeQueue(): { binding: Queue<unknown>; sent: unknown[] } {
  const sent: unknown[] = [];
  const binding = {
    async send(message: unknown) {
      sent.push(message);
    },
    async sendBatch(messages: { body: unknown }[]) {
      for (const message of messages) sent.push(message.body);
    },
  } as unknown as Queue<unknown>;
  return { binding, sent };
}

export function fakeEnv(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const queue = fakeQueue();
  return {
    DB: fakeD1(() => ({})),
    KV: fakeKV(),
    MEDIA: fakeR2(),
    POSTING_QUEUE: queue.binding,
    DEFAULT_REGION: "US",
    OWN_ACCOUNT_HANDLE: "nobodynamed",
    ...overrides,
  };
}

/** Captures provider events instead of writing them to D1. */
export function eventCollector(): { events: import("../../src/backends/types").ProviderEvent[] } {
  return { events: [] };
}
