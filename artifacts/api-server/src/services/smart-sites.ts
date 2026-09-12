import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  propertiesTable,
  smartSitesTable,
  smartSiteSubmissionsTable,
} from "@workspace/db";
import {
  SMART_SITE_PROFILES,
  type SmartSiteIntake,
} from "./smart-site-contract";
import { buildTouch, leadAttributionColumns } from "./attribution";

export class SmartSiteError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const publicFields = {
  id: smartSitesTable.id,
  name: smartSitesTable.name,
  siteKey: smartSitesTable.siteKey,
  profile: smartSitesTable.profile,
  source: smartSitesTable.source,
  isActive: smartSitesTable.isActive,
  createdAt: smartSitesTable.createdAt,
};

export async function listSmartSites(organizationId: string) {
  return db
    .select(publicFields)
    .from(smartSitesTable)
    .where(eq(smartSitesTable.organizationId, organizationId))
    .orderBy(desc(smartSitesTable.createdAt));
}

export async function createSmartSite(
  organizationId: string,
  actorUserId: string,
  input: { name: string; siteKey: string; profile: string },
) {
  if (!SMART_SITE_PROFILES.some((p) => p.id === input.profile))
    throw new SmartSiteError("unknown_profile");
  const secret = `ss_${randomBytes(32).toString("hex")}`;
  const site = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(smartSitesTable)
      .values({
        ...input,
        organizationId,
        source: input.siteKey,
        keyHash: hash(secret),
      })
      .returning(publicFields);
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId,
        actorUserId,
        action: "smart_site.created",
        entityType: "smart_site",
        entityId: row.id,
        metadata: { profile: input.profile, active: false },
      });
    return row;
  });
  return { ...site, secret };
}

export async function updateSmartSite(
  organizationId: string,
  actorUserId: string,
  id: string,
  active: boolean,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(smartSitesTable)
      .set({ isActive: active, updatedAt: new Date() })
      .where(
        and(
          eq(smartSitesTable.organizationId, organizationId),
          eq(smartSitesTable.id, id),
        ),
      )
      .returning(publicFields);
    if (!row) throw new SmartSiteError("site_not_found", 404);
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId,
        actorUserId,
        action: active ? "smart_site.enabled" : "smart_site.disabled",
        entityType: "smart_site",
        entityId: id,
      });
    return row;
  });
}

export async function rotateSmartSiteKey(
  organizationId: string,
  actorUserId: string,
  id: string,
) {
  const secret = `ss_${randomBytes(32).toString("hex")}`;
  return db.transaction(async (tx) => {
    const [site] = await tx
      .update(smartSitesTable)
      .set({ keyHash: hash(secret), isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(smartSitesTable.organizationId, organizationId),
          eq(smartSitesTable.id, id),
        ),
      )
      .returning(publicFields);
    if (!site) throw new SmartSiteError("site_not_found", 404);
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId,
        actorUserId,
        action: "smart_site.key_rotated",
        entityType: "smart_site",
        entityId: id,
        metadata: { active: false },
      });
    return { ...site, secret };
  });
}

export async function authenticateSmartSite(id: string, secret: string) {
  if (!/^ss_[a-f0-9]{64}$/.test(secret))
    throw new SmartSiteError("invalid_site_credentials", 401);
  const [site] = await db
    .select()
    .from(smartSitesTable)
    .where(eq(smartSitesTable.id, id));
  if (
    !site ||
    !timingSafeEqual(
      Buffer.from(site.keyHash, "hex"),
      Buffer.from(hash(secret), "hex"),
    )
  )
    throw new SmartSiteError("invalid_site_credentials", 401);
  if (!site.isActive) throw new SmartSiteError("site_capture_disabled", 503);
  return site;
}

