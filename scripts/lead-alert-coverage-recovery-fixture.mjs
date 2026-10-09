/** Fictional admission evidence only. Supplied disposable database; no provider I/O. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixtureIds } from "./restore-drill-fixture.mjs";
import { operationsFixtureIds } from "./operations-wave-recovery-fixture.mjs";
import { sourceNurtureIds } from "./source-nurture-recovery-fixture.mjs";

const stamp = "2026-10-02T12:00:00.000Z";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function ids(slug) {
  assert.ok(
    ["restore-drill-contractor-a", "restore-drill-contractor-b"].includes(slug),
  );
  return Object.fromEntries(
    ["effect", "removedEffect"].map((name) => {
      const hash = sha(`lead-alert-coverage-v1:${slug}:${name}`);
      return [
        name,
        `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      ];
    }),
  );
}
function recipients(slug) {
  const original = fixtureIds(slug),
    coverage = ids(slug);
  return [
    {
      userId: original.user,
      outcome: "queued",
      deliveryIds: [coverage.effect, coverage.removedEffect],
    },
    {
      userId: `former-staff-${slug}`,
      outcome: "no_eligible_device",
      deliveryIds: [],
    },
  ];
}
export async function seedLeadAlertCoverage(database, slug) {
  const original = fixtureIds(slug),
    coverage = ids(slug),
    operations = operationsFixtureIds(slug);
  await database.query(
    `INSERT INTO staff_push_deliveries
    (id,organization_id,lead_id,subscription_id,state,created_at,expires_at,claimed_at,completed_at,reason)
    VALUES ($1,$2,$3,$4,'indeterminate',$5,$5,$5,$5,'worker_interrupted')`,
    [
      coverage.effect,
      original.organization,
      original.lead,
      operations.subscription,
      stamp,
    ],
  );
  await database.query(
    `INSERT INTO staff_lead_alert_coverage
    (organization_id,lead_id,occurred_at,recorded_at,status,policy_fingerprint,recipients)
    SELECT organization_id,id,created_at,$3,'evaluated',$4,$5::jsonb FROM leads
    WHERE organization_id=$1 AND id=$2`,
    [
      original.organization,
      original.lead,
      stamp,
      sha(`synthetic-original-policy:${slug}`),
      JSON.stringify(recipients(slug)),
    ],
  );
}
export async function assertLeadAlertCoverage(database, slug) {
  const original = fixtureIds(slug),
    coverage = ids(slug);
  const [row] = (
    await database.query(
      `SELECT c.*,l.created_at AS canonical_created_at
    FROM staff_lead_alert_coverage c JOIN leads l ON l.id=c.lead_id AND l.organization_id=c.organization_id
    WHERE c.organization_id=$1 AND c.lead_id=$2`,
      [original.organization, original.lead],
    )
  ).rows;
  assert.equal(row.version, 1);
  assert.equal(row.status, "evaluated");
  assert.equal(
    new Date(row.occurred_at).toISOString(),
    new Date(row.canonical_created_at).toISOString(),
  );
  assert.equal(new Date(row.recorded_at).toISOString(), stamp);
  assert.equal(
    row.policy_fingerprint,
    sha(`synthetic-original-policy:${slug}`),
  );
  assert.deepEqual(row.recipients, recipients(slug));
  const effects = (
    await database.query(
      "SELECT id,state FROM staff_push_deliveries WHERE organization_id=$1 AND lead_id=$2",
      [original.organization, original.lead],
    )
  ).rows;
  assert.deepEqual(effects, [{ id: coverage.effect, state: "indeterminate" }]);
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS n FROM staff_push_deliveries WHERE id=$1",
        [coverage.removedEffect],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS n FROM staff_lead_alert_coverage WHERE organization_id=$1 AND lead_id=$2",
        [original.organization, sourceNurtureIds(slug).lead],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await database.query(
        "SELECT policy->>'enabled' AS enabled FROM staff_push_policies WHERE organization_id=$1",
        [original.organization],
      )
    ).rows[0].enabled,
    "false",
  );
}
export async function assertLeadAlertCoverageConstraints(
  database,
  slug,
  foreignSlug,
) {
  const original = fixtureIds(slug),
    foreign = fixtureIds(foreignSlug);
  const probes = [
    [
      "UPDATE staff_lead_alert_coverage SET lead_id=$2 WHERE organization_id=$1",
      [original.organization, foreign.lead],
    ],
    [
      "INSERT INTO staff_lead_alert_coverage SELECT * FROM staff_lead_alert_coverage WHERE organization_id=$1",
      [original.organization],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET version=2 WHERE organization_id=$1",
      [original.organization],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET status='received' WHERE organization_id=$1",
      [original.organization],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET policy_fingerprint=NULL WHERE organization_id=$1",
      [original.organization],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET policy_fingerprint='raw-policy' WHERE organization_id=$1",
      [original.organization],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET recipients='[]'::jsonb WHERE organization_id=$1",
      [original.organization],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET recipients='{}'::jsonb WHERE organization_id=$1",
      [original.organization],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET recipients=$2::jsonb WHERE organization_id=$1",
      [
        original.organization,
        JSON.stringify(
          Array.from({ length: 21 }, (_, i) => ({
            userId: `synthetic-${i}`,
            outcome: "no_eligible_device",
            deliveryIds: [],
          })),
        ),
      ],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET recipients=$2::jsonb WHERE organization_id=$1",
      [
        original.organization,
        JSON.stringify([
          {
            userId: "x".repeat(16400),
            outcome: "no_eligible_device",
            deliveryIds: [],
          },
        ]),
      ],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET status='policy_disabled' WHERE organization_id=$1",
      [original.organization],
    ],
    [
      "UPDATE staff_lead_alert_coverage SET status='historical_unknown',recipients='[]'::jsonb WHERE organization_id=$1",
      [original.organization],
    ],
  ];
  for (const [query, values] of probes) {
    await database.exec("BEGIN");
    try {
      await assert.rejects(database.query(query, values));
    } finally {
      await database.exec("ROLLBACK");
    }
  }
  return probes.length;
}
