#!/usr/bin/env node
/**
 * Seed the shadow cohort (spec 12.4: the 50-account curation pass).
 *
 * Usage:
 *   node scripts/seed-cohort.mjs accounts.json
 *   node scripts/seed-cohort.mjs --facade http://127.0.0.1:8787 accounts.json
 *
 * accounts.json is either an array of handles or an array of
 * `{ username, niche, follower_count }` objects.
 */
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const facadeIndex = args.indexOf("--facade");
const facade = facadeIndex >= 0 ? args[facadeIndex + 1] : "http://127.0.0.1:8787";
const file = args.find((arg, index) => !arg.startsWith("--") && index !== facadeIndex + 1);

if (!file) {
  console.error("usage: node scripts/seed-cohort.mjs [--facade <url>] <accounts.json>");
  process.exit(1);
}

const raw = JSON.parse(await readFile(file, "utf8"));
const accounts = (Array.isArray(raw) ? raw : raw.accounts).map((entry) =>
  typeof entry === "string"
    ? { username: entry.replace(/^@/, "") }
    : { ...entry, username: String(entry.username).replace(/^@/, "") },
);

const response = await fetch(`${facade.replace(/\/$/, "")}/admin/cohort`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ accounts }),
});

const body = await response.json();
if (!response.ok) {
  console.error(`seed failed: HTTP ${response.status}`, body);
  process.exit(1);
}
console.log(`added ${body.added} account(s); cohort size is now ${body.cohort_size}`);
if ((body.cohort_size ?? 0) < 50) {
  console.log(`note: ${50 - body.cohort_size} more accounts to reach the spec target of 50`);
}
