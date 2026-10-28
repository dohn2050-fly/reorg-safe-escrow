export class AllProvidersFailedError extends Error {
  override readonly name = "AllProvidersFailedError";
  constructor(
    public readonly label: string,
    public readonly failures: Array<{ url: string; error: unknown }>,
  ) {
    super(
      `all providers failed for ${label}: ` +
        failures.map((f) => `${f.url} -> ${errorMessage(f.error)}`).join("; "),
    );
  }
}

export class NoProvidersAvailableError extends Error {
  override readonly name = "NoProvidersAvailableError";
  constructor(label: string) {
    super(`no providers available for ${label}`);
  }
}

/** A provider returned data that contradicts the chain view confirmed by the quorum. */
export class InconsistentProviderDataError extends Error {
  override readonly name = "InconsistentProviderDataError";
  constructor(
    public readonly url: string,
    message: string,
  ) {
    super(`${url}: ${message}`);
  }
}

/** The canonical chain diverged below a block we had already treated as final. */
export class FinalityViolationError extends Error {
  override readonly name = "FinalityViolationError";
  constructor(
    public readonly finalized: bigint,
    public readonly divergedAt: bigint,
  ) {
    super(
      `canonical chain diverged at block ${divergedAt}, at or below finalized block ${finalized}. ` +
        `Refusing to roll back finalized data; increase CONFIRMATIONS and resync.`,
    );
  }
}

/** Events arrived in an order the escrow state machine does not allow (missing history or bad data). */
export class ProjectionError extends Error {
  override readonly name = "ProjectionError";
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message.split("\n")[0] ?? e.message;
  return String(e);
}
