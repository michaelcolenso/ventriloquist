import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface SessionCustodyOptions {
  /** Path to the sealed session file (age-encrypted by default). */
  sessionFile: string;
  /** age identity, e.g. `age -d -i /etc/ventriloquist/posting.key`. */
  decryptCommand?: string;
  /** Local-development escape hatch: read the file as plain JSON. */
  allowPlaintext?: boolean;
}

/**
 * Session custody (spec 7.5): posting cookies live in one encrypted file on the
 * VPS, decrypted with a key from the environment, and never touch D1, the
 * Worker, or the logs.
 *
 * `decryptCommand` shells out to `age`, so key material stays in the process
 * environment / key file rather than in this codebase.
 */
export async function loadPostingCookies(options: SessionCustodyOptions): Promise<SessionCookie[]> {
  let raw: string;
  if (options.decryptCommand) {
    const { stdout } = await run(
      "/bin/sh",
      ["-c", `${options.decryptCommand} < "${options.sessionFile}"`],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    raw = stdout;
  } else if (options.allowPlaintext) {
    raw = await readFile(options.sessionFile, "utf8");
  } else {
    throw new Error(
      "refusing to read the posting session without a decrypt command: set POSTING_SESSION_AGE_CMD, or POSTING_SESSION_PLAINTEXT=1 for local development",
    );
  }

  const parsed = JSON.parse(raw) as unknown;
  const cookies = Array.isArray(parsed) ? parsed : (parsed as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) throw new Error("session file must contain a cookie array");

  return cookies.map((cookie) => {
    const entry = cookie as Partial<SessionCookie>;
    if (typeof entry.name !== "string" || typeof entry.value !== "string") {
      throw new Error("session cookie entries need name and value");
    }
    return {
      name: entry.name,
      value: entry.value,
      domain: entry.domain ?? ".tiktok.com",
      path: entry.path ?? "/",
      ...(entry.expires !== undefined ? { expires: entry.expires } : {}),
      ...(entry.httpOnly !== undefined ? { httpOnly: entry.httpOnly } : {}),
      ...(entry.secure !== undefined ? { secure: entry.secure } : {}),
      ...(entry.sameSite !== undefined ? { sameSite: entry.sameSite } : {}),
    };
  });
}

/** Never log cookie values: this is the only shape that is safe to emit. */
export function describeSession(cookies: SessionCookie[]): {
  cookie_count: number;
  names: string[];
  has_sessionid: boolean;
} {
  return {
    cookie_count: cookies.length,
    names: cookies.map((cookie) => cookie.name),
    has_sessionid: cookies.some((cookie) => cookie.name === "sessionid"),
  };
}
