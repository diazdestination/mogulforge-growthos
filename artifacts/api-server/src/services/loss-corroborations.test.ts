import {
  claimCasesTable,
  claimEvidenceArtifactsTable,
  contactsTable,
  db,
  estimatesTable,
  leadsTable,
  organizationsTable,
  propertiesTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileNativeEstimateForClaim } from "./claim-graphs";
import {
  compileLossCorroboration,
  listLossCorroborations,
  LossCorroborationError,
  reviewLossCorroboration,
} from "./loss-corroborations";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

let org: { id: string };
let actorId: string;
let claimCase: { id: string };
let graph: { id: string };
let weatherArtifact: { id: string };
let inspectionArtifact: { id: string };

beforeAll(async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [org] = await db
    .insert(organizationsTable)
    .values({ name: "Loss Corroboration Test Roofing", slug: `test-loss-corroboration-${nonce}` })
    .returning();
  actorId = `loss-corroboration-test-user-${nonce}`;
  await db.insert(usersTable).values({
    id: actorId,
    email: `loss-corroboration-${nonce}@example.test`,
    organizationId: org.id,
    role: "owner",
  });
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Case" }).returning();
  const [property] = await db
    .insert(propertiesTable)
    .values({
      organizationId: org.id,
      contactId: contact.id,
      addressLine1: "418 Ridgeview Dr",
      city: "Dallas",
      state: "TX",
      postalCode: "75201",
      latitude: "32.7767",
      longitude: "-96.7970",
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id, status: "estimate_sent" })
    .returning();
  [claimCase] = await db
    .insert(claimCasesTable)
    .values({
      organizationId: org.id,
      leadId: lead.id,
      propertyId: property.id,
      title: "Hail loss",
      lossDate: new Date("2026-05-15T00:00:00.000Z"),
      createdByUserId: actorId,
      updatedByUserId: actorId,
    })
    .returning();
  const [estimate] = await db
    .insert(estimatesTable)
    .values({
      organizationId: org.id,
      leadId: lead.id,
      title: "Roof restoration",
      lineItems: [{ description: "Shingles", quantity: 10, unitPriceCents: 10_000, totalCents: 100_000 }],
      subtotalCents: 100_000,
      taxCents: 8_250,
      totalCents: 108_250,
    })
    .returning();
  graph = await compileNativeEstimateForClaim(org.id, claimCase.id, estimate.id, actorId);
  [weatherArtifact] = await db
    .insert(claimEvidenceArtifactsTable)
    .values({
      organizationId: org.id,
      caseId: claimCase.id,
      kind: "weather",
      filename: "weather-feed.txt",
      mimeType: "text/plain",
      sizeBytes: 20,
      sha256: "b".repeat(64),
      sourceLabel: "Weather feed",
      createdByUserId: actorId,
    })
    .returning();
  [inspectionArtifact] = await db
    .insert(claimEvidenceArtifactsTable)
    .values({
      organizationId: org.id,
      caseId: claimCase.id,
      kind: "document",
      filename: "inspection.pdf",
      mimeType: "application/pdf",
      sizeBytes: 20,
      sha256: "c".repeat(64),
      sourceLabel: "Inspection report",
      createdByUserId: actorId,
    })
    .returning();
});

afterAll(async () => {
  await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, actorId));
  await deleteTestOrgs(org.id);
  await db.delete(usersTable).where(eq(usersTable.id, actorId));
});

function sourceInputs() {
  return [
    {
      sourceArtifactId: weatherArtifact.id,
      sourceKind: "weather" as const,
      provider: "Weather test provider",
      providerVersion: "1.0",
      retrievedAt: "2026-05-16T00:00:00.000Z",
      qualityScore: 92,
      coverageScore: 90,
      missingFields: [],
      temporalCoverage: { startsAt: "2026-05-01T00:00:00.000Z", endsAt: "2026-05-31T23:59:59.000Z" },
      observations: [{
        id: "weather-hail",
        signal: "supporting" as const,
        phenomenon: "hail",
        observedAt: "2026-05-15T00:00:00.000Z",
        magnitudeScore: 90,
        coordinates: { latitude: 32.7767, longitude: -96.797 },
        directionDegrees: 180,
      }],
    },
    {
      sourceArtifactId: inspectionArtifact.id,
      sourceKind: "inspection" as const,
      provider: "Independent inspection test provider",
      providerVersion: "1.0",
      retrievedAt: "2026-05-17T00:00:00.000Z",
      qualityScore: 88,
      coverageScore: 84,
      missingFields: [],
      temporalCoverage: { startsAt: "2026-05-10T00:00:00.000Z", endsAt: "2026-05-20T00:00:00.000Z" },
      observations: [{
        id: "inspection-hail",
        signal: "supporting" as const,
        phenomenon: "hail",
        observedAt: "2026-05-16T00:00:00.000Z",
        magnitudeScore: 78,
        coordinates: { latitude: 32.78, longitude: -96.79 },
        directionDegrees: 180,
      }],
    },
  ];
}

describe("loss corroboration persistence service", () => {
  it("binds a deterministic assessment to a valid claim graph and case-owned source artifacts", async () => {
    const created = await compileLossCorroboration(org.id, claimCase.id, actorId, {
      canonicalGraphId: graph.id,
      propertyCoordinates: null,
      roofFacets: [{ id: "south", azimuthDegrees: 180 }],
      sources: sourceInputs(),
    });
    expect(created.status).toBe("computed");
    expect(created.sourceManifestHash).toHaveLength(64);
    expect(created.assessmentHash).toHaveLength(64);

    const records = await listLossCorroborations(org.id, claimCase.id);
    expect(records[0]?.id).toBe(created.id);
  });

  it("requires a tenant/case-owned source artifact", async () => {
    await expect(
      compileLossCorroboration(org.id, claimCase.id, actorId, {
        canonicalGraphId: graph.id,
        propertyCoordinates: null,
        roofFacets: [],
        sources: [{ ...sourceInputs()[0]!, sourceArtifactId: "00000000-0000-4000-8000-000000000099" }],
      }),
    ).rejects.toMatchObject({ statusCode: 409 } satisfies Partial<LossCorroborationError>);
  });

  it("makes a human review immutable", async () => {
    const latest = (await listLossCorroborations(org.id, claimCase.id))[0]!;
    const reviewed = await reviewLossCorroboration(org.id, claimCase.id, latest.id, actorId, "verified", "Inputs and limitations reviewed.");
    expect(reviewed.status).toBe("verified");
    await expect(
      reviewLossCorroboration(org.id, claimCase.id, latest.id, actorId, "rejected", null),
    ).rejects.toMatchObject({ statusCode: 409 } satisfies Partial<LossCorroborationError>);
  });
});
