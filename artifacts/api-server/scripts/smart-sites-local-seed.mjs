/** Isolated local verification fixture. Never usable against production or a remote database. */
import pg from "pg";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expected =
  "postgresql://postgres:local-smart-sites-only@127.0.0.1:55432/mogulforge_smart_sites_test";
if (process.env.DATABASE_URL !== expected)
  throw new Error(
    "This fixture only operates on the isolated localhost Smart Sites test database.",
  );
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const localDir = path.join(root, ".local", "smart-sites");
const credentialPath = path.join(localDir, "painless-connection.json");
const client = new pg.Client({ connectionString: expected });
await client.connect();
let sessionId;
try {
  const {
    rows: [org],
  } = await client.query(
    "INSERT INTO organizations(name,slug) VALUES ($1,$2) ON CONFLICT(slug) DO UPDATE SET name=excluded.name RETURNING id",
    ["Painless — LOCAL TEST WORKSPACE", "painless-smart-sites-local"],
  );
  const email = "owner@painless-local.example.test";
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync("LocalPreviewOnly!2026", salt, 64).toString("hex")}`;
  await client.query(
    "INSERT INTO users(email,first_name,last_name,password_hash,organization_id,role,email_verified_at) VALUES ($1,'Local','Preview Owner',$2,$3,'owner',now()) ON CONFLICT(email) DO NOTHING",
    [email, passwordHash, org.id],
  );
  const {
    rows: [user],
  } = await client.query(
    "SELECT id,organization_id FROM users WHERE email=$1",
    [email],
  );
  if (user.organization_id !== org.id)
    throw new Error("Local test identity belongs to a different workspace.");
  await client.query(
    "INSERT INTO org_settings(organization_id,business_profile,services,onboarding) VALUES ($1,$2,'[]',$3) ON CONFLICT(organization_id) DO NOTHING",
    [
      org.id,
      JSON.stringify({ businessName: "Painless — LOCAL TEST WORKSPACE" }),
      JSON.stringify({
        completedSteps: [],
        dismissedAt: new Date().toISOString(),
      }),
    ],
  );
  sessionId = randomBytes(32).toString("hex");
  await client.query(
    "INSERT INTO sessions(sid,sess,expire) VALUES ($1,$2,now()+interval '10 minutes')",
    [
      sessionId,
      JSON.stringify({
        user: {
          id: user.id,
          email,
          firstName: "Local",
          lastName: "Preview Owner",
          profileImageUrl: null,
        },
        access_token: "local-fixture-only",
        expires_at: Math.floor(Date.now() / 1000) + 600,
      }),
    ],
  );
  const call = async (url, method = "GET", value) => {
    const response = await fetch(`http://127.0.0.1:3001/api/v1${url}`, {
      method,
      headers: {
        authorization: `Bearer ${sessionId}`,
        "content-type": "application/json",
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(
        `Local fixture API failed (${response.status}): ${body.error}`,
      );
    return body;
  };
  const sites = await call("/smart-sites");
  let site = sites.find((s) => s.siteKey === "painless-roofing-website");
  let localConfig;
  if (!site) {
    site = await call("/smart-sites", "POST", {
      name: "Painless local preview",
      siteKey: "painless-roofing-website",
      profile: "roofing-exteriors",
    });
    localConfig = {
      PAINLESS_GROWTHOS_ENABLED: "true",
      GROWTHOS_API_ORIGIN: "http://127.0.0.1:3001",
      GROWTHOS_SITE_ID: site.id,
      GROWTHOS_SITE_SECRET: site.secret,
    };
    await mkdir(localDir, { recursive: true });
    await writeFile(credentialPath, JSON.stringify(localConfig, null, 2), {
      mode: 0o600,
    });
  } else {
    localConfig = JSON.parse(await readFile(credentialPath, "utf8"));
    if (localConfig.GROWTHOS_SITE_ID !== site.id)
      throw new Error("Local connection file does not match its test site.");
  }
  if (!site.isActive)
    await call(`/smart-sites/${site.id}`, "PATCH", { isActive: true });
  console.log(
    JSON.stringify({
      localOnly: true,
      organizationId: org.id,
      siteId: site.id,
      connectionFile: credentialPath,
      loginEmail: email,
      message:
        "Local fixture ready. No production organization, credentials or outbound provider was used.",
    }),
  );
} finally {
  if (sessionId)
    await client.query("DELETE FROM sessions WHERE sid=$1", [sessionId]);
  await client.end();
}
