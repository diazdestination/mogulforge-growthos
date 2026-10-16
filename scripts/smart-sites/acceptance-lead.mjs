#!/usr/bin/env node
/**
 * One clearly labeled TEST lead through the Smart Site intake contract, its
 * verification, and its removal.
 *
 * Submit (site credential + owner/admin session from the environment only):
 *   GROWTHOS_SITE_ID=<uuid> GROWTHOS_SITE_SECRET=<ss_...> GROWTHOS_OWNER_SESSION=<sid> \
 *   node scripts/smart-sites/acceptance-lead.mjs submit \
 *     [--env local|staging|production] [--api http://127.0.0.1:3001] \
 *     [--site-label painless|css] [--service-code not-sure] [--postal-code 30115] \
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
 *     [--confirm-delete-test-lead] [--i-have-owner-approval]
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
  isUuid,
  parseFlags,
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
    check("lead_labeled_test", lead.status === "new" && String(lead.summary ?? "").startsWith("TEST lead"));
    const followup = await call(`/smart-sites/leads/${receipt.leadId}/follow-up`);
    check("inquiry_followup_record", followup.ok && followup.data?.leadId === receipt.leadId, {
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
    ? `DATABASE_URL=... node scripts/smart-sites/acceptance-lead.mjs cleanup --env ${flags.env} --lead-id ${out.leadId} --request-id ${payload.requestId} --apply`
    : null;
  stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.passed) stderr.write("Acceptance lead FAILED; see checks.\n");
  return out.passed ? 0 : 2;
}

function loadPg() {
  // pg is an api-server dependency; resolve it from there so this root script needs no install.
  const require = createRequire(new URL("../../artifacts/api-server/package.json", import.meta.url));
  return require("pg");
}

export async function cleanup(argv, { environment, stdout, pgModule }) {
  const flags = parseFlags(argv, {
    env: { choices: ["local", "staging", "production"], default: "local" },
    "lead-id": { required: true },
    "request-id": { required: true },
    apply: { type: "boolean" },
    "confirm-delete-test-lead": { type: "boolean" },
    "i-have-owner-approval": { type: "boolean" },
  });
  if (!isUuid(flags["lead-id"]) || !isUuid(flags["request-id"]))
    throw new OperatorError("invalid_flag", "--lead-id and --request-id must be UUIDs");
  const databaseUrl = requireEnvSecret(environment, "DATABASE_URL");
  const db = new URL(databaseUrl);
  if (flags.env === "local") {
    if (!isLoopbackHost(db.hostname))
      throw new OperatorError("env_mismatch", "--env local cleanup needs a loopback DATABASE_URL");
  } else {
    if (flags.apply && !flags["confirm-delete-test-lead"])
      throw new OperatorError(
        "confirmation_required",
        `--env ${flags.env} cleanup needs --confirm-delete-test-lead with --apply`,
      );
    if (flags.env === "production" && !flags["i-have-owner-approval"])
      throw new OperatorError("owner_approval_required", "Production cleanup is refused without --i-have-owner-approval");
  }
  const pg = pgModule ?? loadPg();
  const client = new (pg.Client ?? pg.default.Client)({ connectionString: databaseUrl });
  await client.connect();
  const out = { env: flags.env, mode: flags.apply ? "apply" : "dry-run", leadId: flags["lead-id"], deleted: {} };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    const { rows } = await client.query(
      `SELECT l.id AS lead_id, l.contact_id, l.organization_id, l.summary, c.first_name, c.last_name, c.email,
              s.id AS receipt_id,
              (SELECT count(*)::int FROM leads o WHERE o.contact_id = l.contact_id AND o.id <> l.id) AS other_leads
         FROM leads l
         JOIN contacts c ON c.id = l.contact_id AND c.organization_id = l.organization_id
         JOIN smart_site_submissions s ON s.lead_id = l.id AND s.request_id = $2
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
    if (lead.other_leads > 0)
      throw new OperatorError("contact_has_other_leads", "Refusing: the TEST contact has other leads");
    out.receiptId = lead.receipt_id;
    out.contactId = lead.contact_id;

    const tablesWith = async (column) =>
      (
        await client.query(
          `SELECT c.table_name FROM information_schema.columns c
             JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = $1
              AND c.table_name NOT IN ('leads', 'contacts', 'audit_events')
            ORDER BY c.table_name`,
          [column],
        )
      ).rows.map((r) => r.table_name);
    // FK-safe sweep: retry a table blocked by another pending table (no ON DELETE CASCADE in the schema).
    const sweep = async (column, id) => {
      let pending = await tablesWith(column);
      while (pending.length) {
        const blocked = [];
        for (const table of pending) {
          await client.query("SAVEPOINT sweep");
          try {
            const result = await client.query(
              `DELETE FROM "${table.replace(/"/g, "")}" WHERE "${column}" = $1 AND organization_id = $2`,
              [id, lead.organization_id],
            );
            await client.query("RELEASE SAVEPOINT sweep");
            if (result.rowCount) out.deleted[table] = (out.deleted[table] ?? 0) + result.rowCount;
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT sweep");
            if (error.code === "23503") blocked.push(table);
            else if (error.code === "42703") continue; // table without organization_id: never touched
            else throw error;
          }
        }
        if (blocked.length === pending.length)
          throw new OperatorError("cleanup_blocked", `Rows still referenced: ${blocked.join(", ")}`);
        pending = blocked;
      }
    };
    await sweep("lead_id", lead.lead_id);
    const deleteOne = async (table, id) => {
      try {
        return await client.query(`DELETE FROM ${table} WHERE id = $1 AND organization_id = $2`, [
          id,
          lead.organization_id,
        ]);
      } catch (error) {
        if (error.code === "23503")
          throw new OperatorError("cleanup_blocked", `The TEST ${table} row is still referenced (${error.constraint ?? "foreign key"})`);
        throw error;
      }
    };
    out.deleted.leads = (await deleteOne("leads", lead.lead_id)).rowCount;
    await sweep("contact_id", lead.contact_id);
    const contactDelete = await deleteOne("contacts", lead.contact_id);
    out.deleted.contacts = contactDelete.rowCount;
    const remaining = await client.query(
      "SELECT (SELECT count(*)::int FROM leads WHERE id = $1) + (SELECT count(*)::int FROM smart_site_submissions WHERE lead_id = $1) + (SELECT count(*)::int FROM contacts WHERE id = $2) AS n",
      [lead.lead_id, lead.contact_id],
    );
    out.verifiedRemoved = remaining.rows[0].n === 0;
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
