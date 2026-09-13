import { createServer } from "./server";
import { SignerPool, type PoolHealth, type SignOutcome, type Signer } from "./pagePool";

const PORT = Number(process.env.PORT ?? 8788);
const TOKEN = process.env.SIGNER_TOKEN ?? "";
const MOCK = process.env.MOCK === "1" || process.env.MOCK === "true";
const HEADLESS = process.env.SIGNER_HEADLESS !== "0";
const POOL_SIZE = Number(process.env.SIGNER_PAGE_POOL_SIZE ?? 2);
const TIMEOUT_MS = Number(process.env.SIGNER_TIMEOUT_MS ?? 20_000);
const EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/chromium";
const USER_AGENT =
  process.env.SIGNER_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** In mock mode the gateway never launches Chromium. */
const mockSigner: Signer = {
  async sign(): Promise<SignOutcome> {
    throw new Error("mock mode serves fixtures through /sign and /mock/* before reaching the pool");
  },
  async health(): Promise<PoolHealth> {
    return { ok: true, poolSize: 0, ready: 0, detail: "mock mode" };
  },
};

const pool = new SignerPool({
  executablePath: EXECUTABLE_PATH,
  poolSize: POOL_SIZE,
  headless: HEADLESS,
  userAgent: USER_AGENT,
  timeoutMs: TIMEOUT_MS,
});

const app = createServer({ signer: MOCK ? mockSigner : pool, token: TOKEN, mock: MOCK });

async function bootstrap(): Promise<void> {
  if (!MOCK) {
    try {
      await pool.start();
    } catch (error) {
      app.log.error({ err: error }, "failed to start the signer browser pool");
    }
  }
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(
    { port: PORT, mock: MOCK, poolSize: POOL_SIZE, headless: HEADLESS },
    "ventriloquist signer gateway up",
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await pool.stop();
      process.exit(0);
    })();
  });
}

void bootstrap();
