/** Synthetic local acceptance only. No environment-supplied URL or provider credentials. */
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const org = "13e252c7-8955-4237-b2a5-ab5e93a54b86";
const database =
  "postgresql://postgres:local-smart-sites-only@127.0.0.1:55432/mogulforge_smart_sites_test";
const client = new pg.Client({ connectionString: database });
await client.connect();
try {
  const workspace = await client.query(
    "SELECT name FROM organizations WHERE id = $1",
    [org],
  );
  if (workspace.rows[0]?.name !== "Painless — LOCAL TEST WORKSPACE")
    throw new Error("Unexpected workspace; stopping.");
  if (process.argv[2] === "--seed-overdue") {
    const requestId = "8916d7f4-11c2-4749-8009-a574e82a5f50";
    const found = await client.query(
      "SELECT lead_id FROM smart_site_submissions WHERE organization_id = $1 AND request_id = $2",
      [org, requestId],
    );
    if (!found.rowCount) {
      const fixture = JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(
              "../../../.local/smart-sites/painless-connection.json",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      );
      const response = await fetch(
        `http://127.0.0.1:3001/api/v1/public/smart-sites/${fixture.GROWTHOS_SITE_ID}/intake`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${fixture.GROWTHOS_SITE_SECRET}`,
            "content-type": "application/json",
            "x-smart-site-received-at": new Date(
              Date.now() - 2 * 3600_000,
            ).toISOString(),
          },
          body: JSON.stringify({
            schemaVersion: 1,
            requestId,
            contact: {
              name: "Local Overdue SLA QA",
              phone: "4045550178",
              email: "sla-qa@example.test",
            },
            project: {
              serviceCode: "gutters",
              timing: "planning",
              summary:
                "SYNTHETIC TEST ONLY. Receipt time simulated two hours earlier to verify overdue presentation. Never contact.",
            },
            consent: {
              contact: true,
              analytics: false,
              policyVersion: "synthetic-recovery-test-v1",
              channels: ["phone"],
            },
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Local fixture rejected: ${response.status}`);
      console.log(await response.json());
    }
  } else if (process.argv.length > 2)
    throw new Error(
      "Only --seed-overdue or read-only inspection is supported.",
    );
  const report = await client.query(
    `SELECT s.lead_id, concat_ws(' ', c.first_name, c.last_name) AS name, s.site_received_at,
    s.created_at AS crm_saved_at, s.response_due_at, s.first_attempt_at, l.assigned_user_id,
    (SELECT count(*)::int FROM crm_tasks t WHERE t.lead_id = l.id AND t.source_event = 'smart_site.lead_saved') AS intake_tasks,
    (SELECT count(*)::int FROM smart_site_followups f WHERE f.lead_id = l.id) AS staff_logs
    FROM smart_site_submissions s JOIN leads l ON l.id = s.lead_id JOIN contacts c ON c.id = l.contact_id
    WHERE s.organization_id = $1 ORDER BY s.created_at`,
    [org],
  );
  console.log(JSON.stringify(report.rows, null, 2));
} finally {
  await client.end();
}
