import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

/**
 * A D1 stand-in backed by real SQLite with every migration applied, for tests
 * whose correctness lives in the SQL itself (status guards, halt windows).
 */
export function sqliteD1(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  const makeStatement = (sql: string, values: unknown[] = []): D1PreparedStatement =>
    ({
      bind: (...next: unknown[]) => makeStatement(sql, next),
      first: async () => (raw.prepare(sql).get(...(values as never[])) as unknown) ?? null,
      all: async () => ({
        results: raw.prepare(sql).all(...(values as never[])),
        success: true,
        meta: {},
      }),
      run: async () => {
        const result = raw.prepare(sql).run(...(values as never[]));
        return { success: true, meta: { changes: Number(result.changes) }, results: [] };
      },
    }) as unknown as D1PreparedStatement;

  const db = {
    prepare: (sql: string) => makeStatement(sql),
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())),
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;

  return { db, raw };
}
