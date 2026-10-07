// Run inside the signer container to see how the browser reaches TikTok:
//   docker exec -i -w /app signer node --input-type=module < signer/scripts/diagnose.mjs
// Pass -e DIAG_URL=https://www.tiktok.com/@tiktok to load another page, and
// -e DIAG_PATH=/api/user/detail/ to print the full parameter set of one API path.
// Uses the container's SIGNER_PROXY_URL. Prints proxy host, cookie NAMES and
// parameter counts only, never credentials or cookie values.
import puppeteer from "puppeteer-core";

const UA =
  process.env.SIGNER_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const raw = process.env.SIGNER_PROXY_URL;
const proxy = raw ? new URL(raw) : null;
const args = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  `--user-agent=${UA}`,
];
if (proxy) args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`);

const PAGE = process.env.DIAG_URL ?? "https://www.tiktok.com/tag/babynames";
const WATCH = process.env.DIAG_PATH ?? "";
// Parameters that describe the browser, not the person: safe to show values for.
const SAFE = new Set([
  "aid", "app_language", "app_name", "browser_language", "browser_name", "browser_online",
  "browser_platform", "browser_version", "channel", "cookie_enabled", "data_collection_enabled",
  "device_platform", "focus_state", "from_page", "history_len", "is_fullscreen", "is_page_visible",
  "language", "os", "priority_region", "region", "screen_height", "screen_width", "tz_name",
  "user_is_login", "webcast_language", "coverFormat", "count", "cursor", "secUid", "uniqueId",
  "keyword", "itemId", "challengeID", "challengeName", "musicId", "aweme_id", "from_page",
]);
const report = { proxy: proxy ? proxy.host : null, failed_requests: [], requests: [] };
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args });
try {
  const page = await browser.newPage();
  if (proxy?.username) {
    await page.authenticate({
      username: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password),
    });
  }
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  page.on("requestfailed", (req) => {
    if (report.failed_requests.length < 8) {
      report.failed_requests.push({ host: new URL(req.url()).host, error: req.failure()?.errorText });
    }
  });
  page.on("response", async (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith("/api/") || report.requests.length >= 20) return;
    let bytes = -1;
    try {
      bytes = (await res.text()).length;
    } catch {
      /* body not available */
    }
    const entry = { path: u.pathname, status: res.status(), bytes, n_params: [...u.searchParams.keys()].length };
    if (WATCH && u.pathname === WATCH) {
      entry.params = Object.fromEntries(
        [...u.searchParams.entries()].map(([key, value]) => [key, SAFE.has(key) ? value : `<${value.length} chars>`]),
      );
    }
    report.requests.push(entry);
  });

  const started = Date.now();
  try {
    const response = await page.goto(PAGE, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    report.goto = { ok: true, status: response?.status() ?? null };
  } catch (error) {
    report.goto = { ok: false, error: String(error).slice(0, 300) };
  }
  report.goto_ms = Date.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  report.page_url_host = (() => {
    try {
      return new URL(page.url()).host || page.url().slice(0, 40);
    } catch {
      return page.url().slice(0, 40);
    }
  })();

  try {
    report.info = await page.evaluate(async () => {
      const out = { title: document.title, has_acrawler: Boolean(window.byted_acrawler) };
      out.fetch_native = /\[native code\]/.test(Function.prototype.toString.call(window.fetch));
      out.cookie_names = document.cookie.split(";").map((c) => c.trim().split("=")[0]);
      try {
        const r = await fetch("/api/challenge/detail/?challengeName=babynames&aid=1988", { credentials: "include" });
        out.minimal_fetch = { status: r.status, bytes: (await r.text()).length };
      } catch (e) {
        out.minimal_fetch = String(e);
      }
      return out;
    });
  } catch (error) {
    report.info_error = String(error).slice(0, 200);
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 1));
