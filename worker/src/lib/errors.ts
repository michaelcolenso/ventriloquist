export class VentriloquistError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "VentriloquistError";
    this.code = code;
    this.details = details;
  }
}

/**
 * A backend call failed.
 *
 * `countsTowardBreaker` is false for caller-caused failures (bad video id,
 * malformed handle): those are recorded for the cost ledger but must not
 * trip the circuit breaker, or a single bad request would take the signer
 * offline for every other caller.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly capability: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly countsTowardBreaker: boolean;

  constructor(
    provider: string,
    capability: string,
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      countsTowardBreaker?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.capability = capability;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? true;
    this.countsTowardBreaker = options.countsTowardBreaker ?? (options.retryable ?? true);
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class BudgetExceededError extends VentriloquistError {
  constructor(message: string) {
    super("budget_exceeded", message);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
