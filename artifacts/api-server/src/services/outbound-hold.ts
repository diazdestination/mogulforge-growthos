/**
 * Staging safety hold. This is a guard at the actual provider dispatch points,
 * not a mock success: attempted sends fail and retain their ordinary failure
 * or review evidence. Production retains its existing behavior when unset.
 */
export function outboundDeliveryHeld(
  value = process.env.GROWTHOS_OUTBOUND_HOLD,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (value !== undefined && value !== "true" && value !== "false")
    throw new Error('GROWTHOS_OUTBOUND_HOLD must be "true" or "false" when set');
  const staging =
    env.FLY_APP_NAME === "mogulforge-growthos-staging" ||
    env.APP_ORIGIN === "https://mogulforge-growthos-staging.fly.dev";
  // A missing/overridden hold flag alone must never enable staging sends.
  if (staging && env.STAGING_OUTBOUND_APPROVED !== "true") return true;
  return value === "true";
}

export function assertOutboundDeliveryAllowed(): void {
  if (outboundDeliveryHeld())
    throw new Error("Outbound delivery is disabled by the staging safety hold");
}
