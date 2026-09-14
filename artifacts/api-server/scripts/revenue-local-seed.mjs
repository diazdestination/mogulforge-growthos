/** Fictional, non-contactable UI evidence. Additive and exact-loopback-only. */
import pg from "pg";
import { createHash } from "node:crypto";

const expected =
  "postgresql://postgres:local-smart-sites-only@127.0.0.1:55432/mogulforge_smart_sites_test";
if (process.env.DATABASE_URL !== expected)
  throw new Error("Revenue fixtures require the isolated loopback test DB.");
const client = new pg.Client({ connectionString: expected });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended('revenue-local-fixture',0))",
  );
  const {
    rows: [org],
  } = await client.query(
    "select id,name from organizations where slug='painless-smart-sites-local'",
  );
  if (!org?.name.includes("LOCAL TEST"))
    throw new Error("Run the existing isolated Smart Sites fixture first.");
  const email = "revenue-qa@example.invalid";
  let {
    rows: [contact],
  } = await client.query(
    "select id from contacts where organization_id=$1 and email=$2",
    [org.id, email],
  );
  if (!contact)
    ({
      rows: [contact],
    } = await client.query(
      "insert into contacts(organization_id,first_name,last_name,email,do_not_contact,do_not_contact_email,do_not_contact_sms) values($1,'LOCAL REVENUE','QA — NOT A CUSTOMER',$2,true,true,true) returning id",
      [org.id, email],
    ));
  const ids = [];
  for (const [label, status, amount] of [
    ["REVIEW ESTIMATE", "estimate_sent", 1280000],
    ["COMPLETED PROJECT", "won", 1845000],
  ]) {
    const summary = `LOCAL REVENUE QA — ${label}`;
    let {
      rows: [lead],
    } = await client.query(
      "select id from leads where organization_id=$1 and summary=$2",
      [org.id, summary],
    );
    if (!lead)
      ({
        rows: [lead],
      } = await client.query(
        "insert into leads(organization_id,contact_id,status,summary,source,service_type,estimated_value_cents,created_at,updated_at) values($1,$2,$3,$4,'local-revenue-qa','Siding',$5,now()-interval '10 days',now()-interval '10 days') returning id",
        [org.id, contact.id, status, summary, amount],
      ));
    let {
      rows: [estimate],
    } = await client.query(
      "select id from estimates where organization_id=$1 and lead_id=$2",
      [org.id, lead.id],
    );
    if (!estimate)
      ({
        rows: [estimate],
      } = await client.query(
        "insert into estimates(organization_id,lead_id,title,status,subtotal_cents,total_cents,sent_at,accepted_at) values($1,$2,$3,$4::estimate_status,$5,$5,now()-interval '7 days',case when $4::estimate_status='accepted' then now()-interval '4 days' else null end) returning id",
        [
          org.id,
          lead.id,
          `LOCAL QA — ${label}`,
          status === "won" ? "accepted" : "sent",
          amount,
        ],
      ));
    if (status === "won")
      await client.query(
        "insert into projects(organization_id,lead_id,estimate_id,name,status,completed_at) values($1,$2,$3,'LOCAL QA — Completed siding project','completed',now()-interval '1 day') on conflict (estimate_id) where estimate_id is not null do nothing",
        [org.id, lead.id, estimate.id],
      );
    ids.push({ label, leadId: lead.id, estimateId: estimate.id });
  }
  // A known code is only inserted for this fictional local identity; no message is sent.
  await client.query(
    "insert into portal_login_codes(organization_id,identifier,channel,code_hash,expires_at) values($1,$2,'email',$3,now()+interval '30 minutes')",
    [org.id, email, createHash("sha256").update("654321").digest("hex")],
  );
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      localOnly: true,
      fixtureEmail: email,
      oneTimeCode: "654321",
      records: ids,
      message:
        "Fictional records only. No provider or real customer was contacted.",
    }),
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
