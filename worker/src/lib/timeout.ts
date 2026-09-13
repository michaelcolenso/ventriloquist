/**
 * Provider calls must be bounded.
 *
 * A backend that accepts a TCP connection and then never answers would
 * otherwise hang the caller's tool call forever. The router applies this
 * timeout to every attempt, and a timeout counts as a provider failure (which
 * is what trips the breaker and cascades to the next backend).
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

export function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
