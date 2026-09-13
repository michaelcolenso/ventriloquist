type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(
  minLevel: Level,
  level: Level,
  bindings: Record<string, unknown>,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = JSON.stringify({
    level,
    msg: message,
    ts: new Date().toISOString(),
    ...bindings,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(
  minLevel: Level = "info",
  bindings: Record<string, unknown> = {},
): Logger {
  return {
    debug: (message, fields) => emit(minLevel, "debug", bindings, message, fields),
    info: (message, fields) => emit(minLevel, "info", bindings, message, fields),
    warn: (message, fields) => emit(minLevel, "warn", bindings, message, fields),
    error: (message, fields) => emit(minLevel, "error", bindings, message, fields),
    child: (extra) => createLogger(minLevel, { ...bindings, ...extra }),
  };
}
