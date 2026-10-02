/** Server-only final approval check; never serialized into a provider request. */
export interface EmailDispatchIdentity {
  provider: "gmail" | "microsoft";
  senderEmail: string;
}

export type EmailDispatchGuard = (identity: EmailDispatchIdentity) => Promise<void>;

export class EmailDispatchBlockedError extends Error {
  readonly code = "email_dispatch_blocked";
  readonly effectNotAttempted = true;
  constructor() {
    super("Email was not dispatched: the approved sender or current workflow permission changed. Review again.");
    this.name = "EmailDispatchBlockedError";
  }
}

export async function runEmailDispatchGuard(
  guard: EmailDispatchGuard | undefined,
  identity: EmailDispatchIdentity,
) {
  if (!guard) return;
  try {
    await guard(identity);
  } catch {
    // Do not leak callback errors that could contain customer or provider data.
    throw new EmailDispatchBlockedError();
  }
}
