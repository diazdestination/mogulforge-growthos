import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  auditEventsTable,
  db,
  organizationsTable,
  orgSettingsTable,
  usersTable,
  smartSitesTable,
  smartSiteOnboardingsTable,
  smartSiteSubmissionsTable,
  GENERIC_APPOINTMENT_REMINDER,
  GENERIC_CONCIERGE_SETTINGS,
  GENERIC_LEAD_SCORING,
} from "@workspace/db";
import { SMART_SITE_PROFILES } from "./smart-site-contract";
import { SmartSiteError } from "./smart-sites";
import { hasPermission } from "../lib/permissions";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/)
  .refine(
    (v) => !["api", "www", "admin", "platform", "app", "public"].includes(v),
  );
export const clientDraftSchema = z
  .object({
    requestId: z.uuid(),
    name: z.string().trim().min(2).max(120),
    slug: slugSchema,
    profile: z
      .string()
      .refine((v) => SMART_SITE_PROFILES.some((p) => p.id === v)),
    timezone: z
      .string()
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    responseTargetMinutes: z.number().int().min(5).max(10080),
    confirmed: z.literal(true),
  })
  .strict();

/** All-or-nothing provisioning. Does NOT join, impersonate, invite, seed outreach or activate. */
export async function createClientDraft(
  actorUserId: string,
  input: z.infer<typeof clientDraftSchema>,
) {
  const { requestId, ...configuration } = input;
  const payloadHash = hash(JSON.stringify(configuration));
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`client-onboarding:${actorUserId}:${requestId}`}))`,
    );
    const [prior] = await tx
      .select()
      .from(smartSiteOnboardingsTable)
      .where(
        and(
          eq(smartSiteOnboardingsTable.actorUserId, actorUserId),
          eq(smartSiteOnboardingsTable.requestId, requestId),
        ),
      );
    if (prior) {
      if (prior.payloadHash !== payloadHash)
        throw new SmartSiteError("request_changed", 409);
      return {
        organizationId: prior.organizationId,
        siteId: prior.siteId,
        duplicate: true,
      };
    }
    const [org] = await tx
      .insert(organizationsTable)
      .values({ name: input.name, slug: input.slug, timezone: input.timezone })
      .onConflictDoNothing()
      .returning();
    if (!org) throw new SmartSiteError("identifier_taken", 409);
    const profile = SMART_SITE_PROFILES.find((p) => p.id === input.profile)!;
    await tx.insert(orgSettingsTable).values({
      organizationId: org.id,
      businessProfile: { businessName: org.name },
      services: profile.services.map(([slug, name]) => ({
        slug,
        name,
        isActive: true,
      })),
      serviceAreas: [],
      leadScoring: GENERIC_LEAD_SCORING,
      appointmentReminder: GENERIC_APPOINTMENT_REMINDER,
      concierge: GENERIC_CONCIERGE_SETTINGS,
      widget: { leadCaptureEnabled: false, conciergeEnabled: false },
      onboarding: { completedSteps: [], currentStep: "company" },
    });
    const [site] = await tx
      .insert(smartSitesTable)
      .values({
        organizationId: org.id,
        name: `${org.name} website`,
        siteKey: `${org.slug}-website`,
        source: `${org.slug}-website`,
        profile: input.profile,
        responseTargetMinutes: input.responseTargetMinutes,
        // Unissued random credential, deliberately discarded. Explicit key issuance comes later.
        keyHash: hash(randomBytes(32).toString("hex")),
        isActive: false,
      })
      .returning({ id: smartSitesTable.id });
    await tx
      .insert(smartSiteOnboardingsTable)
      .values({
        organizationId: org.id,
        siteId: site.id,
        actorUserId,
        requestId,
        payloadHash,
      });
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId: org.id,
        actorUserId,
        action: "smart_site.client_draft_created",
        entityType: "smart_site",
        entityId: site.id,
        metadata: {
          profile: input.profile,
          requestId,
          active: false,
          joined: false,
        },
      });
    return { organizationId: org.id, siteId: site.id, duplicate: false };
  });
}

export async function clientReadiness(organizationId: string) {
  const [organization] = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      timezone: organizationsTable.timezone,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  if (!organization) throw new SmartSiteError("organization_not_found", 404);
  const members = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.organizationId, organizationId),
        eq(usersTable.isActive, true),
      ),
    );
  const staffing = {
    activeManagers: members.filter((u) =>
      hasPermission(u.role, "settings.manage"),
    ).length,
    activeResponders: members.filter((u) => hasPermission(u.role, "crm.write"))
      .length,
  };
  // Allowlisted data only. A platform selector is not permission to expose another client's CRM.
  const sites = await db
    .select({
      id: smartSitesTable.id,
      name: smartSitesTable.name,
      profile: smartSitesTable.profile,
      source: smartSitesTable.source,
      isActive: smartSitesTable.isActive,
      responseTargetMinutes: smartSitesTable.responseTargetMinutes,
      credentialIssuedAt: smartSitesTable.credentialIssuedAt,
      credentialVersion: smartSitesTable.credentialVersion,
      credentialCheckedAt: smartSitesTable.credentialCheckedAt,
    })
    .from(smartSitesTable)
    .where(eq(smartSitesTable.organizationId, organizationId))
    .orderBy(desc(smartSitesTable.createdAt));
  const receipts = await db
    .select({
      siteId: smartSiteSubmissionsTable.siteId,
      lastSavedAt: sql<
        Date | string
      >`max(${smartSiteSubmissionsTable.createdAt})`,
    })
    .from(smartSiteSubmissionsTable)
    .where(eq(smartSiteSubmissionsTable.organizationId, organizationId))
    .groupBy(smartSiteSubmissionsTable.siteId);
  return {
    organization,
    staffing,
    serverNow: new Date().toISOString(),
    sites: sites.map((site) => ({
      ...site,
      lastSavedAt:
        receipts.find((r) => r.siteId === site.id)?.lastSavedAt ?? null,
    })),
    releaseStatus: "not_assessed" as const,
    releaseGates: [
      "Client-approved staff and contact policy",
      "Server secret installation and HTTPS form acceptance",
      "Encrypted recovery, scheduled retries and operator alerts",
      "Retention, key backup and public-form abuse protection",
      "Approved deployment and database migration",
    ],
  };
}

/** A credential-only handshake; no lead, simulated sale, auto-enrollment or outbound request. */
export async function checkSiteCredential(id: string, secret: string) {
  if (!/^ss_[a-f0-9]{64}$/.test(secret))
    throw new SmartSiteError("invalid_site_credentials", 401);
  return db.transaction(async (tx) => {
    const [site] = await tx
      .select()
      .from(smartSitesTable)
      .where(eq(smartSitesTable.id, id))
      .for("update");
    if (
      !site ||
      !timingSafeEqual(
        Buffer.from(site.keyHash, "hex"),
        Buffer.from(hash(secret), "hex"),
      )
    )
      throw new SmartSiteError("invalid_site_credentials", 401);
    const checkedAt = new Date();
    await tx
      .update(smartSitesTable)
      .set({ credentialCheckedAt: checkedAt })
      .where(eq(smartSitesTable.id, id));
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId: site.organizationId,
        action: "smart_site.credential_checked",
        entityType: "smart_site",
        entityId: id,
        metadata: {
          credentialVersion: site.credentialVersion,
          evidence: "credential_only",
        },
      });
    return {
      status: "credential_verified",
      siteId: id,
      profile: site.profile,
      captureEnabled: site.isActive,
      credentialVersion: site.credentialVersion,
      checkedAt,
      createsLead: false,
    };
  });
}
