#!/usr/bin/env node
/**
 * Draft the 50-account shadow cohort (spec 12.4) from live public data.
 *
 * This does not invent handles: it searches each seeded niche hashtag through
 * the facade, aggregates the authors that actually surface, and writes a
 * reviewable draft. Edit the file, then seed it with:
 *
 *   node scripts/seed-cohort.mjs cohort-draft.json
 *
 * Usage: node scripts/draft-cohort.mjs [--facade URL] [--out FILE]
 *        [--per-niche N] [--target N] [--hashtags-per-niche N] [--no-profiles]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_SQL = path.join(ROOT, "worker", "migrations", "0002_seed_cohort.sql");
const OWN_HANDLE = process.env.OWN_ACCOUNT_HANDLE ?? "nobodynamed";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const facade = String(flag("facade", "http://127.0.0.1:8787")).replace(/\/$/, "");
const outFile = path.resolve(ROOT, String(flag("out", "cohort-draft.json")));
const perNiche = Number(flag("per-niche", 5));
const target = Number(flag("target", 50));
const hashtagsPerNiche = Number(flag("hashtags-per-niche", 3));
const withProfiles = !args.includes("--no-profiles");

let requestId = 1;
async function callTool(name, toolArgs = {}) {
  const response = await fetch(`${facade}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(process.env.MCP_AUTH_TOKEN ? { authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId++,
      method: "tools/call",
      params: { name, arguments: toolArgs },
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${name} HTTP ${response.status}: ${text.slice(0, 200)}`);
  const payload = JSON.parse(text);
  if (payload.error) throw new Error(`MCP ${name} error: ${JSON.stringify(payload.error)}`);
  if (payload.result?.isError) throw new Error(`MCP ${name} failed: ${text.slice(0, 200)}`);
  return payload.result?.structuredContent ?? null;
}

async function seedsByNiche() {
  const sql = await readFile(SEED_SQL, "utf8");
  const grouped = new Map();
  for (const match of sql.matchAll(/\('hashtag',\s*'([^']+)',\s*'([^']+)'/g)) {
    const [, hashtag, niche] = match;
    if (!grouped.has(niche)) grouped.set(niche, []);
    grouped.get(niche).push(hashtag);
  }
  return grouped;
}

async function main() {
  const grouped = await seedsByNiche();
  const candidates = new Map();
  const failures = [];

  for (const [niche, hashtags] of grouped) {
    for (const hashtag of hashtags.slice(0, hashtagsPerNiche)) {
      try {
        const data = await callTool("tt_search_videos", { query: hashtag, count: 20 });
        for (const video of data?.videos ?? []) {
          const author = String(video.author ?? "").replace(/^@/, "").toLowerCase();
          if (!author || author === OWN_HANDLE.toLowerCase()) continue;
          const entry = candidates.get(author) ?? {
            username: author,
            niche,
            appearances: 0,
            total_plays: 0,
            sample_video: video.url ?? null,
          };
          entry.appearances += 1;
          entry.total_plays += Number(video.plays ?? 0);
          if (!entry.sample_video && video.url) entry.sample_video = video.url;
          candidates.set(author, entry);
        }
        console.log(`  ${niche}/${hashtag}: ${data?.videos?.length ?? 0} videos`);
      } catch (error) {
        failures.push(`${niche}/${hashtag}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  const ranked = [...candidates.values()].sort((a, b) => b.total_plays - a.total_plays);
  const perNicheCounts = new Map();
  const selected = [];
  for (const entry of ranked) {
    const used = perNicheCounts.get(entry.niche) ?? 0;
    if (used >= perNiche) continue;
    perNicheCounts.set(entry.niche, used + 1);
    selected.push(entry);
    if (selected.length >= target) break;
  }
  for (const entry of ranked) {
    if (selected.length >= target) break;
    if (!selected.includes(entry)) selected.push(entry);
  }

  if (withProfiles) {
    for (const entry of selected) {
      try {
        const data = await callTool("tt_profile", {
          username: entry.username,
          include_videos: false,
          video_count: 0,
        });
        entry.follower_count = data?.profile?.followers ?? null;
      } catch {
        entry.follower_count = null;
      }
    }
  }

  const draft = {
    generated_at: new Date().toISOString(),
    source: { facade, niches: [...grouped.keys()], candidates_seen: candidates.size, failures },
    accounts: selected.map((entry) => ({
      username: entry.username,
      niche: entry.niche,
      follower_count: entry.follower_count ?? null,
      total_plays: entry.total_plays,
      sample_video: entry.sample_video,
    })),
  };
  await writeFile(outFile, `${JSON.stringify(draft, null, 2)}\n`, "utf8");

  console.log(`\n${selected.length} candidate accounts written to ${path.relative(ROOT, outFile)}`);
  console.log("Review and edit the list, then seed it:");
  console.log(`  node scripts/seed-cohort.mjs ${path.relative(ROOT, outFile)}`);
  if (failures.length > 0) {
    console.warn(`${failures.length} search call(s) failed; see the failures array in the draft.`);
  }
  if (selected.length < target) {
    console.warn(
      `Only ${selected.length}/${target} candidates found. Re-run after more snapshots accumulate or add handles by hand.`,
    );
  }
}

main().catch((error) => {
  console.error(`draft-cohort failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
