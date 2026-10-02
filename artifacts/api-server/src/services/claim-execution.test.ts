import {
  claimCasesTable,
  claimCertificatesTable,
  claimEvidenceRunsTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  ClaimExecutionError,
  compileClaimRoutePacket,
  preflightClaimRoutePacket,
  prepareClaimRouteExecution,
} from "./claim-execution";

let org: { id: string };
let actorId: string;
let claimCase: { id: string };
let issuedCertificate: { id: string };

beforeAll(async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [organization] = await db
    .insert(organizationsTable)
    .values({ name: "Claim Kernel Test Roofing", slug: `test-claim-kernel-${nonce}` })
    .returning();
  org = organization;
  actorId = `claim-kernel-test-user-${nonce}`;
  await db.insert(usersTable).values({
    id: actorId,
    email: `claim-kernel-${nonce}@example.test`,
    organizationId: org.id,
    role: "owner",
  });
  const [createdCase] = await db
    .insert(claimCasesTable)
    .values({ organizationId: org.id, title: "Hail loss", lossType: "hail", createdByUserId: actorId, updatedByUserId: actorId })
    .returning();
  claimCase = createdCase;
  const [run] = await db
    .insert(claimEvidenceRunsTable)
    .values({
      organizationId: org.id,
      caseId: claimCase.id,
      status: "completed",
      model: "test-model",
      promptVersion: "test-prompt-v1",
      manifest: { version: "test", artifacts: [] },
      manifestHash: "a".repeat(64),
      initiatedByUserId: actorId,
      completedAt: new Date(),
    })
    .returning();
  const [certificate] = await db
    .insert(claimCertificatesTable)
    .values({
      organizationId: org.id,
      caseId: claimCase.id,
      runId: run.id,
      version: 1,
      status: "issued",
      executiveSummary: "Human-reviewed test certificate.",
      contentHash: "b".repeat(64),
      integrityVersion: "test-integrity-v1",
      integrityHash: "c".repeat(64),
      integrityManifest: {
        policy: {
          allObservationsReviewed: true,
          verifiedObservationCount: 1,
        },
      },
      issuedByUserId: actorId,
      issuedAt: new Date(),
      createdByUserId: actorId,
    })
    .returning();
  issuedCertificate = certificate;
});

afterAll(async () => {
  await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, actorId));
  await deleteTestOrgs(org.id);
  await db.delete(usersTable).where(eq(usersTable.id, actorId));
});

describe("Claim route compilation", () => {
  it("refuses to compile a route packet from a non-issued certificate", async () => {
    const [draft] = await db
      .insert(claimCertificatesTable)
      .values({
        organizationId: org.id,
        caseId: claimCase.id,
        runId: (await db.select({ id: claimEvidenceRunsTable.id }).from(claimEvidenceRunsTable).where(eq(claimEvidenceRunsTable.caseId, claimCase.id)).limit(1))[0]!.id,
        version: 2,
        executiveSummary: "Draft only.",
        contentHash: "d".repeat(64),
        integrityHash: "e".repeat(64),
        integrityManifest: { policy: { allObservationsReviewed: true, verifiedObservationCount: 1 } },
        createdByUserId: actorId,
      })
      .returning();
    await expect(
      compileClaimRoutePacket(org.id, claimCase.id, actorId, {
        certificateId: draft.id,
        target: "carrier-demo",
        operation: "submit",
        adapterName: "demo-adapter",
        adapterVersion: "1.0.0",
        adapterFingerprint: "demo-fingerprint",
        postconditions: [{ code: "confirmation", description: "Confirmation is recorded." }],
        capabilityRequirements: ["target:write"],
      }),
    ).rejects.toMatchObject({ statusCode: 409 } satisfies Partial<ClaimExecutionError>);
  });

  it("creates one immutable packet and reserves its only execution attempt after preflight", async () => {
    const route = await compileClaimRoutePacket(org.id, claimCase.id, actorId, {
      certificateId: issuedCertificate.id,
      target: "carrier-demo",
      operation: "submit-claim-package",
      adapterName: "demo-adapter",
      adapterVersion: "1.0.0",
      adapterFingerprint: "demo-fingerprint",
      postconditions: [{ code: "confirmation", description: "A confirmation number is captured." }],
      capabilityRequirements: ["target:write", "claim:submit"],
    });
    expect(route.packetHash).toHaveLength(64);
    expect(route.idempotencyKey).toHaveLength(64);
    expect(route.status).toBe("ready");

    const blocked = await preflightClaimRoutePacket(org.id, claimCase.id, route.id, "wrong-fingerprint");
    expect(blocked.allowed).toBe(false);

    const allowed = await preflightClaimRoutePacket(org.id, claimCase.id, route.id, "demo-fingerprint");
    expect(allowed.allowed).toBe(true);

    const prepared = await prepareClaimRouteExecution(org.id, claimCase.id, route.id, actorId, "demo-fingerprint");
    expect(prepared.state).toBe("prepared");
    expect(prepared.receiptHash).toHaveLength(64);

    await expect(
      prepareClaimRouteExecution(org.id, claimCase.id, route.id, actorId, "demo-fingerprint"),
    ).rejects.toMatchObject({ statusCode: 409 } satisfies Partial<ClaimExecutionError>);
  });
});
