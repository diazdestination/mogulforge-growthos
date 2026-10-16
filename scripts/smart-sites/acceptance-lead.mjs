#!/usr/bin/env node
/**
 * One clearly labeled TEST lead through the Smart Site intake contract, its
 * verification, and its removal.
 *
 * Submit (site credential + owner/admin session from the environment only):
 *   GROWTHOS_SITE_ID=<uuid> GROWTHOS_SITE_SECRET=<ss_...> GROWTHOS_OWNER_SESSION=<sid> \
 *   node scripts/smart-sites/acceptance-lead.mjs submit \
 *     [--env local|staging|production] [--api http://127.0.0.1:3001] \
 *     --company "<exact workspace name>" [--site-label painless|css] [--service-code not-sure] [--postal-code 30115] \
 *     [--i-have-owner-approval]
 *
 *   Verifies: 201 saved receipt (UUID lead + receipt), idempotent replay (200, same
 *   receipt), the office task, the inquiry follow-up record and the owner-alert
 *   coverage (held/allowed). Prints a JSON report on stdout with the IDs needed
 *   for cleanup. The lead carries no outreach channel permission, so nothing may be
 *   sent to it; its contact is a reserved example.test address.
 *
 * Cleanup (database owner only; dry run unless --apply):
 *   DATABASE_URL=<postgres url> node scripts/smart-sites/acceptance-lead.mjs cleanup \
 *     --lead-id <uuid> --request-id <uuid> [--env local|staging|production] [--apply] \
 *     [--expected-organization-id <uuid>] [--confirm-delete-test-lead] \
 *     [--i-have-owner-approval --expected-database <db> --expected-login <login>]
 *
 *   Target binding never comes from the URL, which may be a tunnel. The connected
 *   server's current_database()/session_user must be a *_test database (local),
 *   exactly the approved staging identity (staging), or the owner-attested production
 *   identity. Staging and production also require the TEST lead's organization ID, and
 *   outside production that workspace's name must contain TEST.
 *
 *   GrowthOS has no lead-delete API, so cleanup works in one database transaction.
 *   It refuses unless the lead is this script's TEST lead (receipt request ID,
 *   TEST contact, example.test address, TEST summary) and its contact has no other
 *   lead. Audit events are kept (they hold IDs only, no contact data).
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  OperatorError,
  apiClient,
  assertEnvironment,
  exactOrigin,
  isLoopbackHost,
  hasTestLabel,
  isUuid,
  parseFlags,
  STAGING_DATABASE,
  STAGING_LOGIN,
  report,
  requireEnvSecret,
} from "./common.mjs";

export const TEST_CONTACT_NAME = "TEST GrowthOS Acceptance";
export const TEST_EMAIL_PREFIX = "growthos-acceptance+";
export const TEST_EMAIL_DOMAIN = "@example.test";
export const TEST_SUMMARY_PREFIX = "TEST lead - GrowthOS website hookup acceptance";
const SITE_SECRET = /^ss_[a-f0-9]{64}$/;

export function acceptancePayload({ requestId = randomUUID(), siteLabel = "site", serviceCode = "not-sure", postalCode } = {}) {
  return {
    schemaVersion: 1,
    requestId,
    contact: {
      name: TEST_CONTACT_NAME,
      email: `${TEST_EMAIL_PREFIX}${requestId.slice(0, 8)}${TEST_EMAIL_DOMAIN}`,
    },
    project: {
      serviceCode,
      ...(postalCode ? { postalCode } : {}),
      timing: "unsure",
      summary: `${TEST_SUMMARY_PREFIX} (${siteLabel}). Not a customer. Please ignore; it will be deleted.`,
    },
    // Contact consent is required by the contract; an empty channel list grants no outreach.
    consent: { contact: true, policyVersion: "growthos-acceptance-test-v1", analytics: false, channels: [] },
  };
}

async function submit(argv, { environment, fetchImpl, stdout, stderr }) {
  const flags = parseFlags(argv, {
    env: { choices: ["local", "staging", "production"], default: "local" },
    api: { default: "http://127.0.0.1:3001" },
    company: { required: true },
    "site-label": { default: "site" },
    "service-code": { default: "not-sure" },
    "postal-code": {},
    "request-id": {},
    "i-have-owner-approval": { type: "boolean" },
  });
  const api = exactOrigin(flags.api, "--api");
  assertEnvironment({ env: flags.env, api, ownerApproved: flags["i-have-owner-approval"] === true });
  if (!/^[a-z0-9-]{1,40}$/.test(flags["site-label"]))
    throw new OperatorError("invalid_flag", "--site-label must be a short lowercase label");
  if (flags["postal-code"] && !/^\d{5}$/.test(flags["postal-code"]))
    throw new OperatorError("invalid_flag", "--postal-code must be 5 digits");
  if (flags["request-id"] && !isUuid(flags["request-id"]))
    throw new OperatorError("invalid_flag", "--request-id must be a UUID");
  const siteId = requireEnvSecret(environment, "GROWTHOS_SITE_ID");
  if (!isUuid(siteId)) throw new OperatorError("invalid_env", "GROWTHOS_SITE_ID must be a UUID");
  const siteSecret = requireEnvSecret(environment, "GROWTHOS_SITE_SECRET", SITE_SECRET);
  const session = requireEnvSecret(environment, "GROWTHOS_OWNER_SESSION");
  const { call, expectOk } = apiClient(api, { fetchImpl, session });

  // Bind the run to the target workspace before sending anything.
  const me = await expectOk("Owner session check", "/me");
  if (!["owner", "admin"].includes(me.role) || !isUuid(me.organization?.id))
    throw new OperatorError("owner_admin_required", "Verification needs an owner/admin session in the target workspace");
  if (me.organization.name !== flags.company)
    throw new OperatorError(
      "company_mismatch",
      `Session belongs to "${me.organization.name}", not "${flags.company}"; nothing was submitted`,
    );
  if (flags.env !== "production" && !hasTestLabel(me.organization.name))
    throw new OperatorError(
      "not_a_test_organization",
      `--env ${flags.env} acceptance leads go only to a workspace whose name contains TEST`,
    );
  const sites = await expectOk("Site list", "/smart-sites");
  const target = (Array.isArray(sites) ? sites : []).find((s) => s.id === siteId);
  if (!target)
    throw new OperatorError("site_not_in_workspace", "GROWTHOS_SITE_ID is not a site of the session's workspace");

  const payload = acceptancePayload({
    requestId: flags["request-id"],
    siteLabel: flags["site-label"],
    serviceCode: flags["service-code"],
    postalCode: flags["postal-code"],
  });
  const checks = [];
  const check = (name, pass, detail) => {
    checks.push({ name, pass: Boolean(pass), ...(detail !== undefined ? { detail } : {}) });
    return Boolean(pass);
  };
  const intake = (body) =>
    call(`/public/smart-sites/${siteId}/intake`, { method: "POST", bearer: siteSecret, body });

  const first = await intake(payload);
  const receipt = first.data ?? {};
  const saved =
    check("intake_201_saved", first.status === 201 && receipt.status === "saved", {
      status: first.status,
      ...(first.ok ? {} : { error: receipt.error ?? null }),
    }) &&
    check("receipt_uuids", isUuid(receipt.leadId) && isUuid(receipt.receiptId)) &&
    check("receipt_contract", receipt.notification === "staff-inbox" && receipt.duplicate === false);
  const out = {
    label: "TEST",
    env: flags.env,
    api,
    organizationId: me.organization.id,
    siteId,
    requestId: payload.requestId,
    leadId: receipt.leadId ?? null,
    receiptId: receipt.receiptId ?? null,
    checks,
  };
  if (saved) {
    const replay = await intake(payload);
    check(
      "idempotent_replay",
      replay.status === 200 && replay.data?.duplicate === true && replay.data?.receiptId === receipt.receiptId,
      { status: replay.status },
    );
    const lead = await expectOk("Lead read", `/leads/${receipt.leadId}`);
    out.contactId = lead.contactId ?? null;
    // Read back from the target GrowthOS (not just the intake response): the lead exists
    // in the session's workspace, is labeled TEST, and the receipt is listed for it.
    check(
      "lead_saved_in_target_workspace",
      lead.id === receipt.leadId && lead.organizationId === me.organization.id,
    );
    check("lead_labeled_test", lead.status === "new" && String(lead.summary ?? "").startsWith("TEST lead"));
    const followup = await call(`/smart-sites/leads/${receipt.leadId}/follow-up`);
    check("inquiry_followup_record", followup.ok && followup.data?.leadId === receipt.leadId && followup.data?.organizationId === me.organization.id, {
      status: followup.status,
      dueAt: followup.data?.dueAt ?? null,
    });
    const tasks = await expectOk("Task list", "/tasks");
    const task = (Array.isArray(tasks) ? tasks : []).find(
      (t) => t.leadId === receipt.leadId && t.sourceEvent === "smart_site.lead_saved",
    );
    out.taskId = task?.id ?? null;
    check("office_task_created", Boolean(task), task ? { status: task.status, dueAt: task.dueAt } : undefined);
    const coverage = await call(`/staff-push/leads/${receipt.leadId}/coverage`);
    out.ownerAlert = coverage.ok
      ? {
          status: coverage.data.status,
          meaning: coverage.data.receiptMeaning,
          recipients: (coverage.data.recipients ?? []).map((r) => ({
            outcome: r.outcome,
            queuedDeviceCount: r.queuedDeviceCount,
            deliveryStateCounts: r.deliveryStateCounts,
          })),
        }
      : { error: coverage.data?.error ?? `HTTP ${coverage.status}` };
    check("owner_alert_coverage_recorded", coverage.ok && coverage.data?.status !== "coverage_not_recorded", {
      status: coverage.data?.status ?? null,
    });
  }
  out.passed = checks.every((c) => c.pass);
  out.cleanup = out.leadId
    ? `DATABASE_URL=... node scripts/smart-sites/acceptance-lead.mjs cleanup --env ${flags.env} --lead-id ${out.leadId} --request-id ${payload.requestId} --receipt-id ${out.receiptId} --task-id ${out.taskId} --contact-id ${out.contactId} --expected-organization-id ${me.organization.id} (dry run first; then --apply${flags.env === "local" ? "" : " --confirm-delete-test-lead"}${flags.env === "production" ? " --i-have-owner-approval --expected-database <db> --expected-login <login>" : ""})`
    : null;
  stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.passed) stderr.write("Acceptance lead FAILED; see checks.\n");
  return out.passed ? 0 : 2;
}

/** Server-side identity the connected database must report for each environment. */
export function cleanupIdentity(flags) {
  if (flags.env === "local")
    return {
      describe: "a disposable local *_test database",
      matches: (id) => /_test$/.test(id?.database ?? ""),
    };
  if (flags.env === "staging") {
    if (
      (flags["expected-database"] && flags["expected-database"] !== STAGING_DATABASE) ||
      (flags["expected-login"] && flags["expected-login"] !== STAGING_LOGIN)
    )
      throw new OperatorError("env_mismatch", "Staging cleanup is pinned to the approved staging database identity");
    return {
      describe: `${STAGING_DATABASE} as ${STAGING_LOGIN}`,
      matches: (id) => id?.database === STAGING_DATABASE && id?.login === STAGING_LOGIN,
    };
  }
  if (!flags["i-have-owner-approval"])
    throw new OperatorError("owner_approval_required", "Production cleanup is refused without --i-have-owner-approval");
  const database = flags["expected-database"];
  const login = flags["expected-login"];
  if (!database || !login)
    throw new OperatorError(
      "database_binding_required",
      "Production cleanup needs --expected-database and --expected-login attested by the database owner",
    );
  if (database === STAGING_DATABASE || /_test$/.test(database))
    throw new OperatorError("env_mismatch", "That database identity is not production");
  return {
    describe: `${database} as ${login}`,
    matches: (id) => id?.database === database && id?.login === login,
  };
}

