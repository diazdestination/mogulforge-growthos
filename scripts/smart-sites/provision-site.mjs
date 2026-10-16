#!/usr/bin/env node
/**
 * Create or verify one company's Smart Site record in GrowthOS, through the app's
 * own owner/admin API (the same routes the command center uses). Dry run by default.
 *
 *   GROWTHOS_OWNER_SESSION=<owner/admin session id> \
 *   node scripts/smart-sites/provision-site.mjs \
 *     --env local|staging|production --api <GrowthOS origin> \
 *     --company "<exact organization name>" --site-key <key> --site-name "<name>" \
 *     --profile roofing-exteriors|hvac|... --site-origin <exact website origin> \
 *     --analytics off|on [--retention-days 90] \
 *     [--apply] [--confirm-launch] [--rotate-key] [--stdout secret|env] \
 *     [--i-have-owner-approval]
 *
 * Output contract:
 *   - stdout: NOTHING unless a site secret was issued in this run; then exactly the
 *     secret (default) or GROWTHOS_SITE_ID=/GROWTHOS_SITE_SECRET= lines (--stdout env).
 *     Pipe it into the site's secret store. It is never written to disk.
 *   - stderr: a JSON plan/report (site ID, origin, capture/analytics state, blockers).
 *
 * The secret is shown once by GrowthOS. An existing site's secret cannot be
 * recovered; --rotate-key issues a new one (and pauses capture until re-enabled).
 */
import { pathToFileURL } from "node:url";
import {
  OperatorError,
  OWNER_APPROVAL_FLAG,
  apiClient,
  assertEnvironment,
  exactOrigin,
  parseFlags,
  report,
  requireEnvSecret,
} from "./common.mjs";

const FLAGS = {
  env: { choices: ["local", "staging", "production"], default: "local" },
  api: { default: "http://127.0.0.1:3001" },
  company: { required: true },
  "site-key": { required: true },
  "site-name": { required: true },
  profile: { required: true },
  "site-origin": { required: true },
  analytics: { choices: ["on", "off"], required: true },
  "retention-days": { default: "90" },
  stdout: { choices: ["secret", "env"], default: "secret" },
  apply: { type: "boolean" },
  "confirm-launch": { type: "boolean" },
  "rotate-key": { type: "boolean" },
  "i-have-owner-approval": { type: "boolean" },
  "allow-terminal-secret": { type: "boolean" },
};

export function parseProvisionArgs(argv) {
  const flags = parseFlags(argv, FLAGS);
  const api = exactOrigin(flags.api, "--api");
  const siteOrigin = exactOrigin(flags["site-origin"], "--site-origin");
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(flags["site-key"]))
    throw new OperatorError("invalid_flag", "--site-key must match ^[a-z0-9][a-z0-9-]{2,79}$");
  const retentionDays = Number(flags["retention-days"]);
  if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 365)
    throw new OperatorError("invalid_flag", "--retention-days must be an integer 30-365");
  if (flags.env !== "local" && new URL(siteOrigin).protocol !== "https:")
    throw new OperatorError("invalid_origin", "--site-origin must be https outside local");
  assertEnvironment({
    env: flags.env,
    api,
    ownerApproved: flags["i-have-owner-approval"] === true,
    labels: [
      ["--company", flags.company],
      ["--site-name", flags["site-name"]],
    ],
  });
  return {
    env: flags.env,
    api,
    company: flags.company,
    siteKey: flags["site-key"],
    siteName: flags["site-name"],
    profile: flags.profile,
    siteOrigin,
    analyticsEnabled: flags.analytics === "on",
    retentionDays,
    stdoutFormat: flags.stdout,
    apply: flags.apply === true,
    confirmLaunch: flags["confirm-launch"] === true,
    rotateKey: flags["rotate-key"] === true,
    allowTerminalSecret: flags["allow-terminal-secret"] === true,
  };
}

/**
 * @returns {Promise<{ exitCode: number, report: object }>}
 */
