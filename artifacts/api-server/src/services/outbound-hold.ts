/**
 * Staging safety hold. This is a guard at the actual provider dispatch points,
 * not a mock success: attempted sends fail and retain their ordinary failure
 * or review evidence. Production retains its existing behavior when unset.
 */
export function isStagingEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.FLY_APP_NAME === "mogulforge-growthos-staging" ||
    env.APP_ORIGIN === "https://mogulforge-growthos-staging.fly.dev"
  );
}

export function outboundDeliveryHeld(
  value = process.env.GROWTHOS_OUTBOUND_HOLD,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (value !== undefined && value !== "true" && value !== "false")
    throw new Error(
      'GROWTHOS_OUTBOUND_HOLD must be "true" or "false" when set',
    );
  // A missing/overridden hold flag alone must never enable staging sends.
  if (
    isStagingEnvironment(env) &&
    (value !== "false" || env.STAGING_OUTBOUND_APPROVED !== "true")
  )
    return true;
  return value === "true";
}

/**
 * Exact single-mailbox matches only. An empty or malformed staging allowlist
 * closes the whole email gate; wildcards, domains, display names and mailbox
 * lists cannot authorize a recipient. Never log the allowlist or recipient.
 */
export function assertStagingEmailRecipientAllowed(
  recipient: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isStagingEnvironment(env)) return;
  const mailboxes = (env.STAGING_EMAIL_RECIPIENT_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim());
  const singleMailbox = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  if (
    mailboxes.length > 20 ||
    mailboxes.some((value) => !singleMailbox.test(value))
  ) {
    throw new Error(
      "Staging email requires STAGING_EMAIL_RECIPIENT_ALLOWLIST with exact approved mailboxes",
    );
  }
  if (
    !recipient ||
    !singleMailbox.test(recipient) ||
    !mailboxes.some((value) => value.toLowerCase() === recipient.toLowerCase())
  ) {
    throw new Error("Email recipient is not approved for staging delivery");
  }
}

export function assertOutboundDeliveryAllowed(input?: {
  channel: "email";
  recipient: string;
}): void {
  if (outboundDeliveryHeld())
    throw new Error("Outbound delivery is disabled by the staging safety hold");
  if (input?.channel === "email")
    assertStagingEmailRecipientAllowed(input.recipient);
}
