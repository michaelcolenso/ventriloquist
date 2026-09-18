#!/usr/bin/env node
/**
 * End-to-end smoke test (spec P7: "ship the smoke test first").
 *
 * Boots the signer gateway in MOCK=1 mode, boots the facade Worker on local
 * D1/KV/R2/Queues, then drives the real MCP endpoint exactly as an agent would:
 * initialize -> tools/list -> tools/call.
 *
 * It proves the read path for ~$0: routing, normalization, snapshotting,
 * velocity math, comment mining, posting validation, and the risk-tier
 * metadata all run for real.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(ROOT, "worker");
const SIGNER_DIR = path.join(ROOT, "signer");
const LOG_DIR = path.join(ROOT, ".smoke-logs");
// Hermetic local state: the smoke run must not inherit a tripped circuit
// breaker or a half-full D1 from a previous run.
const STATE_DIR = path.join(ROOT, ".wrangler-smoke");
const D1_FLAGS = ["--local", `--persist-to`, STATE_DIR];

// Resolve the workspace-local binaries rather than shelling out to `npx`.
//
// `npx <pkg>` only looks in the *current* directory's node_modules and then
// falls back to the npm registry, so this script used to stall for ~70s and
// die on any machine with no network egress: `wrangler` is installed in
// worker/node_modules and `tsx` in signer/node_modules, and neither is visible
// from the repo root. `pnpm install` already puts both on disk.
function localBin(pkg, dir) {
  const bin = path.join(dir, "node_modules", ".bin", pkg);
  if (!existsSync(bin)) {
    throw new Error(
      `${pkg} is not installed in ${path.relative(ROOT, dir) || "."}/node_modules - run \`pnpm install\` at the repo root first.`,
    );
  }
  return bin;
}

const WRANGLER = localBin("wrangler", WORKER_DIR);
const TSX = localBin("tsx", SIGNER_DIR);

const WORKER_PORT = Number(process.env.SMOKE_WORKER_PORT ?? 8787);
const SIGNER_PORT = Number(process.env.SMOKE_SIGNER_PORT ?? 8788);
// A second mock process plays the paid vendor and the public Creative Center
// endpoints, so killing the signer below is a real failover rather than the
// loss of every mock at once.
const VENDOR_PORT = Number(process.env.SMOKE_VENDOR_PORT ?? 8789);
const SIGNER_TOKEN = "smoke-token";
const ADMIN_TOKEN = "smoke-admin-token";
const CALLBACK_TOKEN = "smoke-callback-token";
const MCP_URL = `http://127.0.0.1:${WORKER_PORT}/mcp`;
const ADMIN_HEADERS = { authorization: `Bearer ${ADMIN_TOKEN}` };

const checks = [];
let failures = 0;

function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${ok || !detail ? "" : ` -> ${detail}`}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe", ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function start(command, args, options = {}) {
  // detached so the SIGTERM below reaches the whole process group: `wrangler
  // dev` spawns workerd (and esbuild) as children that would otherwise survive.
  const child = spawn(command, args, { stdio: "pipe", detached: true, ...options });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  return new Promise((resolve) => {
    const deadline = Date.now() + 4_000;
    const poll = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        clearInterval(poll);
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
        resolve();
      }
    }, 100);
  });
}

async function assertPortFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_500) });
    throw new Error(
      `port ${port} is already serving something. Stop the stale process (fuser -k ${port}/tcp) before running the smoke test.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("already serving")) throw error;
    // Connection refused is what we want.
  }
}

function forceFreePort(port) {
  try {
    spawnSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
  } catch {
    /* fuser is optional */
  }
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

let requestId = 1;
async function rpc(method, params) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} HTTP ${response.status}: ${text.slice(0, 400)}`);
  const payload = JSON.parse(text);
  if (payload.error) throw new Error(`MCP ${method} error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function notify(method, params) {
  await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
}

async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content?.map((entry) => entry.text).join("\n") ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return { data: result.structuredContent ?? null, text };
}

