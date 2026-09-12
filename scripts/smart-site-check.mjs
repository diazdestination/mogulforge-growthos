/** Credential-only acceptance. Reads server environment; never logs the key or creates a lead. */
const origin = new URL(
  process.env.GROWTHOS_API_ORIGIN || "http://127.0.0.1:3001",
);
const local =
  origin.protocol === "http:" &&
  ["127.0.0.1", "localhost"].includes(origin.hostname);
const live =
  origin.origin === "https://app.mogulforge.ai" &&
  process.argv.includes("--allow-live");
if (
  (!local && !live) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error(
    "Use loopback for local checks. The approved production origin requires explicit --allow-live.",
  );
const siteId = process.env.GROWTHOS_SITE_ID || "";
const key = process.env.GROWTHOS_SITE_SECRET || "";
if (!/^[0-9a-f-]{36}$/i.test(siteId) || !/^ss_[a-f0-9]{64}$/.test(key))
  throw new Error("Missing valid server-only site ID / credential.");
const result = await fetch(
  `${origin.origin}/api/v1/public/smart-sites/${siteId}/check`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ schemaVersion: 1 }),
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  },
);
if (!result.ok)
  throw new Error(
    `Credential check failed (HTTP ${result.status}); no readiness success recorded.`,
  );
const value = await result.json();
if (value.status !== "credential_verified" || value.siteId !== siteId)
  throw new Error("Unexpected check receipt.");
console.log(
  JSON.stringify(
    {
      status: value.status,
      siteId,
      checkedAt: value.checkedAt,
      createsLead: false,
      scope: local ? "local credential only" : "production credential only",
      publicWebsiteVerified: false,
    },
    null,
    2,
  ),
);
