/** Normalize equivalent Node/Express address forms for rate limits and audit. */
export function normalizeIpAddress(value: string | undefined | null): string {
  if (!value) return "unknown";
  const trimmed = value.trim();
  if (trimmed === "::1") return "127.0.0.1";
  if (trimmed.toLowerCase().startsWith("::ffff:")) return trimmed.slice(7);
  return trimmed;
}
