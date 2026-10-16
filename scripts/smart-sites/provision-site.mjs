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
 *     [--apply] [--confirm-launch] [--stdout secret|env] [--i-have-owner-approval] \
 *     [--rotate-secret --expected-credential-version <n>]
 *
 * Secret safety:
 *   - A secret is issued only when the site is created, or when --rotate-secret is
 *     passed explicitly together with the credential version the operator saw. A
 *     re-run never rotates implicitly, and a version mismatch (someone, or an earlier
 *     run, already rotated) is refused instead of rotating again.
 *   - The secret is written to stdout exactly once, immediately after GrowthOS
 *     confirms issuance and before any other request. Nothing later can lose it.
 *     stdout carries nothing else (or the GROWTHOS_SITE_ID/SECRET lines with
 *     --stdout env). It is never written to disk or stderr.
 *   - If the issuing request has an uncertain outcome (network error, 5xx, malformed
 *     reply), the report says secretOutcome "UNKNOWN", exit code 3, and nothing is
 *     retried. Verify with a dry run (credentialVersion / site presence), then recover
 *     as described in docs/smart-sites/POST-CUTOVER-HOOKUP.md.
 *
 * Report (stderr JSON): status READY | CONFIGURED_NOT_READY | INCOMPLETE | UNKNOWN,
 * with `missing` listing every condition that was not verified by a successful readback.
 * Exit codes: 0 verified (READY when --confirm-launch, else configuration verified),
 * 1 refused before any write, 2 written but not fully verified, 3 secret outcome UNKNOWN.
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

const SECRET_PATTERN = /^ss_[a-f0-9]{64}$/;
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
  "rotate-secret": { type: "boolean" },
  "expected-credential-version": {},
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
  let expectedCredentialVersion;
  if (flags["rotate-secret"]) {
    expectedCredentialVersion = Number(flags["expected-credential-version"]);
    if (!Number.isInteger(expectedCredentialVersion) || expectedCredentialVersion < 1)
      throw new OperatorError(
        "invalid_flag",
        "--rotate-secret needs --expected-credential-version <n> (the version a dry run just showed)",
      );
  } else if (flags["expected-credential-version"] !== undefined)
    throw new OperatorError("invalid_flag", "--expected-credential-version is only used with --rotate-secret");
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
    rotateSecret: flags["rotate-secret"] === true,
    expectedCredentialVersion,
    allowTerminalSecret: flags["allow-terminal-secret"] === true,
  };
}

const RECOVERY =
  "Do not rerun with --rotate-secret blindly. Run this command without --apply and compare credentialVersion and site presence with the values before this run. If the site exists or its version increased and you do not hold the new secret, the old secret is already invalid and capture is off: issue one replacement with --rotate-secret --expected-credential-version <current version>. See docs/smart-sites/POST-CUTOVER-HOOKUP.md (Secret recovery).";