function loadPg() {
  // pg is an api-server dependency; resolve it from there so this root script needs no install.
  const require = createRequire(new URL("../../artifacts/api-server/package.json", import.meta.url));
  return require("pg");
}

/**
 * Rows the intake contract creates for one lead, and only those. Each is matched by
 * its exact ID/provenance; nothing else is ever deleted. Any other row that still
 * references the TEST lead or contact (estimate, appointment, invoice, follow-up,
 * property, analytics...) is downstream work: cleanup refuses and rolls back.
 */
const INTAKE_ROWS = [
  {
    table: "staff_push_deliveries",
    sql: "DELETE FROM staff_push_deliveries WHERE organization_id = $1 AND lead_id = $2",
    params: (ctx) => [ctx.organizationId, ctx.leadId],
  },
  {
    table: "staff_lead_alert_coverage",
    sql: "DELETE FROM staff_lead_alert_coverage WHERE organization_id = $1 AND lead_id = $2",
    params: (ctx) => [ctx.organizationId, ctx.leadId],
    max: 1,
  },
  {
    table: "activities",
    sql: "DELETE FROM activities WHERE organization_id = $1 AND lead_id = $2 AND contact_id = $3 AND type = 'lead_captured' AND metadata->>'receiptId' = $4",
    params: (ctx) => [ctx.organizationId, ctx.leadId, ctx.contactId, ctx.receiptId],
    exactly: 1,
  },
  {
    table: "crm_tasks",
    sql: "DELETE FROM crm_tasks WHERE organization_id = $1 AND id = $2 AND lead_id = $3 AND source_event = 'smart_site.lead_saved'",
    params: (ctx) => [ctx.organizationId, ctx.taskId, ctx.leadId],
    exactly: 1,
  },
  {
    table: "smart_site_submissions",
    sql: "DELETE FROM smart_site_submissions WHERE organization_id = $1 AND id = $2 AND lead_id = $3 AND request_id = $4",
    params: (ctx) => [ctx.organizationId, ctx.receiptId, ctx.leadId, ctx.requestId],
    exactly: 1,
  },
];

