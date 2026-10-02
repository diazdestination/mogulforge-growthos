import {
  claimCasesTable,
  contactsTable,
  db,
  estimatesTable,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  ClaimGraphError,
  compileClaimGraphForTarget,
  compileNativeEstimateForClaim,
} from "./claim-graphs";

let org: { id: string };
let actorId: string;
let claimCase: { id: string };
let validEstimate: { id: string };

beforeAll(async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [organization] = await db
    .insert(organizationsTable)
    .values({ name: "Claim Graph Test Roofing", slug: `test-claim-graph-${nonce}` })
    .returning();
  org = organization;
  actorId = `claim-graph-test-user-${nonce}`;
  await db.insert(usersTable).values({
    id: actorId,
    email: `claim-graph-${nonce}@example.test`,
    organizationId: org.id,
    role: "owner",
  });
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Graph" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id, status: "estimate_sent" })
    .returning();
  const [createdCase] = await db
    .insert(claimCasesTable)
    .values({ organizationId: org.id, leadId: lead.id, title: "Hail loss", createdByUserId: actorId, updatedByUserId: actorId })
    .returning();
  claimCase = createdCase;
  const [estimate] = await db
    .insert(estimatesTable)
    .values({
      organizationId: org.id,
      leadId: lead.id,
      title: "Roof restoration",
      lineItems: [
        { description: "Shingles", quantity: 10, unitPriceCents: 10_000, totalCents: 100_000 },
        { description: "Ridge cap", quantity: 2, unitPriceCents: 5_000, totalCents: 10_000 },
      ],
      subtotalCents: 110_000,
      taxCents: 8_800,
      totalCents: 118_800,
    })
    .returning();
  validEstimate = estimate;
});

afterAll(async () => {
  await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, actorId));
  await deleteTestOrgs(org.id);
  await db.delete(usersTable).where(eq(usersTable.id, actorId));
});

describe("Native estimate claim graph service", () => {
  it("persists a valid source-ledger graph and compiles two target profiles", async () => {
    const graph = await compileNativeEstimateForClaim(org.id, claimCase.id, validEstimate.id, actorId);
    expect(graph.status).toBe("valid");
    expect(graph.graphHash).toHaveLength(64);

    const estimateProfile = await compileClaimGraphForTarget(
      org.id,
      claimCase.id,
      graph.id,
      "mogulforge-estimate-v1",
    );
    const statementProfile = await compileClaimGraphForTarget(
      org.id,
      claimCase.id,
      graph.id,
      "contractor-claim-statement-v1",
    );
    expect(estimateProfile.sourceGraphDigest).toBe(graph.graphHash);
    expect(statementProfile.sourceGraphDigest).toBe(graph.graphHash);
    expect(estimateProfile.digest).not.toBe(statementProfile.digest);
  });

  it("keeps a corrupted source graph diagnosable but blocks target compilation", async () => {
    const [corruptEstimate] = await db
      .insert(estimatesTable)
      .values({
        organizationId: org.id,
        leadId: (await db.select({ leadId: claimCasesTable.leadId }).from(claimCasesTable).where(eq(claimCasesTable.id, claimCase.id)).limit(1))[0]!.leadId!,
        title: "Corrupt total test",
        lineItems: [{ description: "Shingles", quantity: 1, unitPriceCents: 10_000, totalCents: 1 }],
        subtotalCents: 1,
        taxCents: 0,
        totalCents: 1,
      })
      .returning();
    const graph = await compileNativeEstimateForClaim(org.id, claimCase.id, corruptEstimate.id, actorId);
    expect(graph.status).toBe("invalid");
    await expect(
      compileClaimGraphForTarget(org.id, claimCase.id, graph.id, "mogulforge-estimate-v1"),
    ).rejects.toMatchObject({ statusCode: 409 } satisfies Partial<ClaimGraphError>);
  });
});
