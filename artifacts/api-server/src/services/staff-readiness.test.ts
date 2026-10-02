import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import {
  db,
  organizationsTable,
  usersTable,
  smartSitesTable,
  leadsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { clientReadiness } from "./client-onboarding";
import {
  captureSmartSiteInquiry,
  smartSiteLaunchReadiness,
} from "./smart-sites";
import { normalizeSmartSiteIntake } from "./smart-site-contract";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

const orgs: string[] = [];
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

it("pending invitations and unverified accounts cannot satisfy client staffing or accept an office inquiry", async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Synthetic pending staff", slug: `staff-${randomUUID()}` })
    .returning();
  orgs.push(org.id);
  await db.insert(usersTable).values([
    {
      id: `invite:${randomUUID()}`,
      organizationId: org.id,
      role: "owner",
      emailVerifiedAt: null,
    },
    { organizationId: org.id, role: "admin", emailVerifiedAt: null },
  ]);
  const [site] = await db
    .insert(smartSitesTable)
    .values({
      organizationId: org.id,
      name: "Synthetic HVAC",
      profile: "hvac",
      source: "staff-test",
      siteKey: randomUUID(),
      keyHash: "0".repeat(64),
      isActive: true,
    })
    .returning();
  const launch = await smartSiteLaunchReadiness(org.id);
  expect(launch.staffing).toEqual({ activeManagers: 0, activeResponders: 0 });
  expect((await clientReadiness(org.id)).staffing).toEqual({
    activeManagers: 0,
    activeResponders: 0,
  });
  const intake = normalizeSmartSiteIntake({
    schemaVersion: 1,
    requestId: randomUUID(),
    contact: { name: "Synthetic visitor", phone: "5551234567" },
    project: { serviceCode: "repair", timing: "soon" },
    consent: {
      contact: true,
      channels: ["phone"],
      analytics: false,
      policyVersion: "synthetic-v1",
    },
  });
  await expect(captureSmartSiteInquiry(site, intake)).rejects.toMatchObject({
    code: "site_staffing_unavailable",
  });
  expect(
    await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.organizationId, org.id)),
  ).toHaveLength(0);
  // Existing verified staff defaults remain eligible after the additive migration.
  await db.insert(usersTable).values({ organizationId: org.id, role: "owner" });
  expect((await smartSiteLaunchReadiness(org.id)).staffing).toEqual({
    activeManagers: 1,
    activeResponders: 1,
  });
  await expect(captureSmartSiteInquiry(site, intake)).resolves.toMatchObject({
    status: "saved",
  });
});
