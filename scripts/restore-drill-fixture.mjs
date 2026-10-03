import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { parseRestoreDrillTarget } from "./restore-drill-readonly.mjs";
import { restoreClient } from "./restore-drill-connection.mjs";

export const FIXTURE_VERSION = 1;
export const FAKE_REFRESH_TOKEN =
  "synthetic-restore-drill-not-an-oauth-token-v1";
const FIXTURE_DATE = "2026-09-30T12:00:00.000Z";
const jsonFields = new Set([
  "metadata",
  "payload",
  "evidence",
  "options",
  "line_items",
]);

export function fixtureIds(slug) {
  const names = [
    "organization",
    "user",
    "contact",
    "property",
    "lead",
    "estimate",
    "proposal",
    "execution",
    "executionEvent",
    "room",
    "value",
    "audit",
    "project",
    "story",
    "object",
    "photoActivity",
    "gmail",
    "task",
    "obligation",
  ];
  return Object.fromEntries(
    names.map((name) => {
      const hash = createHash("sha256")
        .update(`growthos-restore-v${FIXTURE_VERSION}:${slug}:${name}`)
        .digest("hex");
      return [
        name,
        `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      ];
    }),
  );
}

export function fixtureObject(slug) {
  return Buffer.from(
    `GrowthOS synthetic private restore object v1\n${slug}\nNot customer media.\n`,
    "utf8",
  );
}

function fail(label) {
  throw new Error(label);
}

/** Calls the real application encryption codec, not a separately invented format. */
export async function credentialCodec(key) {
  if (!key) fail("restore_fixture_encryption_key_missing");
  const module = await tsImport(
    "../artifacts/api-server/src/lib/token-encryption.ts",
    import.meta.url,
  );
  const call = (method, value, context, overrideKey = key) => {
    const previous = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = overrideKey;
    try {
      return module[method](value, context);
    } finally {
      if (previous === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
      else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = previous;
    }
  };
  return {
    encrypt: (value, context) => call("encryptSecret", value, context),
    decrypt: (value, context) => call("decryptSecret", value, context),
    wrongKeyRejects(value, context) {
      const bytes = /^[a-f\d]{64}$/i.test(key.trim())
        ? Buffer.from(key.trim(), "hex")
        : Buffer.from(key.trim(), "base64");
      if (bytes.length !== 32) fail("restore_fixture_encryption_key_invalid");
      bytes[0] ^= 0xff;
      try {
        call("decryptSecret", value, context, bytes.toString("base64"));
        return false;
      } catch {
        return true;
      }
    },
  };
}

export function fixtureRows(slug, encryptedToken = null) {
  const id = fixtureIds(slug);
  const org = id.organization;
  const marker = `SYNTHETIC RESTORE ONLY — ${slug}`;
  const shared = { organization_id: org };
  return [
    ["organizations", { id: org, name: marker, slug, timezone: "UTC" }],
    [
      "users",
      {
        id: id.user,
        ...shared,
        email: `${slug}.operator@example.invalid`,
        first_name: "Synthetic",
        last_name: "Restore Operator",
        password_hash: null,
        role: "owner",
        is_platform_admin: false,
        is_active: true,
      },
    ],
    [
      "contacts",
      {
        id: id.contact,
        ...shared,
        first_name: "Synthetic",
        last_name: "Restore Homeowner",
        email: `${slug}.homeowner@example.invalid`,
        phone: null,
        do_not_contact: true,
        do_not_contact_email: true,
        do_not_contact_sms: true,
      },
    ],
    [
      "properties",
      {
        id: id.property,
        ...shared,
        contact_id: id.contact,
        address_line_1: "0 SYNTHETIC RESTORE FIXTURE",
        city: "Test Only",
        state: "XX",
        postal_code: "00000",
      },
    ],
    [
      "leads",
      {
        id: id.lead,
        ...shared,
        contact_id: id.contact,
        property_id: id.property,
        assigned_user_id: id.user,
        status: "nurture",
        source: "restore-drill",
        creation_method: "import",
        summary: marker,
        estimated_value_cents: null,
      },
    ],
    [
      "estimates",
      {
        id: id.estimate,
        ...shared,
        lead_id: id.lead,
        title: marker,
        status: "draft",
        line_items: [
          {
            description: "Synthetic fixture only; no quote sent",
            quantity: 1,
            unitPriceCents: 10000,
            totalCents: 10000,
          },
        ],
        subtotal_cents: 10000,
        total_cents: 10000,
        updated_at: FIXTURE_DATE,
        notes: "Synthetic unsent estimate used only for data recovery checks.",
      },
    ],
    [
      "bie_action_proposals",
      {
        id: id.proposal,
        ...shared,
        lead_id: id.lead,
        action_type: "create_task",
        status: "rejected",
        title: marker,
        rationale: "Synthetic rejected proposal; never execute.",
        evidence: { fixtureVersion: FIXTURE_VERSION },
        payload: { title: marker },
        created_by_user_id: id.user,
      },
    ],
    [
      "revenue_executions",
      {
        id: id.execution,
        ...shared,
        action_key: `restore-drill:${id.proposal}`,
        fingerprint: createHash("sha256").update(marker).digest("hex"),
        kind: "create_task",
        state: "blocked",
        detail: "Synthetic fixture; no effect attempted.",
        actor_user_id: id.user,
        expires_at: FIXTURE_DATE,
        completed_at: FIXTURE_DATE,
      },
    ],
    [
      "revenue_execution_events",
      {
        id: id.executionEvent,
        ...shared,
        execution_id: id.execution,
        state: "blocked",
        detail: "Synthetic fixture; no effect attempted.",
        actor_user_id: id.user,
      },
    ],
    [
      "decision_rooms",
      {
        id: id.room,
        ...shared,
        lead_id: id.lead,
        estimate_id: id.estimate,
        version: 1,
        title: marker,
        scope:
          "Synthetic decision room snapshot; no real scope or customer approval.",
        options: [],
        warranty: "No warranty represented by this synthetic fixture.",
        source_reference: `restore-drill:${slug}:decision-room`,
        estimate_total_cents: 10000,
        estimate_updated_at: FIXTURE_DATE,
        approved_by_user_id: id.user,
      },
    ],
    [
      "value_entries",
      {
        id: id.value,
        ...shared,
        lead_id: id.lead,
        source_reference: `restore-drill:${slug}:synthetic-cost`,
        kind: "direct_cost",
        amount_cents: 100,
        occurred_at: FIXTURE_DATE,
        recorded_by_user_id: id.user,
      },
    ],
    [
      "audit_events",
      {
        id: id.audit,
        ...shared,
        actor_user_id: id.user,
        action: "restore_drill.fixture_created.v1",
        entity_type: "lead",
        entity_id: id.lead,
        metadata: {
          fixtureVersion: FIXTURE_VERSION,
          syntheticOnly: true,
          outboundAttempted: false,
        },
      },
    ],
    [
      "projects",
      {
        id: id.project,
        ...shared,
        lead_id: id.lead,
        estimate_id: id.estimate,
        name: marker,
        status: "on_hold",
        crew_notes: "Synthetic recovery fixture; not scheduled work.",
      },
    ],
    [
      "project_stories",
      {
        id: id.story,
        ...shared,
        project_id: id.project,
        version: 1,
        title: marker,
        service_area: "Synthetic area only",
        body: "Synthetic project story for recovery verification. No claim of completed work and no publication.",
        source_reference: `restore-drill:${slug}:story`,
        source_updated_at: FIXTURE_DATE,
        state: "draft",
      },
    ],
    [
      "stored_objects",
      {
        id: id.object,
        ...shared,
        data: fixtureObject(slug),
        content_type: "text/plain",
        size_bytes: fixtureObject(slug).length,
        metadata: { fixtureVersion: FIXTURE_VERSION, syntheticOnly: true },
      },
    ],
    [
      "activities",
      {
        id: id.photoActivity,
        ...shared,
        lead_id: id.lead,
        contact_id: id.contact,
        actor_user_id: id.user,
        type: "photos_attached",
        title: "Synthetic private recovery object; not customer media",
        metadata: {
          photoPaths: [`/objects/uploads/${id.object}`],
          syntheticOnly: true,
        },
      },
    ],
    [
      "gmail_connections",
      {
        id: id.gmail,
        ...shared,
        user_id: id.user,
        email: `${slug}.mailbox@example.invalid`,
        encrypted_refresh_token: encryptedToken,
        granted_scopes: [],
        revoked_at: FIXTURE_DATE,
        last_error_code: "synthetic_restore_fixture_no_authorization",
      },
    ],
    [
      "crm_tasks",
      {
        id: id.task,
        ...shared,
        lead_id: id.lead,
        contact_id: id.contact,
        assigned_user_id: id.user,
        title: marker,
        description: "Synthetic cancelled service task; never contact.",
        source_event: "restore-drill",
        status: "cancelled",
      },
    ],
    [
      "service_obligations",
      {
        id: id.obligation,
        ...shared,
        contact_id: id.contact,
        property_id: id.property,
        task_id: id.task,
        kind: "maintenance",
        equipment_label: "Synthetic equipment; no serial or customer",
        due_at: FIXTURE_DATE,
        status: "cancelled",
        source: "restore-drill",
        external_ref: `${slug}:maintenance`,
        notes: "Cancelled synthetic recovery fixture; no reminder due.",
      },
    ],
  ];
}

function normal(value, key) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return Buffer.from(value).toString("hex");
  if (key.endsWith("_at") && value != null)
    return new Date(value).toISOString();
  return value;
}

/** Checks stored app records using SELECT only, with secrets held only in memory. */
export async function assertFixtureRecords(client, target, codec, { reviewedPausedServiceId = null, reviewedPausedCareExecutionId = null, reviewedPausedInvoiceExecutionId = null } = {}) {
  // The local contractor upgrade drill additionally restores one explicitly
  // reviewed successor. It may remain active only behind a restored company
  // pause. Ordinary restore acceptance keeps its original zero-active rule.
  if (reviewedPausedServiceId !== null && (!/^restore-drill-contractor-[ab]$/.test(target.syntheticSlug) || !/^[a-f0-9-]{36}$/.test(reviewedPausedServiceId))) fail("restore_fixture_service_exception_invalid");
  // Customer-care recovery additionally preserves one exact indeterminate
  // receipt behind BOTH a paused company and a disabled recovery policy. Never
  // permit processing work or a blanket exception for other unknown effects.
  if (reviewedPausedCareExecutionId !== null && (!reviewedPausedServiceId || !/^[a-f0-9-]{36}$/.test(reviewedPausedCareExecutionId))) fail("restore_fixture_care_exception_invalid");
  // Local current-source drill only: one exact immutable invoice successor may
  // retain an unknown effect behind the company pause. Never allow processing,
  // unrelated receipts, or a blanket invoice exception in hosted acceptance.
  if (reviewedPausedInvoiceExecutionId !== null && (!reviewedPausedCareExecutionId || !/^[a-f0-9-]{36}$/.test(reviewedPausedInvoiceExecutionId))) fail("restore_fixture_invoice_exception_invalid");
  const id = fixtureIds(target.syntheticSlug);
  let ciphertext;
  for (const [table, expected] of fixtureRows(target.syntheticSlug)) {
    const columns = Object.keys(expected);
    const result = await client.query(
      `SELECT ${columns.join(", ")} FROM ${table} WHERE id = $1${table === "organizations" ? "" : " AND organization_id = $2"}`,
      table === "organizations"
        ? [expected.id]
        : [expected.id, id.organization],
    );
    if (result.rows.length !== 1) fail("restore_fixture_record_missing");
    const row = result.rows[0];
    for (const key of columns) {
      if (key === "encrypted_refresh_token") {
        ciphertext = row[key];
        continue;
      }
      if (!isDeepStrictEqual(normal(row[key], key), normal(expected[key], key)))
        fail("restore_fixture_record_changed");
    }
  }
  const context = `${id.organization}:${id.user}:gmail`;
  let plaintext;
  try {
    plaintext = codec.decrypt(ciphertext, context);
  } catch {
    fail("restore_fixture_credential_decrypt_failed");
  }
  if (plaintext !== FAKE_REFRESH_TOKEN)
    fail("restore_fixture_credential_mismatch");
  let wrongContextRejected = false;
  try {
    codec.decrypt(ciphertext, `${id.organization}:wrong-user:gmail`);
  } catch {
    wrongContextRejected = true;
  }
  if (!wrongContextRejected || !codec.wrongKeyRejects(ciphertext, context))
    fail("restore_fixture_credential_context_not_bound");
  const forbidden = await client.query(
    `SELECT
      (SELECT count(*) FROM scheduled_actions WHERE organization_id = $1 AND status = 'pending') +
      (SELECT count(*) FROM reactivation_campaigns WHERE organization_id = $1 AND status NOT IN ('draft', 'completed', 'cancelled')) +
      (SELECT count(*) FROM service_obligations s WHERE organization_id = $1 AND status = 'active' ${reviewedPausedServiceId ? "AND NOT (s.id=$2::uuid AND EXISTS (SELECT 1 FROM customer_lifecycle cl WHERE cl.organization_id=s.organization_id AND cl.state='paused'))" : ""}) +
      (SELECT count(*) FROM bie_action_proposals WHERE organization_id = $1 AND status IN ('approved', 'processing')) +
      (SELECT count(*) FROM revenue_executions e WHERE organization_id = $1 AND state IN ('processing', 'indeterminate') ${reviewedPausedCareExecutionId ? "AND NOT (e.id=$3::uuid AND e.state='indeterminate' AND EXISTS (SELECT 1 FROM customer_lifecycle cl WHERE cl.organization_id=e.organization_id AND cl.state='paused') AND EXISTS (SELECT 1 FROM missed_call_care_policies p WHERE p.organization_id=e.organization_id AND p.enabled=false) AND EXISTS (SELECT 1 FROM missed_call_care_cases c WHERE c.organization_id=e.organization_id AND c.state='indeterminate' AND e.action_key='missed-call-care:' || c.call_id::text || ':sms:v1'))" : ""}
        ${reviewedPausedInvoiceExecutionId ? "AND NOT (e.id=$4::uuid AND e.state='indeterminate' AND e.kind='invoice_email' AND EXISTS (SELECT 1 FROM customer_lifecycle cl WHERE cl.organization_id=e.organization_id AND cl.state='paused') AND EXISTS (SELECT 1 FROM invoice_delivery_attempts a JOIN audit_events proof ON proof.id=a.predecessor_proof_id AND proof.organization_id=a.organization_id WHERE a.organization_id=e.organization_id AND a.execution_id=e.id AND a.execution_fingerprint=e.fingerprint AND a.action_key=e.action_key AND a.ordinal=2 AND a.intent='retry_not_dispatched' AND proof.action='invoice_delivery.not_dispatched' AND proof.metadata->>'phase'='pre_provider' AND proof.metadata->>'executionId'=a.predecessor_execution_id::text))" : ""}) +
      (SELECT count(*) FROM webhook_endpoints WHERE organization_id = $1 AND is_active = true) +
      (SELECT count(*) FROM gmail_connections WHERE organization_id = $1 AND revoked_at IS NULL) +
      (SELECT count(*) FROM contacts WHERE organization_id = $1 AND (phone IS NOT NULL OR email NOT LIKE '%.invalid' OR do_not_contact = false OR do_not_contact_email = false OR do_not_contact_sms = false)) +
      (SELECT count(*) FROM users WHERE organization_id = $1 AND (email NOT LIKE '%.invalid' OR password_hash IS NOT NULL OR is_platform_admin = true)) AS unsafe_count`,
    reviewedPausedInvoiceExecutionId ? [id.organization, reviewedPausedServiceId, reviewedPausedCareExecutionId, reviewedPausedInvoiceExecutionId] : reviewedPausedCareExecutionId ? [id.organization, reviewedPausedServiceId, reviewedPausedCareExecutionId] : reviewedPausedServiceId ? [id.organization, reviewedPausedServiceId] : [id.organization],
  );
  if (Number(forbidden.rows[0]?.unsafe_count) !== 0)
    fail("restore_fixture_outbound_or_identity_unsafe");
  return {
    fixtureVersion: FIXTURE_VERSION,
    applicationRecordGraphVerified: true,
    storedObjectVerified: true,
    credentialDecryptVerified: true,
    wrongKeyRejected: true,
    wrongContextRejected: true,
    fixtureOutboundInert: true,
    appBootVerified: false,
  };
}

export async function seedRestoreFixture(
  env = process.env,
  { createClient, emit = console.log } = {},
) {
  const target = parseRestoreDrillTarget(env);
  if (target.mode !== "source" || target.login !== "growthos-staging-live")
    fail("restore_fixture_source_writer_required");
  if (env.RESTORE_DRILL_SEED_APPROVED !== "true")
    fail("restore_fixture_seed_approval_required");
  if (
    env.GROWTHOS_OUTBOUND_HOLD !== "true" ||
    env.STAGING_OUTBOUND_APPROVED !== "false" ||
    env.SCHEDULER_AUTOSTART !== "false"
  )
    fail("restore_fixture_outbound_hold_required");
  const sessionBearer = env.RESTORE_DRILL_SESSION_BEARER;
  if (sessionBearer !== undefined && !/^[a-f0-9]{64,128}$/.test(sessionBearer))
    fail("restore_fixture_session_secret_invalid");
  const codec = await credentialCodec(env.OAUTH_TOKEN_ENCRYPTION_KEY);
  const id = fixtureIds(target.syntheticSlug);
  const ciphertext = codec.encrypt(
    FAKE_REFRESH_TOKEN,
    `${id.organization}:${id.user}:gmail`,
  );
  const connection = await restoreClient(env, target, { createClient });
  const { client } = connection;
  let begun = false;
  try {
    await client.connect();
    await client.query("BEGIN");
    begun = true;
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const identity = await client.query(
      "SELECT current_database() AS database, session_user AS login",
    );
    if (
      identity.rows[0]?.database !== target.database ||
      identity.rows[0]?.login !== target.login
    )
      fail("restore_fixture_session_mismatch");
    // Serialize fixture creation and refuse a mixed real/synthetic database.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('growthos-restore-drill-fixture-v1'))",
    );
    const unrelated = await client.query(
      "SELECT count(*)::int AS total FROM organizations WHERE slug NOT LIKE 'restore-drill-%' OR name NOT LIKE 'SYNTHETIC RESTORE ONLY%'",
    );
    if (Number(unrelated.rows[0]?.total) !== 0)
      fail("restore_fixture_database_not_synthetic");
    const existing = await client.query(
      "SELECT id FROM organizations WHERE slug = $1",
      [target.syntheticSlug],
    );
    if (
      existing.rows.length > 1 ||
      (existing.rows.length === 1 && existing.rows[0].id !== id.organization)
    )
      fail("restore_fixture_anchor_conflict");
    const inserted = existing.rows.length === 0;
    if (inserted) {
      for (const [table, row] of fixtureRows(
        target.syntheticSlug,
        ciphertext,
      )) {
        const columns = Object.keys(row);
        const values = columns.map((column) =>
          jsonFields.has(column) ? JSON.stringify(row[column]) : row[column],
        );
        await client.query(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
          values,
        );
      }
    }
    // Existing records are never overwritten. Drift or a partial graph aborts.
    const checks = await assertFixtureRecords(client, target, codec);
    if (sessionBearer) {
      // Prepare a short-lived local-app session before the backup. The restored
      // Reader-backed app cannot create or extend sessions while inspecting.
      const session = await client.query(
        "SELECT sess, expire FROM sessions WHERE sid = $1",
        [sessionBearer],
      );
      if (session.rows.length > 0) {
        if (
          session.rows[0].sess?.user?.id !== id.user ||
          session.rows[0].sess?.access_token !==
            "restore-drill-synthetic-session-no-provider" ||
          new Date(session.rows[0].expire).getTime() <= Date.now()
        )
          fail("restore_fixture_session_conflict_or_expired");
      } else {
        await client.query(
          "INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,$3)",
          [
            sessionBearer,
            JSON.stringify({
              user: {
                id: id.user,
                email: `${target.syntheticSlug}.operator@example.invalid`,
                firstName: "Synthetic",
                lastName: "Restore Operator",
                profileImageUrl: null,
              },
              access_token: "restore-drill-synthetic-session-no-provider",
            }),
            new Date(Date.now() + 48 * 60 * 60 * 1000),
          ],
        );
      }
    }
    const frozen = await client.query(
      "SELECT clock_timestamp() AS fixture_frozen_at",
    );
    await client.query("COMMIT");
    begun = false;
    const evidence = {
      check: "restore_drill_synthetic_fixture",
      syntheticSlug: target.syntheticSlug,
      target: {
        clusterId: target.clusterId,
        database: target.database,
        login: target.login,
      },
      inserted,
      recordCount: fixtureRows(target.syntheticSlug).length,
      fixtureFrozenAt: new Date(frozen.rows[0].fixture_frozen_at).toISOString(),
      syntheticInspectionSessionPrepared: Boolean(sessionBearer),
      ...checks,
      providerCalled: false,
    };
    emit(JSON.stringify(evidence));
    return evidence;
  } finally {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
    await connection.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  seedRestoreFixture().catch((error) => {
    console.error(
      `RESTORE_FIXTURE_FAILED:${/^restore_[a-z_]+$/.test(error.message || "") ? error.message : /^[A-Z0-9]{5}$/.test(error.code || "") ? error.code : "unknown"}`,
    );
    process.exitCode = 1;
  });
}