export async function provisionSite(
  options,
  { environment = process.env, fetchImpl = fetch, stdout = process.stdout, stderr = process.stderr } = {},
) {
  const session = requireEnvSecret(environment, "GROWTHOS_OWNER_SESSION");
  if (options.apply && stdout.isTTY && !options.allowTerminalSecret)
    throw new OperatorError(
      "secret_to_terminal",
      "stdout is a terminal. Pipe stdout into the site's secret store (or pass --allow-terminal-secret).",
    );
  const { call, expectOk } = apiClient(options.api, { fetchImpl, session });
  const out = {
    mode: options.apply ? "apply" : "dry-run",
    env: options.env,
    api: options.api,
    siteOrigin: options.siteOrigin,
    siteKey: options.siteKey,
    actions: [],
    secretIssued: false,
  };

  // 1. Who am I, and is this the named company?
  const me = await expectOk("Owner session check", "/me");
  if (!["owner", "admin"].includes(me.role))
    throw new OperatorError("owner_admin_required", `Session role ${me.role} cannot manage Smart Sites`);
  if (me.organization?.name !== options.company)
    throw new OperatorError(
      "company_mismatch",
      `Session belongs to "${me.organization?.name ?? "no organization"}", not "${options.company}"`,
    );
  out.organizationId = me.organization.id;

  // 2. Find or plan the site record.
  const profiles = await expectOk("Profile list", "/smart-sites/profiles");
  if (!profiles.some((p) => p.id === options.profile))
    throw new OperatorError("unknown_profile", `Unknown profile ${options.profile}`);
  const sites = await expectOk("Site list", "/smart-sites");
  let site = sites.find((s) => s.siteKey === options.siteKey) ?? null;
  if (site && site.profile !== options.profile)
    throw new OperatorError(
      "profile_mismatch",
      `Existing site ${site.id} uses profile ${site.profile}, not ${options.profile}; refusing to change it`,
    );
  out.actions.push(site ? "verify_existing_site" : "create_site");
  if (site && options.rotateKey) out.actions.push("rotate_key");
  const issuing = !site || options.rotateKey;
  if (issuing) out.actions.push("credential_check");
  // A new site starts with analytics off and 90-day retention.
  const current = site ?? { analyticsEnabled: false, analyticsRetentionDays: 90 };
  if (current.analyticsEnabled !== options.analyticsEnabled || current.analyticsRetentionDays !== options.retentionDays)
    out.actions.push(`set_analytics_${options.analyticsEnabled ? "on" : "off"}`);
  const willBeInactive = !site || options.rotateKey || !site.isActive;
  if (willBeInactive)
    out.actions.push(options.confirmLaunch ? "enable_capture" : "capture_left_off_needs_confirm_launch");
  if (site && !issuing)
    out.note =
      "Existing site: its secret cannot be shown again. Use --rotate-key to issue a new one (pauses capture until re-enabled).";

  if (!options.apply) {
    if (site) out.siteId = site.id;
    out.current = site
      ? { isActive: site.isActive, analyticsEnabled: site.analyticsEnabled, credentialVersion: site.credentialVersion }
      : null;
    const readiness = await expectOk("Launch readiness", "/smart-sites/launch-readiness");
    out.staffing = readiness.staffing;
    report(stderr, out);
    return { exitCode: 0, report: out };
  }

  // 3. Apply. Once a secret exists it is delivered even if a later step fails,
  //    because the previous one is already invalid.
  let secret;
  let failure;
  try {
    if (!site) {
      const created = await expectOk("Create site", "/smart-sites", {
        method: "POST",
        body: { name: options.siteName, siteKey: options.siteKey, profile: options.profile },
      });
      secret = created.secret;
      site = created;
    } else if (options.rotateKey) {
      const rotated = await expectOk("Rotate site key", `/smart-sites/${site.id}/rotate-key`, {
        method: "POST",
        body: {},
      });
      secret = rotated.secret;
      site = rotated;
    }
    out.siteId = site.id;
    if (secret) {
      out.secretIssued = true;
      await expectOk("Credential check", `/public/smart-sites/${site.id}/check`, {
        method: "POST",
        bearer: secret,
        body: { schemaVersion: 1 },
      });
    }
    if (site.analyticsEnabled !== options.analyticsEnabled || site.analyticsRetentionDays !== options.retentionDays)
      site = {
        ...site,
        ...(await expectOk("Analytics setting", `/smart-sites/${site.id}/measurement`, {
          method: "PATCH",
          body: { enabled: options.analyticsEnabled, retentionDays: options.retentionDays },
        })),
      };
    if (!site.isActive && options.confirmLaunch)
      site = {
        ...site,
        ...(await expectOk("Enable capture", `/smart-sites/${site.id}`, {
          method: "PATCH",
          body: { isActive: true, confirmedLaunch: true },
        })),
      };
  } catch (error) {
    failure = error;
  }

  // 4. Verify by reading back, not by trusting the write responses.
  if (out.siteId) {
    const after = (await call("/smart-sites")).data?.find?.((s) => s.id === out.siteId);
    const readiness = (await call("/smart-sites/launch-readiness")).data;
    out.final = after
      ? {
          isActive: after.isActive,
          analyticsEnabled: after.analyticsEnabled,
          analyticsRetentionDays: after.analyticsRetentionDays,
          analyticsPolicyVersion: after.analyticsPolicyVersion,
          credentialVersion: after.credentialVersion,
          credentialCheckedAt: after.credentialCheckedAt,
        }
      : null;
    out.blockers = readiness?.sites?.find?.((s) => s.id === out.siteId)?.blockers ?? null;
    out.staffing = readiness?.staffing ?? null;
    out.verified =
      !!after &&
      after.analyticsEnabled === options.analyticsEnabled &&
      (!options.confirmLaunch || after.isActive === true);
  }
  if (failure) {
    out.error = { code: failure.code ?? "unexpected", message: failure.message, ...(failure.details ?? {}) };
  }
  out.siteConfig = {
    GROWTHOS_API_ORIGIN: options.api,
    GROWTHOS_SITE_ID: out.siteId ?? null,
    GROWTHOS_SITE_SECRET: out.secretIssued ? "(stdout of this run only)" : "(unchanged; not recoverable)",
    SITE_PUBLIC_ORIGIN: options.siteOrigin,
  };
  out.originEnforcement =
    "GrowthOS stores no per-site origin (no schema change before cutover). Intake is server-to-server only and rejects browser Origin headers; the website worker pins GROWTHOS_API_ORIGIN, serves only SITE_PUBLIC_ORIGIN, and binds outbox rows to siteId|origin.";
  report(stderr, out);
  if (secret)
    stdout.write(
      options.stdoutFormat === "env"
        ? `GROWTHOS_SITE_ID=${out.siteId}\nGROWTHOS_SITE_SECRET=${secret}\n`
        : `${secret}\n`,
    );
  return { exitCode: failure || !out.verified ? 2 : 0, report: out };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stderr = io.stderr ?? process.stderr;
  try {
    const result = await provisionSite(parseProvisionArgs(argv), io);
    return result.exitCode;
  } catch (error) {
    report(stderr, {
      error: error.code ?? "unexpected",
      message: error instanceof OperatorError ? error.message : "Unexpected failure (details suppressed)",
      ...(error.code === "owner_approval_required" ? { requiredFlag: OWNER_APPROVAL_FLAG } : {}),
    });
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = await main();