/** All authoritative writes commit together. No email, LLM or background scheduler is required. */
export async function captureSmartSiteInquiry(
  site: typeof smartSitesTable.$inferSelect,
  input: SmartSiteIntake,
) {
  const profile = SMART_SITE_PROFILES.find((p) => p.id === site.profile);
  const service = profile?.services.find(
    (s) => s[0] === input.project.serviceCode,
  );
  if (!service) throw new SmartSiteError("service_not_allowed");
  const payloadHash = hash(JSON.stringify(input));
  const organizationId = site.organizationId;
  return db.transaction(async (tx) => {
    // Low-volume acquisition per tenant: serialize contact matching and duplicate receipt creation.
    // Transaction-scoped locks release on crash/rollback, unlike a stranded "pending" reservation.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`smart-site:${organizationId}`}, 0))`,
    );
    const [currentSite] = await tx
      .select()
      .from(smartSitesTable)
      .where(eq(smartSitesTable.id, site.id))
      .for("share");
    if (!currentSite?.isActive || currentSite.keyHash !== site.keyHash)
      throw new SmartSiteError("site_capture_disabled", 503);
    const [receipt] = await tx
      .select()
      .from(smartSiteSubmissionsTable)
      .where(
        and(
          eq(smartSiteSubmissionsTable.siteId, site.id),
          eq(smartSiteSubmissionsTable.requestId, input.requestId),
        ),
      );
    if (receipt) {
      if (receipt.payloadHash !== payloadHash)
        throw new SmartSiteError("idempotency_conflict", 409);
      return {
        status: "saved" as const,
        leadId: receipt.leadId,
        receiptId: receipt.id,
        duplicate: true,
        notification: "staff-inbox" as const,
      };
    }
    const matchers = [];
    if (input.contact.email)
      matchers.push(
        sql`lower(${contactsTable.email}) = ${input.contact.email}`,
      );
    if (input.contact.phone)
      matchers.push(
        sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g') = ${input.contact.phone}`,
      );
    const existing = await tx
      .select()
      .from(contactsTable)
      .where(
        and(eq(contactsTable.organizationId, organizationId), or(...matchers)),
      )
      .limit(2);
    if (existing.length > 1)
      throw new SmartSiteError("contact_match_needs_review", 409);
    const parts = input.contact.name.split(/\s+/);
    const contact =
      existing[0] ??
      (
        await tx
          .insert(contactsTable)
          .values({
            organizationId,
            firstName: parts[0],
            lastName: parts.slice(1).join(" ") || null,
            email: input.contact.email,
            phone: input.contact.phone,
          })
          .returning()
      )[0];
    let propertyId: string | undefined;
    const p = input.project;
    // Never manufacture a property when the visitor supplied only a ZIP or partial address.
    if (p.address && p.city && p.state && p.postalCode) {
      const [property] = await tx
        .select()
        .from(propertiesTable)
        .where(
          and(
            eq(propertiesTable.organizationId, organizationId),
            eq(propertiesTable.contactId, contact.id),
            eq(propertiesTable.addressLine1, p.address),
            eq(propertiesTable.postalCode, p.postalCode),
          ),
        )
        .limit(1);
      propertyId =
        property?.id ??
        (
          await tx
            .insert(propertiesTable)
            .values({
              organizationId,
              contactId: contact.id,
              addressLine1: p.address,
              city: p.city,
              state: p.state,
              postalCode: p.postalCode,
            })
            .returning()
        )[0].id;
    }
    const a = input.attribution;
    const touch = buildTouch({
      channel: "smart-site",
      source: site.source,
      attribution: a
        ? {
            utmSource: a.source,
            utmMedium: a.medium,
            utmCampaign: a.campaign,
            landingPage: a.landingPath,
            referrer: a.referrerHost,
          }
        : undefined,
    });
    const urgency = p.timing === "urgent" ? "high" : "normal";
    // A new request is a new project inquiry, even for an existing contact. Retries use requestId.
    const [lead] = await tx
      .insert(leadsTable)
      .values({
        organizationId,
        contactId: contact.id,
        propertyId,
        serviceType: service[1],
        urgency,
        status: "new",
        summary: p.summary || `${service[1]} inquiry`,
        ...leadAttributionColumns({
          source: site.source,
          creationMethod: "smart-site",
          touch,
        }),
      })
      .returning();
    const consent = {
      ...input.consent,
      receivedAt: new Date().toISOString(),
      scope: "respond-to-this-inquiry",
    };
    const [saved] = await tx
      .insert(smartSiteSubmissionsTable)
      .values({
        organizationId,
        siteId: site.id,
        requestId: input.requestId,
        payloadHash,
        leadId: lead.id,
        consent,
      })
      .returning();
    const inquiryBody = [
      p.summary,
      `Service: ${service[1]} · Timing: ${p.timing}`,
      p.postalCode ? `Property ZIP: ${p.postalCode}` : null,
      `Submitted by: ${input.contact.name}`,
      input.contact.phone ? `Callback: ${input.contact.phone}` : null,
      input.contact.email ? `Email: ${input.contact.email}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    // Preserve submitted contact facts without silently overwriting an existing contact.
    await tx
      .insert(activitiesTable)
      .values({
        organizationId,
        leadId: lead.id,
        contactId: contact.id,
        type: "lead_captured",
        title: `Inquiry from ${site.name}`,
        body: inquiryBody,
        metadata: {
          smartSiteId: site.id,
          receiptId: saved.id,
          serviceCode: p.serviceCode,
          timing: p.timing,
          postalCode: p.postalCode,
          address: p.address,
          city: p.city,
          state: p.state,
          submittedContact: input.contact,
          consent,
        },
      });
    await tx
      .insert(crmTasksTable)
      .values({
        organizationId,
        leadId: lead.id,
        contactId: contact.id,
        title: `Review ${service[1].toLowerCase()} inquiry`,
        description:
          "Contact permission covers this inquiry only. Assign an owner and record the follow-up; no email, SMS, appointment or dispatch has been sent or confirmed.",
        sourceEvent: "smart_site.lead_saved",
        priority: urgency,
      });
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId,
        action: "smart_site.lead_saved",
        entityType: "lead",
        entityId: lead.id,
        metadata: {
          siteId: site.id,
          receiptId: saved.id,
          serviceCode: p.serviceCode,
        },
      });
    return {
      status: "saved" as const,
      leadId: lead.id,
      receiptId: saved.id,
      duplicate: false,
      notification: "staff-inbox" as const,
    };
  });
}

export async function smartSiteOverview(organizationId: string) {
  const rows = await db
    .select({
      siteId: smartSitesTable.id,
      siteName: smartSitesTable.name,
      service: leadsTable.serviceType,
      captured: sql<number>`count(*)::int`,
      unassigned: sql<number>`count(*) filter (where ${leadsTable.assignedUserId} is null and ${leadsTable.status} not in ('won','lost','completed'))::int`,
      won: sql<number>`count(*) filter (where ${leadsTable.wonAt} is not null)::int`,
      contractValueCents: sql<number>`coalesce(sum(${leadsTable.wonRevenueCents}) filter (where ${leadsTable.wonAt} is not null),0)::float8`,
    })
    .from(smartSiteSubmissionsTable)
    .innerJoin(
      smartSitesTable,
      and(
        eq(smartSitesTable.id, smartSiteSubmissionsTable.siteId),
        eq(smartSitesTable.organizationId, organizationId),
      ),
    )
    .innerJoin(
      leadsTable,
      and(
        eq(leadsTable.id, smartSiteSubmissionsTable.leadId),
        eq(leadsTable.organizationId, organizationId),
      ),
    )
    .where(eq(smartSiteSubmissionsTable.organizationId, organizationId))
    .groupBy(smartSitesTable.id, smartSitesTable.name, leadsTable.serviceType);
  const recent = await db
    .select({
      leadId: leadsTable.id,
      name: sql<string>`concat_ws(' ', ${contactsTable.firstName}, ${contactsTable.lastName})`,
      service: leadsTable.serviceType,
      status: leadsTable.status,
      createdAt: leadsTable.createdAt,
      source: leadsTable.source,
    })
    .from(smartSiteSubmissionsTable)
    .innerJoin(
      leadsTable,
      and(
        eq(leadsTable.id, smartSiteSubmissionsTable.leadId),
        eq(leadsTable.organizationId, organizationId),
      ),
    )
    .innerJoin(
      contactsTable,
      and(
        eq(contactsTable.id, leadsTable.contactId),
        eq(contactsTable.organizationId, organizationId),
      ),
    )
    .where(eq(smartSiteSubmissionsTable.organizationId, organizationId))
    .orderBy(desc(smartSiteSubmissionsTable.createdAt))
    .limit(8);
  return {
    scope: "all-time smart-site inquiries",
    rows,
    recent,
    measurement: {
      saved: "Database receipts, not form clicks",
      contractValue: "Recorded won value; not collected cash or profit",
      notification:
        "Staff inbox only; external delivery is not configured by Smart Sites",
    },
  };
}
