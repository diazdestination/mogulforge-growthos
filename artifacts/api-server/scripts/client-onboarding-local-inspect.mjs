/** Read-only inspection of named synthetic fixtures. No customer fields or secrets. */
import pg from "pg";
const client = new pg.Client({
  connectionString:
    "postgresql://postgres:local-smart-sites-only@127.0.0.1:55432/mogulforge_smart_sites_test",
});
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const { rows } = await client.query(
    `SELECT o.id AS organization_id,o.name,o.slug,s.id AS site_id,s.profile,
    s.is_active,s.response_target_minutes,s.credential_version,s.credential_issued_at,s.credential_checked_at,
    (SELECT count(*)::int FROM leads l WHERE l.organization_id=o.id) AS lead_count,
    (SELECT count(*)::int FROM users u WHERE u.organization_id=o.id) AS member_count
    FROM organizations o LEFT JOIN smart_sites s ON s.organization_id=o.id
    WHERE o.slug = ANY($1) ORDER BY o.slug,s.created_at`,
    [
      [
        "painless-smart-sites-local",
        "smart-sites-local-operator",
        "hvac-onboarding-local-qa",
        "dawsonville-nutrition-local-qa",
        "commercial-construction-local-qa",
      ],
    ],
  );
  console.log(JSON.stringify({ localOnly: true, fixtures: rows }, null, 2));
  await client.query("COMMIT");
} finally {
  await client.end();
}
