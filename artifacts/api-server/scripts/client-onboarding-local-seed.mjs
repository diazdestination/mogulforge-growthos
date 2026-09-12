/** Creates a separate synthetic operator account, never promotes a client user. */
import pg from "pg";
import { randomBytes, scryptSync } from "node:crypto";
const databaseUrl =
  "postgresql://postgres:local-smart-sites-only@127.0.0.1:55432/mogulforge_smart_sites_test";
if (process.env.DATABASE_URL !== databaseUrl)
  throw new Error("Exact isolated Smart Sites test DB required.");
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query("BEGIN");
  const name = "MogulForge — LOCAL OPERATOR QA";
  const slug = "smart-sites-local-operator";
  await client.query(
    "INSERT INTO organizations(name,slug) VALUES ($1,$2) ON CONFLICT(slug) DO NOTHING",
    [name, slug],
  );
  const {
    rows: [org],
  } = await client.query(
    "SELECT id,name FROM organizations WHERE slug=$1 FOR UPDATE",
    [slug],
  );
  if (org.name !== name)
    throw new Error("Existing organization is not the labeled QA fixture.");
  const email = "operator@smart-sites-local.example.test";
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync("LocalOperatorOnly!2026", salt, 64).toString("hex")}`;
  await client.query(
    `INSERT INTO users(email,first_name,last_name,password_hash,organization_id,role,is_platform_admin,email_verified_at)
    VALUES ($1,'Local','Platform Operator',$2,$3,'owner',true,now()) ON CONFLICT(email) DO NOTHING`,
    [email, passwordHash, org.id],
  );
  const {
    rows: [user],
  } = await client.query(
    "SELECT id,organization_id,is_platform_admin,is_active,role FROM users WHERE email=$1",
    [email],
  );
  if (
    user.organization_id !== org.id ||
    !user.is_platform_admin ||
    !user.is_active ||
    user.role !== "owner"
  )
    throw new Error(
      "Existing QA identity has different access; no mutation performed.",
    );
  await client.query(
    `INSERT INTO org_settings(organization_id,business_profile,services,service_areas,onboarding)
    VALUES ($1,$2,'[]','[]',$3) ON CONFLICT(organization_id) DO NOTHING`,
    [
      org.id,
      JSON.stringify({ businessName: name }),
      JSON.stringify({
        completedSteps: [],
        dismissedAt: new Date().toISOString(),
      }),
    ],
  );
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      localOnly: true,
      organizationId: org.id,
      userId: user.id,
      loginEmail: email,
      existingPainlessIdentityUnchanged: true,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
