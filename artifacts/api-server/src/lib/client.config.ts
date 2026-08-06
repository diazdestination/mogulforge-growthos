/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                CLIENT CONFIGURATION — REBRAND HERE           ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Default values seeded into a fresh database and used as fallbacks
 * in outbound messages when org-level settings haven't been configured
 * yet. Update these before deploying for a new client.
 *
 * Note: once an org record exists in the database, these values are
 * only used as fallbacks. The real values live in the database and
 * are editable from the CRM Settings page.
 */
export const CLIENT = {
  /**
   * Default organization name seeded on first boot.
   * Also used as a fallback in outbound messages when the org
   * settings haven't loaded.
   */
  defaultOrgName: 'MogulForge',

  /**
   * URL-safe slug for the default org.
   * Must be lowercase letters, numbers, and hyphens only.
   * Used as the database key — changing this after first boot
   * requires a manual DB migration.
   */
  defaultOrgSlug: 'mogulforge',

  /**
   * Short business name used in fallback email/SMS copy when the
   * org's full business name isn't available.
   */
  businessShortName: 'MogulForge',

  /**
   * Name of the AI concierge shown in the public-facing chat widget.
   */
  aiAssistantName: 'Forge Assistant',

  /**
   * Fallback phone number used in OG share cards before org settings are
   * configured. TODO: set to your business phone (or edit in Settings).
   */
  phone: '(555) 010-0000',

  /**
   * Opening greeting sent by the AI concierge at the start of every chat.
   * Keep it warm, brand-appropriate, and under ~160 characters so it fits
   * in a single SMS if the widget is running in SMS mode.
   */
  aiGreeting:
    "Hi, I'm Forge — your MogulForge assistant. Tell me what you need and I'll get you to the right help in about a minute.",
} as const;