/** Every column that can point at leads.id / contacts.id: declared FKs plus lead_id/contact_id columns. */
async function referencingColumns(client, parent, conventional) {
  const { rows } = await client.query(
    `SELECT DISTINCT table_name, column_name FROM (
       SELECT child.relname AS table_name, a.attname AS column_name
         FROM pg_constraint con
         JOIN pg_class child ON child.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = child.relnamespace AND n.nspname = 'public'
         JOIN LATERAL unnest(con.conkey, con.confkey) AS k(child_col, parent_col) ON true
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.child_col
         JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.parent_col AND pa.attname = 'id'
        WHERE con.contype = 'f' AND con.confrelid = $1::regclass
       UNION
       SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = $2
     ) refs
     WHERE table_name <> $3
     ORDER BY table_name, column_name`,
    [parent, conventional, parent],
  );
  return rows;
}

async function remainingReferences(client, parent, conventional, id) {
  const found = [];
  for (const { table_name: table, column_name: column } of await referencingColumns(client, parent, conventional)) {
    const safe = (v) => `"${String(v).replace(/"/g, "")}"`;
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${safe(table)} WHERE ${safe(column)}::text = $1`,
      [id],
    );
    if (rows[0]?.n > 0) found.push(`${table}.${column}`);
  }
  return found;
}

export async function cleanup(argv, { environment, stdout, pgModule }) {
  const flags = parseFlags(argv, {
    env: { choices: ["local", "staging", "production"], default: "local" },
    "lead-id": { required: true },
    "request-id": { required: true },
    "receipt-id": { required: true },
    "task-id": { required: true },
    "contact-id": { required: true },
    apply: { type: "boolean" },
    "confirm-delete-test-lead": { type: "boolean" },
    "i-have-owner-approval": { type: "boolean" },
    "expected-organization-id": {},
    "expected-database": {},
    "expected-login": {},
  });
  for (const name of ["lead-id", "request-id", "receipt-id", "task-id", "contact-id"])
    if (!isUuid(flags[name])) throw new OperatorError("invalid_flag", `--${name} must be a UUID (from the submit report)`);
  const expectedOrg = flags["expected-organization-id"];
  if (expectedOrg !== undefined && !isUuid(expectedOrg))
    throw new OperatorError("invalid_flag", "--expected-organization-id must be a UUID");
  // The URL is never trusted for identity (a loopback URL can be a tunnel to any cluster).
  // The connected server's own database/login and the TEST organization are checked below.
  const expectedIdentity = cleanupIdentity(flags);
  const databaseUrl = requireEnvSecret(environment, "DATABASE_URL");
  const db = new URL(databaseUrl);
  if (flags.env === "local") {
    if (!isLoopbackHost(db.hostname))
      throw new OperatorError("env_mismatch", "--env local cleanup needs a loopback DATABASE_URL");
  } else {
    if (!expectedOrg)
      throw new OperatorError(
        "organization_binding_required",
        `--env ${flags.env} cleanup needs --expected-organization-id (from the acceptance report)`,
      );
    if (flags.apply && !flags["confirm-delete-test-lead"])
      throw new OperatorError(
        "confirmation_required",
        `--env ${flags.env} cleanup needs --confirm-delete-test-lead with --apply`,
      );
  }
  const pg = pgModule ?? loadPg();
  const client = new (pg.Client ?? pg.default.Client)({ connectionString: databaseUrl });
  await client.connect();
  const out = { env: flags.env, mode: flags.apply ? "apply" : "dry-run", leadId: flags["lead-id"], deleted: {} };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    const identity = (
      await client.query("SELECT current_database() AS database, session_user AS login")
    ).rows[0];
    out.connectedDatabase = { database: identity?.database ?? null, login: identity?.login ?? null };
    if (!expectedIdentity.matches(identity))
      throw new OperatorError(
        "database_identity_mismatch",
        `Connected database is not the ${flags.env} target (${expectedIdentity.describe}); nothing was deleted`,
        out.connectedDatabase,
      );
    const { rows } = await client.query(
      `SELECT l.id AS lead_id, l.contact_id, l.organization_id, l.summary, c.first_name, c.last_name, c.email,
              org.name AS organization_name,
              s.id AS receipt_id,
              (SELECT count(*)::int FROM leads o WHERE o.contact_id = l.contact_id AND o.id <> l.id) AS other_leads
         FROM leads l
         JOIN contacts c ON c.id = l.contact_id AND c.organization_id = l.organization_id
         JOIN smart_site_submissions s ON s.lead_id = l.id AND s.request_id = $2
         JOIN organizations org ON org.id = l.organization_id
        WHERE l.id = $1
        FOR UPDATE OF l`,
      [flags["lead-id"], flags["request-id"]],
    );
    const lead = rows[0];
    if (!lead) throw new OperatorError("not_found", "No lead with that ID and receipt request ID");
    const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
    const isTest =
      fullName === TEST_CONTACT_NAME &&
      String(lead.email ?? "").startsWith(TEST_EMAIL_PREFIX) &&
      String(lead.email ?? "").endsWith(TEST_EMAIL_DOMAIN) &&
      String(lead.summary ?? "").startsWith(TEST_SUMMARY_PREFIX);
    if (!isTest) throw new OperatorError("not_a_test_lead", "Refusing: this lead does not carry every TEST marker");
    if (lead.receipt_id !== flags["receipt-id"] || lead.contact_id !== flags["contact-id"])
      throw new OperatorError("fixture_mismatch", "Refusing: receipt/contact IDs differ from the submit report");
    if (expectedOrg && lead.organization_id !== expectedOrg)
      throw new OperatorError("organization_mismatch", "Refusing: the lead belongs to a different organization than --expected-organization-id");
    // Outside production the workspace itself must be a labeled TEST workspace.
    if (flags.env !== "production" && !hasTestLabel(lead.organization_name))
      throw new OperatorError("not_a_test_organization", `Refusing: --env ${flags.env} cleanup only touches a workspace whose name contains TEST`);
    if (lead.other_leads > 0)
      throw new OperatorError("contact_has_other_leads", "Refusing: the TEST contact has other leads");
    out.organizationId = lead.organization_id;
    out.receiptId = lead.receipt_id;
    out.contactId = lead.contact_id;
    out.taskId = flags["task-id"];

    const ctx = {
      organizationId: lead.organization_id,
      leadId: lead.lead_id,
      contactId: lead.contact_id,
      receiptId: lead.receipt_id,
      taskId: flags["task-id"],
      requestId: flags["request-id"],
    };
    for (const row of INTAKE_ROWS) {
      const result = await client.query(row.sql, row.params(ctx));
      const count = result.rowCount ?? 0;
      if ((row.exactly !== undefined && count !== row.exactly) || (row.max !== undefined && count > row.max))
        throw new OperatorError(
          "fixture_mismatch",
          `Refusing: expected ${row.exactly ?? `at most ${row.max}`} ${row.table} row(s) from this TEST intake, found ${count}`,
        );
      if (count) out.deleted[row.table] = count;
    }
    const leadRefs = await remainingReferences(client, "leads", "lead_id", lead.lead_id);
    if (leadRefs.length)
      throw new OperatorError(
        "downstream_work_present",
        `Refusing: other records still reference the TEST lead (${leadRefs.join(", ")}); nothing was deleted`,
        { referencedBy: leadRefs },
      );
    out.deleted.leads = (
      await client.query("DELETE FROM leads WHERE organization_id = $1 AND id = $2", [ctx.organizationId, ctx.leadId])
    ).rowCount;
    const contactRefs = await remainingReferences(client, "contacts", "contact_id", lead.contact_id);
    if (contactRefs.length)
      throw new OperatorError(
        "downstream_work_present",
        `Refusing: other records still reference the TEST contact (${contactRefs.join(", ")}); nothing was deleted`,
        { referencedBy: contactRefs },
      );
    out.deleted.contacts = (
      await client.query("DELETE FROM contacts WHERE organization_id = $1 AND id = $2", [ctx.organizationId, ctx.contactId])
    ).rowCount;
    const remaining = await client.query(
      "SELECT (SELECT count(*)::int FROM leads WHERE id = $1) + (SELECT count(*)::int FROM smart_site_submissions WHERE lead_id = $1) + (SELECT count(*)::int FROM contacts WHERE id = $2) AS n",
      [lead.lead_id, lead.contact_id],
    );
    out.verifiedRemoved = remaining.rows[0].n === 0 && out.deleted.leads === 1 && out.deleted.contacts === 1;
    out.auditEventsKept = true;
    await client.query(flags.apply && out.verifiedRemoved ? "COMMIT" : "ROLLBACK");
    out.committed = Boolean(flags.apply && out.verifiedRemoved);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
  stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return out.verifiedRemoved ? 0 : 2;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const ctx = {
    environment: io.environment ?? process.env,
    fetchImpl: io.fetchImpl ?? fetch,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    pgModule: io.pgModule,
  };
  try {
    const [command, ...rest] = argv;
    if (command === "submit") return await submit(rest, ctx);
    if (command === "cleanup") return await cleanup(rest, ctx);
    throw new OperatorError("usage", "Usage: acceptance-lead.mjs submit|cleanup [flags]");
  } catch (error) {
    report(ctx.stderr, {
      error: error.code ?? "unexpected",
      message: error instanceof OperatorError ? error.message : "Unexpected failure (details suppressed)",
    });
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = await main();