/** Classify the issuing response: definite success, definite refusal, or unknown. */
function issuanceOutcome(result) {
  if (result.ok && SECRET_PATTERN.test(result.data?.secret ?? "") && result.data?.id)
    return "DELIVERED";
  if (result.status >= 400 && result.status < 500) return "NOT_ISSUED";
  return "UNKNOWN";
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
  if (options.rotateSecret && !site)
    throw new OperatorError("site_not_found", "--rotate-secret needs an existing site; omit it to create one");
  if (options.rotateSecret && site.credentialVersion !== options.expectedCredentialVersion)
    throw new OperatorError(
      "credential_version_mismatch",
      `Current credential version is ${site.credentialVersion}, not ${options.expectedCredentialVersion}. The secret was already rotated (possibly by an earlier run); refusing to rotate again. ${RECOVERY}`,
      { currentCredentialVersion: site.credentialVersion },
    );
  out.actions.push(site ? "verify_existing_site" : "create_site");
  if (options.rotateSecret) out.actions.push("rotate_secret");
  const issuing = !site || options.rotateSecret;
  if (issuing) out.actions.push("credential_check");
  // A new site starts with analytics off and 90-day retention.
  const current = site ?? { analyticsEnabled: false, analyticsRetentionDays: 90 };
  if (current.analyticsEnabled !== options.analyticsEnabled || current.analyticsRetentionDays !== options.retentionDays)
    out.actions.push(`set_analytics_${options.analyticsEnabled ? "on" : "off"}`);
  const willBeInactive = !site || options.rotateSecret || !site.isActive;
  if (willBeInactive)
    out.actions.push(options.confirmLaunch ? "enable_capture" : "capture_left_off_needs_confirm_launch");
  if (site && !issuing)
    out.note =
      "Existing site: its secret cannot be shown again and is not rotated. Only --rotate-secret --expected-credential-version <n> issues a new one (pauses capture until re-enabled).";

  if (!options.apply) {
    if (site) out.siteId = site.id;
    out.current = site
      ? {
          isActive: site.isActive,
          analyticsEnabled: site.analyticsEnabled,
          analyticsRetentionDays: site.analyticsRetentionDays,
          credentialVersion: site.credentialVersion,
          credentialIssuedAt: site.credentialIssuedAt,
          credentialCheckedAt: site.credentialCheckedAt,
        }
      : null;
    const readiness = await call("/smart-sites/launch-readiness");
    out.staffing = readiness.ok ? readiness.data?.staffing ?? null : null;
    out.readinessHttpStatus = readiness.status;
    report(stderr, out);
    return { exitCode: 0, report: out };
  }

  // 3. Issue (create or explicit rotation). The secret leaves this process exactly
  //    once, right here, before any other request can fail.
  if (issuing) {
    out.secretOutcome = "UNKNOWN";
    let result;
    try {
      result = site
        ? await call(`/smart-sites/${site.id}/rotate-key`, { method: "POST", body: {} })
        : await call("/smart-sites", {
            method: "POST",
            body: { name: options.siteName, siteKey: options.siteKey, profile: options.profile },
          });
    } catch {
      result = { status: 0, ok: false, data: null };
    }
    out.secretOutcome = issuanceOutcome(result);
    if (out.secretOutcome === "DELIVERED") {
      const issued = result.data;
      stdout.write(
        options.stdoutFormat === "env"
          ? `GROWTHOS_SITE_ID=${issued.id}\nGROWTHOS_SITE_SECRET=${issued.secret}\n`
          : `${issued.secret}\n`,
      );
      out.secretIssued = true;
      out.siteId = issued.id;
      const { secret: _secret, ...publicSite } = issued;
      site = publicSite;
      out.secretCheck = await credentialCheck(call, issued.id, issued.secret);
    } else {
      if (site) out.siteId = site.id;
      out.error = {
        code: out.secretOutcome === "NOT_ISSUED" ? "issuance_refused" : "issuance_outcome_unknown",
        httpStatus: result.status || null,
        apiError: result.data?.error ?? null,
      };
      if (out.secretOutcome === "UNKNOWN") {
        out.status = "UNKNOWN";
        out.recovery = RECOVERY;
        report(stderr, out);
        return { exitCode: 3, report: out };
      }
      out.status = "INCOMPLETE";
      out.missing = ["secret_issuance"];
      report(stderr, out);
      return { exitCode: 2, report: out };
    }
  } else {
    out.siteId = site.id;
  }

  // 4. Configuration writes. Failures are recorded; verification below decides.
  const writeErrors = [];
  const attempt = async (label, path, body) => {
    try {
      const result = await call(path, { method: "PATCH", body });
      if (!result.ok) writeErrors.push({ step: label, httpStatus: result.status, apiError: result.data?.error ?? null, ...(result.data?.blockers ? { blockers: result.data.blockers } : {}) });
    } catch {
      writeErrors.push({ step: label, httpStatus: null, apiError: "request_failed" });
    }
  };
  if (site.analyticsEnabled !== options.analyticsEnabled || site.analyticsRetentionDays !== options.retentionDays)
    await attempt("analytics", `/smart-sites/${site.id}/measurement`, {
      enabled: options.analyticsEnabled,
      retentionDays: options.retentionDays,
    });
  if (options.confirmLaunch && (site.isActive !== true || out.secretIssued))
    await attempt("enable_capture", `/smart-sites/${site.id}`, { isActive: true, confirmedLaunch: true });
  if (writeErrors.length) out.writeErrors = writeErrors;

  // 5. Verify only from successful readbacks. Every unverified condition is listed.
  const missing = [];
  let after = null;
  try {
    const list = await call("/smart-sites");
    if (list.ok && Array.isArray(list.data)) after = list.data.find((s) => s.id === out.siteId) ?? null;
    else missing.push("site_readback_failed");
  } catch {
    missing.push("site_readback_failed");
  }
  if (after) {
    out.final = {
      isActive: after.isActive,
      analyticsEnabled: after.analyticsEnabled,
      analyticsRetentionDays: after.analyticsRetentionDays,
      analyticsPolicyVersion: after.analyticsPolicyVersion,
      credentialVersion: after.credentialVersion,
      credentialCheckedAt: after.credentialCheckedAt,
    };
    if (after.profile !== options.profile) missing.push("profile");
    if (after.analyticsEnabled !== options.analyticsEnabled) missing.push("analytics_state");
    if (after.analyticsRetentionDays !== options.retentionDays) missing.push("analytics_retention");
  } else if (!missing.includes("site_readback_failed")) missing.push("site_not_found_on_readback");
  if (out.secretIssued && out.secretCheck !== "verified") missing.push("secret_confirmation");
  if (!out.siteOrigin) missing.push("site_origin");
  const configurationVerified = missing.length === 0;

  const readinessMissing = [];
  if (!after?.isActive) readinessMissing.push("capture_enabled");
  try {
    const readiness = await call("/smart-sites/launch-readiness");
    out.readinessHttpStatus = readiness.status;
    const entry = readiness.ok ? readiness.data?.sites?.find?.((s) => s.id === out.siteId) : undefined;
    out.staffing = readiness.ok ? readiness.data?.staffing ?? null : null;
    if (!readiness.ok) readinessMissing.push("readiness_readback_failed");
    else if (!entry) readinessMissing.push("readiness_entry_missing");
    else {
      out.blockers = entry.blockers ?? null;
      if (entry.ready !== true || !Array.isArray(entry.blockers) || entry.blockers.length)
        readinessMissing.push(...(entry.blockers?.length ? entry.blockers.map((b) => `blocker:${b}`) : ["readiness_not_ready"]));
    }
  } catch {
    readinessMissing.push("readiness_readback_failed");
  }
  const readyToCapture = configurationVerified && readinessMissing.length === 0;
  out.configurationVerified = configurationVerified;
  out.readyToCapture = readyToCapture;
  out.status = readyToCapture ? "READY" : configurationVerified ? "CONFIGURED_NOT_READY" : "INCOMPLETE";
  out.missing = options.confirmLaunch ? [...missing, ...readinessMissing] : missing;
  if (!options.confirmLaunch && !readyToCapture) out.notReadyBecause = readinessMissing;

  out.siteConfig = {
    GROWTHOS_API_ORIGIN: options.api,
    GROWTHOS_SITE_ID: out.siteId ?? null,
    GROWTHOS_SITE_SECRET: out.secretIssued ? "(stdout of this run only)" : "(unchanged; not recoverable)",
    SITE_PUBLIC_ORIGIN: options.siteOrigin,
  };
  out.originEnforcement =
    "Validation/reporting only: GrowthOS stores no per-site origin (no schema change before cutover). Intake is server-to-server only and rejects browser Origin headers; the site secret is the authentication boundary. The website worker pins GROWTHOS_API_ORIGIN, serves only SITE_PUBLIC_ORIGIN, and binds outbox rows to siteId|origin; verify those on the exact deployment.";
  report(stderr, out);
  const ok = options.confirmLaunch ? readyToCapture : configurationVerified;
  return { exitCode: ok ? 0 : 2, report: out };
}

async function credentialCheck(call, siteId, secret) {
  try {
    const result = await call(`/public/smart-sites/${siteId}/check`, {
      method: "POST",
      bearer: secret,
      body: { schemaVersion: 1 },
    });
    return result.ok && result.data?.status === "credential_verified" ? "verified" : `failed_http_${result.status}`;
  } catch {
    return "failed_request";
  }
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
      ...(error instanceof OperatorError && error.details ? error.details : {}),
      ...(error.code === "owner_approval_required" ? { requiredFlag: OWNER_APPROVAL_FLAG } : {}),
    });
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = await main();
