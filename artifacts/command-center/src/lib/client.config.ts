/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                CLIENT CONFIGURATION — REBRAND HERE           ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Edit this file (and its API-server counterpart) when deploying for
 * a new client. See README-template.md § "Rebranding" for the full
 * checklist, including which values are shared with the API server
 * and must be kept in sync.
 *
 * After updating these values:
 *   1. Replace public/favicon.ico and src/assets/logo.png with the
 *      new client's logo.
 *
 * The browser tab title, meta tags, and brand primary color are all
 * injected automatically from this file at build time — no manual
 * edits to index.html or index.css are needed.
 */
export const CLIENT = {
  /** Full legal / display business name */
  businessName: 'MogulForge',

  /** Short name used in nav bars and compact UI elements */
  businessShortName: 'MogulForge',

  /** Application title shown in the browser tab and meta tags */
  appName: 'MogulForge Growth OS',

  /**
   * Brand primary color — hex, for reference / design tools.
   * MogulForge violet.
   */
  primaryColor: '#6D28D9',

  /**
   * Brand primary color as an HSL triple (space-separated, no commas),
   * used to set the CSS --primary variable injected at build time.
   *
   * Light-mode value. If you change primaryColor above, update this
   * to match. Tip: most design tools show HSL — use the "H S% L%"
   * values (without the % signs), e.g. "263 70% 50%".
   */
  primaryHsl: '263 70% 50%',

  /**
   * Dark-mode variant of the primary color (typically the same hue
   * and saturation, but a higher lightness so it reads on dark bg).
   */
  primaryHslDark: '263 85% 68%',

  /** Business phone number (display format, used in message templates) */
  phone: '(555) 010-0000',

  /** IANA timezone identifier for this business */
  timezone: 'America/New_York',
} as const;
