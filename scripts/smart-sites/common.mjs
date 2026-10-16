/**
 * Shared guards for the Smart Site hookup operator scripts.
 *
 * Secrets never come from argv (shell history, process lists). The owner/admin
 * session and the site secret are read from environment variables only, and the
 * only value a script may write to stdout that is secret is a freshly issued
 * site secret, so it can be piped straight into the site's secret store.
 */

export const PRODUCTION_API_ORIGIN = "https://app.mogulforge.ai";
/** The one approved staging app (Codex review decision 2, 2026-10-16). */
export const STAGING_API_ORIGIN = "https://mogulforge-growthos-staging.fly.dev";
/** Staging database identity, mirrored from scripts/staging-readonly-preflight.mjs. */
export const STAGING_DATABASE = "growthos_staging";
export const STAGING_LOGIN = "growthos-staging-live";
export const ENVIRONMENTS = ["local", "staging", "production"];
export const OWNER_APPROVAL_FLAG = "--i-have-owner-approval";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => UUID.test(value ?? "");
/** A record name visibly labeled with the standalone word TEST. */
export const hasTestLabel = (value) => /\bTEST\b/.test(value ?? "");
export const isLoopbackHost = (hostname) =>
  ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);

export class OperatorError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.code = code;
    this.details = details;
  }
}

/** Minimal `--flag value` / `--switch` parser. Unknown flags are refused. */
export function parseFlags(argv, spec) {
  const out = {};
  for (const [name, def] of Object.entries(spec))
    if (def.default !== undefined) out[name] = def.default;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--"))
      throw new OperatorError("unexpected_argument", `Unexpected argument: ${raw}`);
    const [flag, inline] = raw.slice(2).split(/=(.*)/s, 2);
    const def = spec[flag];
    if (!def) throw new OperatorError("unknown_flag", `Unknown flag --${flag}`);
    if (def.type === "boolean") {
      if (inline !== undefined)
        throw new OperatorError("invalid_flag", `--${flag} takes no value`);
      out[flag] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--"))
      throw new OperatorError("missing_value", `--${flag} needs a value`);
    if (def.choices && !def.choices.includes(value))
      throw new OperatorError(
        "invalid_flag",
        `--${flag} must be one of: ${def.choices.join(", ")}`,
      );
    out[flag] = value;
  }
  for (const [name, def] of Object.entries(spec))
    if (def.required && out[name] === undefined)
      throw new OperatorError("missing_flag", `--${name} is required`);
  return out;
}

/** Exact origin: scheme + host (+ port), no path, query, hash or credentials. */
export function exactOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OperatorError("invalid_origin", `${label} is not a URL`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.replace(/\/$/, "") !== url.origin
  )
    throw new OperatorError(
      "invalid_origin",
      `${label} must be an exact origin like https://example.com (no path, query or trailing data)`,
    );
  if (!["https:", "http:"].includes(url.protocol))
    throw new OperatorError("invalid_origin", `${label} must be http(s)`);
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname))
    throw new OperatorError(
      "invalid_origin",
      `${label} may use http only for a loopback (local) host`,
    );
  return url.origin;
}

/**
 * Environment fence. Local = loopback API only. Staging = exactly the approved
 * staging origin, and every record must be visibly labeled TEST. Production =
 * the pinned production origin and an explicit owner-approval flag.
 */
export function assertEnvironment({ env, api, ownerApproved, labels = [] }) {
  if (!ENVIRONMENTS.includes(env))
    throw new OperatorError("invalid_env", `--env must be ${ENVIRONMENTS.join("|")}`);
  const url = new URL(api);
  if (env === "local") {
    if (!isLoopbackHost(url.hostname))
      throw new OperatorError(
        "env_mismatch",
        "--env local only talks to a loopback GrowthOS API (127.0.0.1/localhost)",
      );
  } else if (env === "staging") {
    if (url.origin !== STAGING_API_ORIGIN)
      throw new OperatorError(
        "env_mismatch",
        `--env staging must use ${STAGING_API_ORIGIN} (the approved staging app)`,
      );
    for (const [what, value] of labels)
      if (!hasTestLabel(value))
        throw new OperatorError(
          "staging_label_required",
          `Staging records must be labeled TEST: ${what} must contain the word TEST`,
        );
  } else {
    if (url.origin !== PRODUCTION_API_ORIGIN)
      throw new OperatorError(
        "env_mismatch",
        `--env production must use ${PRODUCTION_API_ORIGIN} (the origin both sites pin)`,
      );
    if (!ownerApproved)
      throw new OperatorError(
        "owner_approval_required",
        `Production is refused without ${OWNER_APPROVAL_FLAG} (Adam's explicit approval for this action).`,
      );
  }
}

export function requireEnvSecret(environment, name, pattern) {
  const value = environment[name];
  if (!value || (pattern && !pattern.test(value)))
    throw new OperatorError(
      "missing_secret_env",
      `Set ${name} in the environment (never pass secrets as arguments).`,
    );
  return value;
}

/** JSON HTTP client that never logs request bodies, headers or secrets. */
export function apiClient(api, { fetchImpl = fetch, session } = {}) {
  const call = async (path, { method = "GET", body, bearer = session } = {}) => {
    const response = await fetchImpl(`${api}/api/v1${path}`, {
      method,
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { status: response.status, ok: response.ok, data };
  };
  const expectOk = async (label, path, options) => {
    const result = await call(path, options);
    if (!result.ok)
      throw new OperatorError(
        "api_error",
        `${label} failed: HTTP ${result.status} ${result.data?.error ?? ""}`.trim(),
        { status: result.status, error: result.data?.error, ...pick(result.data, ["blockers"]) },
      );
    return result.data;
  };
  return { call, expectOk };
}

const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((k) => value && value[k] !== undefined).map((k) => [k, value[k]]),
  );

export function report(stderr, value) {
  stderr.write(`${JSON.stringify(value, null, 2)}\n`);
}
