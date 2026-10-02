declare const __GROWTHOS_BUILD_IDENTITY__: unknown;

const environments = new Set([
  "development",
  "test",
  "staging",
  "production",
  "restore",
]);

/** Public allowlist only: never reflect raw environment values or image URLs. */
export function releaseIdentity(
  build: unknown = typeof __GROWTHOS_BUILD_IDENTITY__ === "undefined"
    ? null
    : __GROWTHOS_BUILD_IDENTITY__,
  env: NodeJS.ProcessEnv = process.env,
) {
  const value =
    build && typeof build === "object"
      ? (build as Record<string, unknown>)
      : {};
  const sha =
    typeof value.sha === "string" && /^[a-f\d]{40}$/i.test(value.sha)
      ? value.sha.toLowerCase()
      : null;
  const stamp = typeof value.builtAt === "string" ? value.builtAt : "";
  const builtAt =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stamp) &&
    Number.isFinite(Date.parse(stamp)) &&
    new Date(stamp).toISOString() === stamp
      ? stamp
      : null;
  let environment = "unknown";
  if (env.GROWTHOS_ENVIRONMENT !== undefined) {
    if (environments.has(env.GROWTHOS_ENVIRONMENT))
      environment = env.GROWTHOS_ENVIRONMENT;
  } else if (env.FLY_APP_NAME === "mogulforge-growthos-staging")
    environment = "staging";
  else if (env.FLY_APP_NAME === "mogulforge-growthos")
    environment = "production";
  else if (env.FLY_APP_NAME === "mogulforge-growthos-restore-drill")
    environment = "restore";
  else if (env.NODE_ENV === "test" || env.NODE_ENV === "development")
    environment = env.NODE_ENV;
  return { sha, builtAt, environment };
}
