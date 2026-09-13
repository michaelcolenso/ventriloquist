import puppeteer, { type Browser, type Page } from "puppeteer-core";

export interface SignerPoolOptions {
  executablePath: string;
  poolSize: number;
  headless: boolean;
  userAgent: string;
  timeoutMs: number;
  /** Page loaded once per worker so TikTok's own web SDK + cookies are live. */
  warmupUrl?: string;
}

export interface SignedResult {
  mode: "signed";
  url: string;
  headers: Record<string, string>;
  expiresAt: number | null;
  strategy: string;
}

export interface InPageResult {
  mode: "in_page";
  status: number;
  body: string;
  contentType: string | null;
  strategy: string;
}

export type SignOutcome = SignedResult | InPageResult;

export interface PoolHealth {
  ok: boolean;
  poolSize: number;
  ready: number;
  detail: string | null;
}

export interface Signer {
  sign(url: string): Promise<SignOutcome>;
  health(): Promise<PoolHealth>;
}

interface Slot {
  page: Page;
  busy: boolean;
}

/**
 * A small pool of headless Chromium pages with TikTok's own web SDK loaded.
 *
 * Two strategies, tried in order, because the signer is the fragile part of
 * the whole system (spec section 3: "signing is an arms race"):
 *
 *  1. `signed`   - call whatever the page's SDK exposes (`byted_acrawler.
 *                  frontierSign` / `.sign`), append the returned signature
 *                  params plus msToken, and hand back a URL any HTTP client
 *                  can fetch.
 *  2. `in_page`  - if no callable signer exists (TikTok renamed or removed it),
 *                  perform the request from inside the warmed page instead.
 *                  The page already has the cookies and the SDK's own fetch
 *                  wrapper, so this keeps reads alive without patching code.
 *
 * Strategy 2 is why a signer rotation is a logging event, not an outage.
 */
export class SignerPool implements Signer {
  private readonly options: SignerPoolOptions;
  private browser: Browser | null = null;
  private slots: Slot[] = [];
  private starting: Promise<void> | null = null;
  private cursor = 0;
  private lastError: string | null = null;

  constructor(options: SignerPoolOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async launch(): Promise<void> {
    this.browser = await puppeteer.launch({
      executablePath: this.options.executablePath,
      headless: this.options.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        `--user-agent=${this.options.userAgent}`,
      ],
    });

    for (let index = 0; index < this.options.poolSize; index += 1) {
      const page = await this.browser.newPage();
      await page.setUserAgent(this.options.userAgent);
      await page.setViewport({ width: 1366, height: 900 });
      await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
      const warmup = this.options.warmupUrl ?? "https://www.tiktok.com/";
      try {
        await page.goto(warmup, { waitUntil: "domcontentloaded", timeout: this.options.timeoutMs });
        // Give the SDK bundle a moment to attach its signing globals.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      } catch (error) {
        this.lastError = `warmup failed: ${String(error)}`;
      }
      this.slots.push({ page, busy: false });
    }
  }

  async stop(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.slots = [];
  }

  async health(): Promise<PoolHealth> {
    if (!this.browser) {
      return {
        ok: false,
        poolSize: this.options.poolSize,
        ready: 0,
        detail: this.lastError ?? "browser not started",
      };
    }
    const ready = this.slots.filter((slot) => !slot.busy && !slot.page.isClosed()).length;
    return {
      ok: ready > 0,
      poolSize: this.options.poolSize,
      ready,
      detail: this.lastError,
    };
  }

  async sign(url: string): Promise<SignOutcome> {
    assertAllowedTarget(url);
    await this.start();
    const slot = await this.acquire();
    try {
      const outcome = await slot.page.evaluate(signOrFetchImpl, url);
      if (!outcome) throw new Error("page returned no signature result");
      return outcome as SignOutcome;
    } finally {
      slot.busy = false;
    }
  }

  private async acquire(): Promise<Slot> {
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      const open = this.slots.filter((slot) => !slot.busy && !slot.page.isClosed());
      if (open.length > 0) {
        const slot = open[this.cursor % open.length]!;
        this.cursor += 1;
        slot.busy = true;
        return slot;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("signer pool exhausted");
  }
}

/**
 * Runs inside the warmed TikTok page.
 *
 * Must not capture any outer scope: puppeteer serialises this function and
 * evaluates it in the page, where only browser globals exist.
 */
const signOrFetchImpl = async function (target: string) {
  const win = window as unknown as Record<string, any>;
  const url = new URL(target);
  const headers: Record<string, string> = {
    "user-agent": navigator.userAgent,
    referer: location.href,
    "accept-language": "en-US,en;q=0.9",
  };
  if (document.cookie) headers.cookie = document.cookie;

  const acrawler = win.byted_acrawler;
  const signer =
    acrawler && typeof acrawler.frontierSign === "function"
      ? { fn: acrawler.frontierSign.bind(acrawler), name: "byted_acrawler.frontierSign" }
      : acrawler && typeof acrawler.sign === "function"
        ? { fn: acrawler.sign.bind(acrawler), name: "byted_acrawler.sign" }
        : null;

  if (signer) {
    try {
      const raw = signer.fn({ url: target });
      const params = new URLSearchParams();
      if (typeof raw === "string") {
        if (raw.includes("=") && !raw.includes(" ")) {
          new URLSearchParams(raw).forEach((value, key) => params.set(key, value));
        } else if (raw.length > 0) {
          params.set("X-Bogus", raw);
        }
      } else if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (value === null || value === undefined) continue;
          const text = String(value);
          if (text.startsWith("http")) {
            const signed = new URL(text);
            signed.searchParams.forEach((paramValue, key) => params.set(key, paramValue));
          } else {
            params.set(key, text);
          }
        }
      }
      const msToken = /(?:^|;\s*)msToken=([^;]+)/.exec(document.cookie)?.[1];
      if (msToken && !params.has("msToken")) params.set("msToken", msToken);
      for (const [key, value] of params) url.searchParams.set(key, value);

      if (params.size > 0) {
        return {
          mode: "signed",
          url: url.toString(),
          headers,
          expiresAt: null,
          strategy: signer.name,
        };
      }
    } catch (error) {
      // fall through to the in-page fetch
      void error;
    }
  }

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: { accept: "application/json, text/plain, */*" },
  });
  const body = await response.text();
  return {
    mode: "in_page",
    status: response.status,
    body,
    contentType: response.headers.get("content-type"),
    strategy: signer ? `${signer.name} (unusable, in-page fetch)` : "in_page_fetch",
  };
};

/** Hosts the gateway is willing to touch. Keeps /sign from being an SSRF proxy. */
export const ALLOWED_HOST_SUFFIXES = [
  "tiktok.com",
  "tiktokcdn.com",
  "tiktokv.com",
  "ibytedtos.com",
  "byteoversea.com",
];

export function assertAllowedTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid url: ${rawUrl}`);
  }
  if (url.protocol !== "https:") throw new Error(`only https targets are allowed: ${url.protocol}`);
  const allowed = ALLOWED_HOST_SUFFIXES.some(
    (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
  );
  if (!allowed) throw new Error(`host not allowed: ${url.hostname}`);
  return url;
}