async function main() {
  await mkdir(LOG_DIR, { recursive: true });
  console.log("ventriloquist smoke test\n");

  await assertPortFree(WORKER_PORT);
  await assertPortFree(SIGNER_PORT);
  await assertPortFree(VENDOR_PORT);
  await rm(STATE_DIR, { recursive: true, force: true });

  console.log("preparing local D1…");
  await run(WRANGLER, ["d1", "migrations", "apply", "DB", ...D1_FLAGS], {
    cwd: WORKER_DIR,
  });
  // Seed three days of history so the velocity engine has something real to
  // classify (the crons produce this in production).
  const now = Math.floor(Date.now() / 1000);
  // 'ranking' is deliberately not in the mock Creative Center trend list, so
  // these seeded numbers are the only thing the velocity assertions read.
  const seedSql = [
    "DELETE FROM hashtag_snapshots WHERE hashtag = 'ranking';",
    `INSERT INTO hashtag_snapshots (hashtag, captured_at, view_count, post_count, source) VALUES
       ('ranking', ${now - 4 * 86_400}, 500000, 4200, 'signer'),
       ('ranking', ${now - 3 * 86_400}, 1000000, 5000, 'signer'),
       ('ranking', ${now - 2 * 86_400}, 3000000, 6200, 'signer'),
       ('ranking', ${now - 1 * 86_400}, 9000000, 8100, 'signer'),
       ('ranking', ${now - 3600}, 20000000, 11000, 'signer');`,
  ].join(" ");
  await run(
    WRANGLER,
    ["d1", "execute", "DB", ...D1_FLAGS, "--yes", "--command", seedSql],
    { cwd: WORKER_DIR },
  );

  console.log("writing worker/.dev.vars for mock mode…");
  await writeFile(
    path.join(WORKER_DIR, ".dev.vars"),
    [
      `SIGNER_GATEWAY_URL="http://127.0.0.1:${SIGNER_PORT}"`,
      `SIGNER_GATEWAY_TOKEN="${SIGNER_TOKEN}"`,
      `CREATIVE_CENTER_BASE_URL="http://127.0.0.1:${VENDOR_PORT}/mock/creative_center"`,
      `SCRAPEBADGER_API_KEY="smoke-key"`,
      `SCRAPEBADGER_BASE_URL="http://127.0.0.1:${VENDOR_PORT}/mock/scrapebadger"`,
      `SCRAPEBADGER_USD_PER_CALL="0.001"`,
      `OWN_ACCOUNT_HANDLE="nobodynamed"`,
      `DAILY_PAID_BUDGET_USD="3"`,
      `PROVIDER_TIMEOUT_MS="4000"`,
      `ADMIN_TOKEN="${ADMIN_TOKEN}"`,
      `FACADE_CALLBACK_TOKEN="${CALLBACK_TOKEN}"`,
      "",
    ].join("\n"),
    "utf8",
  );

  console.log("starting signer gateway (MOCK=1) and facade worker…");
  const signer = start(TSX, ["src/index.ts"], {
    cwd: SIGNER_DIR,
    env: { ...process.env, MOCK: "1", PORT: String(SIGNER_PORT), SIGNER_TOKEN },
  });
  const vendor = start(TSX, ["src/index.ts"], {
    cwd: SIGNER_DIR,
    env: { ...process.env, MOCK: "1", PORT: String(VENDOR_PORT), SIGNER_TOKEN },
  });
  const worker = start(
    WRANGLER,
    ["dev", "--port", String(WORKER_PORT), "--persist-to", STATE_DIR],
    { cwd: WORKER_DIR },
  );

  const stop = async () => {
    await Promise.all([stopChild(worker), stopChild(signer), stopChild(vendor)]);
    forceFreePort(WORKER_PORT);
    forceFreePort(SIGNER_PORT);
    forceFreePort(VENDOR_PORT);
  };
  process.on("exit", () => {
    forceFreePort(WORKER_PORT);
    forceFreePort(SIGNER_PORT);
    forceFreePort(VENDOR_PORT);
  });

  try {
    const signerHealth = await waitFor(`http://127.0.0.1:${SIGNER_PORT}/health`);
    check("signer gateway is healthy in mock mode", signerHealth.ok && signerHealth.mock === true);
    await waitFor(`http://127.0.0.1:${VENDOR_PORT}/health`);
    await waitFor(`http://127.0.0.1:${WORKER_PORT}/healthz`);
    check("facade worker is healthy", true);

    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.1.0" },
    });
    check(
      "MCP initialize returns server info",
      init?.serverInfo?.name === "ventriloquist",
      JSON.stringify(init?.serverInfo),
    );
    await notify("notifications/initialized", {});

    const list = await rpc("tools/list", {});
    const names = list.tools.map((tool) => tool.name);
    check(`tools/list exposes ${list.tools.length} tools`, list.tools.length === 20, `${list.tools.length}`);
    check("every tool is namespaced tt_*", names.every((name) => name.startsWith("tt_")));
    check(
      "every tool description carries a risk tier",
      list.tools.every((tool) => /\[(GREEN|AMBER|RED) ·/.test(tool.description ?? "")),
    );
    check(
      "RED tools warn about the posting cap",
      list.tools
        .filter((tool) => tool.name === "tt_queue_post" || tool.name === "tt_render_and_post")
        .every((tool) => tool.description.includes("5 posts/day")),
    );

    console.log("\nread path: trending (Creative Center mock)");
    const trending = await callTool("tt_trending_hashtags", { limit: 5 });
    check("tt_trending_hashtags returns rows", (trending.data?.hashtags ?? []).length === 5);
    check(
      "trending rows include rank and view counts",
      trending.data?.hashtags?.[0]?.rank === 1 && trending.data?.hashtags?.[0]?.views > 0,
    );

    console.log("read path: profile + videos (signer mock, in-page strategy)");
    const profile = await callTool("tt_profile", { username: "nobodynamed", video_count: 5 });
    check("tt_profile returns the account", profile.data?.profile?.username === "nobodynamed");
    check("tt_profile returns recent videos", (profile.data?.recent_videos ?? []).length === 5);
    check(
      "profile videos carry public metrics",
      (profile.data?.recent_videos?.[0]?.plays ?? 0) > 0,
    );

    const search = await callTool("tt_search_videos", { query: "baby names", count: 6 });
    check("tt_search_videos returns videos", (search.data?.videos ?? []).length === 6);

    console.log("\nvelocity engine over accumulated history");
    const momentum = await callTool("tt_hashtag_momentum", {
      hashtag: "ranking",
      window_days: 14,
      niche: "data-storytelling",
    });
    const metrics = momentum.data?.metrics ?? {};
    check("tt_hashtag_momentum reads accumulated snapshots", metrics.samples === 5, `samples=${metrics.samples}`);
    check("tt_hashtag_momentum classifies GROWTH", metrics.lifecycle === "GROWTH", metrics.lifecycle);
    check(
      "velocity + acceleration are computed",
      typeof metrics.velocity24h === "number" && typeof metrics.acceleration === "number",
    );
    check(
      "saturation is measured against the niche threshold",
      metrics.saturation > 0 && metrics.saturation < 1,
      String(metrics.saturation),
    );

    const emerging = await callTool("tt_emerging_in_niche", {
      niche_keywords: ["ranking", "charts"],
      limit: 5,
    });
    check(
      "tt_emerging_in_niche surfaces the accelerating hashtag",
      (emerging.data?.candidates ?? []).some((candidate) => candidate.entityId === "ranking"),
    );
    check(
      "emerging candidates explain themselves",
      typeof emerging.data?.candidates?.[0]?.reason === "string" &&
        emerging.data.candidates[0].reason.includes("growth"),
      emerging.data?.candidates?.[0]?.reason,
    );

    console.log("\ncomment mining over the mock comment stream");
    const videoId = search.data?.videos?.[0]?.video_id;
    const comments = await callTool("tt_video_comments", { video_id: videoId, count: 20 });
    check("tt_video_comments returns comments", (comments.data?.comments ?? []).length > 0);
    const ideas = await callTool("tt_mine_comment_ideas", { video_ids: [videoId], limit: 10 });
    check("tt_mine_comment_ideas produces ideas", (ideas.data?.ideas ?? []).length > 0);
    check(
      "ideas are ranked by demand score",
      (ideas.data?.ideas?.[0]?.demand_score ?? 0) > 0 &&
        (ideas.data?.ideas?.[0]?.demand_score ?? 0) >= (ideas.data?.ideas?.[1]?.demand_score ?? 0),
    );
    check(
      "the 'do Karen next' request is surfaced",
      JSON.stringify(ideas.data?.ideas ?? []).toLowerCase().includes("karen"),
    );
    const sentiment = await callTool("tt_comment_sentiment", { video_id: videoId });
    check(
      "tt_comment_sentiment aggregates a bucket",
      typeof sentiment.data?.sentiment?.score === "number",
    );

    console.log("\nposting path validation (RED, no side effects)");
    const rejected = await callTool("tt_queue_post", {
      video_r2_key: "renders/does-not-exist.mp4",
      caption: "smoke test",
      hashtags: ["babynames"],
    });
    check("tt_queue_post rejects a missing R2 object", rejected.data?.accepted === false);
    check(
      "rejection explains the R2 problem",
      (rejected.data?.errors ?? []).some((error) => /no R2 object/.test(error)),
      JSON.stringify(rejected.data?.errors),
    );
    const dryRun = await callTool("tt_render_and_post", {
      story: "kunta",
      caption: "smoke test render",
      hashtags: ["babynames"],
      dry_run: true,
    });
    check("tt_render_and_post dry run validates", dryRun.data?.accepted === true);

    console.log("\naccumulation + ops visibility");
    const status = await callTool("tt_system_status", {});
    const accumulation = status.data?.accumulation ?? {};
    check("snapshots accumulated from live reads", accumulation.video_snapshots > 0, JSON.stringify(accumulation));
    check("hashtag snapshots accumulated", accumulation.hashtag_snapshots >= 8, String(accumulation.hashtag_snapshots));
    check(
      "provider health is reported per backend",
      (status.data?.providers ?? []).length >= 2 &&
        status.data.providers.every((provider) => provider.capabilities.length > 0),
    );
    check(
      "budget is tracked in USD",
      typeof status.data?.budget?.spentUSD === "number" && status.data.budget.budgetUSD === 3,
    );
    check(
      "cohort gap is flagged",
      status.text.includes("cohort"),
      status.text.split("\n").filter((line) => line.includes("cohort")).join(" | "),
    );

    const anonymousAdmin = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/admin/ledger?days=1`,
    );
    check("admin routes reject anonymous callers", anonymousAdmin.status === 401);
    const anonymousCallback = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/admin/job-callback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_id: "smoke-forged", status: "posted" }),
      },
    );
    check("job callbacks reject forged reports", anonymousCallback.status === 401);
    check(
      "system status reports the auth/alert configuration",
      status.data?.configuration?.admin_auth_configured === true &&
        status.data?.configuration?.callback_auth_configured === true &&
        status.data?.configuration?.alerts_configured === false,
      JSON.stringify(status.data?.configuration),
    );

    const ledger = await fetch(`http://127.0.0.1:${WORKER_PORT}/admin/ledger?days=1`, {
      headers: ADMIN_HEADERS,
    }).then((r) => r.json());
    check("cost ledger recorded provider events", (ledger.reliability ?? []).length > 0);
    check(
      "free providers cost $0 in the ledger",
      ledger.reliability.some((row) => row.provider === "signer" && row.spendUSD === 0),
      JSON.stringify(ledger.reliability),
    );

    // Phase 1 exit criterion: "failover demonstrated by killing the signer".
    console.log("\nfailover: kill the self-hosted signer, watch the paid fallback take over");
    await stopChild(signer);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const postKill = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      postKill.push(await callTool("tt_profile", { username: "nobodyco", video_count: 3 }));
    }
    const firstCall = postKill[0];
    const afterKill = postKill.at(-1);
    check(
      "reads keep working after the signer dies",
      afterKill.data?.profile?.username === "nobodyco" &&
        afterKill.text.includes("@nobodyco"),
      afterKill.text.split("\n")[0],
    );
    check(
      "the first dead-signer call shows the signer->paid failover chain",
      firstCall.text.includes('"provider":"scrapebadger"') &&
        firstCall.text.includes('"failover":true') &&
        firstCall.text.includes('"attempt_chain":["signer","scrapebadger"]'),
      firstCall.text.split("\n").find((line) => line.startsWith("meta:")),
    );

    const tripped = await callTool("tt_system_status", {});
    const signerRow = (tripped.data?.providers ?? []).find((row) => row.provider === "signer");
    check(
      "three consecutive failures tripped the signer breaker",
      signerRow?.circuit_open === true && signerRow.consecutive_failures >= 3,
      JSON.stringify(signerRow),
    );

    const skipped = await callTool("tt_profile", { username: "nobodyco", video_count: 2 });
    check(
      "an open breaker skips the signer entirely",
      skipped.text.includes('"attempt_chain":["scrapebadger"]'),
      skipped.text.split("\n").find((line) => line.startsWith("meta:")),
    );

    const spend = await fetch(`http://127.0.0.1:${WORKER_PORT}/admin/ledger?days=1`, {
      headers: ADMIN_HEADERS,
    }).then((r) => r.json());
    const paidRow = (spend.reliability ?? []).find((row) => row.provider === "scrapebadger");
    const signerFailures = (spend.reliability ?? [])
      .filter((row) => row.provider === "signer")
      .reduce((total, row) => total + row.failures, 0);
    check(
      "paid fallback spend is tracked in the ledger",
      (paidRow?.spendUSD ?? 0) > 0,
      JSON.stringify(paidRow),
    );
    check(
      "signer failures are recorded for the monthly reliability report",
      signerFailures >= 3,
      `signer failure events: ${signerFailures}`,
    );
  } finally {
    await stop();
  }

  console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\nsmoke test crashed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
