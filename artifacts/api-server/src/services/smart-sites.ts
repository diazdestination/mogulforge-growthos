import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { enqueueStaffLeadPush } from "./staff-push";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  activitiesTable,
  analyticsEventsTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  propertiesTable,
  smartSitesTable,
  smartSiteSubmissionsTable,
  usersTable,
} from "@workspace/db";
import {
  SMART_SITE_PROFILES,
  type SmartSiteAcquisitionBatch,
  type SmartSiteIntake,
} from "./smart-site-contract";
import { buildTouch, leadAttributionColumns } from "./attribution";
import { hasPermission } from "../lib/permissions";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { customerWorkHeld } from "./customer-lifecycle-runtime";

export class SmartSiteError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public details?: Record<string, unknown>,
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
  responseTargetMinutes: smartSitesTable.responseTargetMinutes,
  analyticsEnabled: smartSitesTable.analyticsEnabled,
  analyticsRetentionDays: smartSitesTable.analyticsRetentionDays,
  analyticsPolicyVersion: smartSitesTable.analyticsPolicyVersion,
  credentialIssuedAt: smartSitesTable.credentialIssuedAt,
  credentialCheckedAt: smartSitesTable.credentialCheckedAt,
  credentialVersion: smartSitesTable.credentialVersion,
  createdAt: smartSitesTable.createdAt,
};

const SMART_SITE_CREDENTIAL_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
type SmartSiteLaunchBlocker =
  | "active_manager_required"
  | "active_responder_required"
  | "credential_issuance_not_recorded"
  | "credential_not_verified"
  | "credential_check_stale";
type LaunchSite = Pick<
  typeof smartSitesTable.$inferSelect,
  | "id"
  | "isActive"
  | "credentialIssuedAt"
  | "credentialCheckedAt"
  | "credentialVersion"
>;
type LaunchStaffing = { activeManagers: number; activeResponders: number };

function evaluateLaunchBlockers(
  site: LaunchSite,
  staffing: LaunchStaffing,
  now: Date,
): SmartSiteLaunchBlocker[] {
  const blockers: SmartSiteLaunchBlocker[] = [];
  if (staffing.activeManagers < 1) blockers.push("active_manager_required");
  if (staffing.activeResponders < 1) blockers.push("active_responder_required");
  if (!site.credentialCheckedAt) {
    blockers.push(
      site.credentialIssuedAt
        ? "credential_not_verified"
        : "credential_issuance_not_recorded",
    );
  } else if (
    site.credentialCheckedAt.getTime() <
    now.getTime() - SMART_SITE_CREDENTIAL_CHECK_MAX_AGE_MS
  ) {
    blockers.push("credential_check_stale");
  }
  return blockers;
}

export async function smartSiteLaunchReadiness(
  organizationId: string,
  now = new Date(),
) {
  const [members, sites] = await Promise.all([
    db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.organizationId, organizationId),
          eq(usersTable.isActive, true),
        ),
      ),
    db
      .select({
        id: smartSitesTable.id,
        isActive: smartSitesTable.isActive,
        credentialIssuedAt: smartSitesTable.credentialIssuedAt,
        credentialCheckedAt: smartSitesTable.credentialCheckedAt,
        credentialVersion: smartSitesTable.credentialVersion,
      })
      .from(smartSitesTable)
      .where(eq(smartSitesTable.organizationId, organizationId))
      .orderBy(desc(smartSitesTable.createdAt)),
  ]);
  const staffing = {
    activeManagers: members.filter((member) =>
      hasPermission(member.role, "settings.manage"),
    ).length,
    activeResponders: members.filter((member) =>
      hasPermission(member.role, "crm.write"),
    ).length,
  };
  return {
    contract: "smart-site-launch-guard-v1" as const,
    serverNow: now.toISOString(),
    credentialCheckMaxAgeHours:
      SMART_SITE_CREDENTIAL_CHECK_MAX_AGE_MS / 3_600_000,
    confirmationRequired: true,
    staffing,
    sites: sites.map((site) => {
      const blockers = evaluateLaunchBlockers(site, staffing, now);
      return { ...site, ready: blockers.length === 0, blockers };
    }),
  };
}

export async function updateSmartSiteMeasurement(
  organizationId: string,
  actorUserId: string,
  id: string,
  input: { enabled: boolean; retentionDays: number },
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(smartSitesTable)
      .set({
        analyticsEnabled: input.enabled,
        analyticsRetentionDays: input.retentionDays,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(smartSitesTable.organizationId, organizationId),
          eq(smartSitesTable.id, id),
        ),
      )
      .returning(publicFields);
    if (!row) throw new SmartSiteError("site_not_found", 404);
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId,
      action: "smart_site.measurement_updated",
      entityType: "smart_site",
      entityId: id,
      metadata: {
        enabled: input.enabled,
        retentionDays: input.retentionDays,
        policyVersion: row.analyticsPolicyVersion,
      },
    });
    return row;
  });
}

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
        credentialIssuedAt: new Date(),
      })
      .returning(publicFields);
    await tx.insert(auditEventsTable).values({
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
  confirmedLaunch = false,
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(smartSitesTable)
      .where(
        and(
          eq(smartSitesTable.organizationId, organizationId),
          eq(smartSitesTable.id, id),
        ),
      )
      .for("update");
    if (!current) throw new SmartSiteError("site_not_found", 404);
    let launchEvidence: Record<string, unknown> | undefined;
    if (active) {
      if (!confirmedLaunch)
        throw new SmartSiteError("launch_confirmation_required", 409);
      const members = await tx
        .select({ role: usersTable.role })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.organizationId, organizationId),
            eq(usersTable.isActive, true),
          ),
        )
        .for("share");
      const staffing = {
        activeManagers: members.filter((member) =>
          hasPermission(member.role, "settings.manage"),
        ).length,
        activeResponders: members.filter((member) =>
          hasPermission(member.role, "crm.write"),
        ).length,
      };
      const blockers = evaluateLaunchBlockers(current, staffing, new Date());
      if (blockers.length)
        throw new SmartSiteError("smart_site_launch_blocked", 409, {
          blockers,
        });
      launchEvidence = {
        contract: "smart-site-launch-guard-v1",
        confirmedLaunch: true,
        operatorAttestation:
          "staff-owner-contact-policy-and-https-acceptance-v1",
        activeManagers: staffing.activeManagers,
        activeResponders: staffing.activeResponders,
        credentialVersion: current.credentialVersion,
        credentialCheckedAt: current.credentialCheckedAt?.toISOString(),
        credentialCheckMaxAgeHours:
          SMART_SITE_CREDENTIAL_CHECK_MAX_AGE_MS / 3_600_000,
      };
    }
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
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId,
      action: active ? "smart_site.enabled" : "smart_site.disabled",
      entityType: "smart_site",
      entityId: id,
      ...(launchEvidence ? { metadata: launchEvidence } : {}),
    });
    return row;
  });
}

export async function rotateSmartSiteKey(
  organizationId: string,
  actorUserId: string,
  id: string,
  expectedVersion?: number,
) {
  const secret = `ss_${randomBytes(32).toString("hex")}`;
  return db.transaction(async (tx) => {
    const [site] = await tx
      .update(smartSitesTable)
      .set({
        keyHash: hash(secret),
        isActive: false,
        updatedAt: new Date(),
        credentialIssuedAt: new Date(),
        credentialCheckedAt: null,
        credentialVersion: sql`${smartSitesTable.credentialVersion} + 1`,
      })
      .where(
        and(
          eq(smartSitesTable.organizationId, organizationId),
          eq(smartSitesTable.id, id),
          ...(expectedVersion === undefined
            ? []
            : [eq(smartSitesTable.credentialVersion, expectedVersion)]),
        ),
      )
      .returning(publicFields);
    if (!site)
      throw new SmartSiteError(
        expectedVersion === undefined
          ? "site_not_found"
          : "site_missing_or_credential_changed",
        expectedVersion === undefined ? 404 : 409,
      );
    await tx.insert(auditEventsTable).values({
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

export async function authenticateSmartSite(
  id: string,
  secret: string,
  options: { requireActive?: boolean } = {},
) {
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
  if (options.requireActive !== false && !site.isActive)
    throw new SmartSiteError("site_capture_disabled", 503);
  return site;
}

/** All authoritative writes commit together. No email, LLM or background scheduler is required. */
export async function captureSmartSiteInquiry(
  site: typeof smartSitesTable.$inferSelect,
  input: SmartSiteIntake,
  siteReceivedAt?: Date,
) {
  if (await customerWorkHeld(site.organizationId))
    throw new SmartSiteError("customer_lifecycle_paused", 423);
  const profile = SMART_SITE_PROFILES.find((p) => p.id === site.profile);
  const service = profile?.services.find(
    (s) => s[0] === input.project.serviceCode,
  );
  if (!service) throw new SmartSiteError("service_not_allowed");
  const payloadHash = hash(JSON.stringify(input));
  const organizationId = site.organizationId;
  return db.transaction(async (tx) => {
    // Lifecycle transitions take the matching exclusive lock. Take this first,
    // then re-read through this transaction so a waiting intake cannot bypass a pause.
    await tx.execute(sql`select set_config('lock_timeout', '3000ms', true)`);
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${`customer-lifecycle:${organizationId}`}, 0))`,
    );
    if (!(await getCustomerLifecycleStatus(organizationId, tx)).automationAllowed)
      throw new SmartSiteError("customer_lifecycle_paused", 423);
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
    const measurement = input.measurement;
    if (measurement && !currentSite.analyticsEnabled)
      throw new SmartSiteError("site_measurement_disabled", 503);
    if (
      measurement &&
      measurement.policyVersion !== currentSite.analyticsPolicyVersion
    )
      throw new SmartSiteError("analytics_policy_version_mismatch", 409);
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
    const activeMembers = await tx
      .select({ id: usersTable.id, role: usersTable.role })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.organizationId, organizationId),
          eq(usersTable.isActive, true),
        ),
      )
      .for("share");
    const activeResponder = activeMembers.find((member) =>
      hasPermission(member.role, "crm.write"),
    );
    if (!activeResponder)
      throw new SmartSiteError("site_staffing_unavailable", 503);
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
          anonymousId: measurement?.visitorId,
        }),
      })
      .returning();
    await enqueueStaffLeadPush(tx, organizationId, lead);
    const consent = {
      ...input.consent,
      receivedAt: new Date().toISOString(),
      scope: "respond-to-this-inquiry",
    };
    const acceptedAt = siteReceivedAt ?? new Date();
    const responseDueAt = new Date(
      acceptedAt.getTime() + currentSite.responseTargetMinutes * 60_000,
    );
    const [saved] = await tx
      .insert(smartSiteSubmissionsTable)
      .values({
        organizationId,
        siteId: site.id,
        requestId: input.requestId,
        payloadHash,
        leadId: lead.id,
        consent,
        siteReceivedAt: acceptedAt,
        responseDueAt,
      })
      .returning();
    if (measurement) {
      await tx
        .update(analyticsEventsTable)
        .set({ leadId: lead.id })
        .where(
          and(
            eq(analyticsEventsTable.organizationId, organizationId),
            eq(analyticsEventsTable.smartSiteId, site.id),
            eq(analyticsEventsTable.anonymousId, measurement.visitorId),
          ),
        );
      await tx
        .insert(analyticsEventsTable)
        .values({
          organizationId,
          smartSiteId: site.id,
          eventId: input.requestId,
          schemaVersion: 1,
          leadId: lead.id,
          consentPolicyVersion: measurement.policyVersion,
          payloadHash: hash(
            JSON.stringify({
              eventName: "lead_saved",
              visitorId: measurement.visitorId,
              requestId: input.requestId,
            }),
          ),
          eventName: "lead_saved",
          anonymousId: measurement.visitorId,
          sessionId: measurement.sessionId ?? null,
          path: a?.landingPath ?? null,
          source: a?.source ?? null,
          medium: a?.medium ?? null,
          campaign: a?.campaign ?? null,
          referrer: a?.referrerHost ?? null,
          serviceCode: p.serviceCode,
          surface: [
            "roof-leak",
            "storm-damage",
            "water-damage",
            "not-sure",
          ].includes(p.serviceCode)
            ? "damage-check"
            : "project-inquiry",
          step: "saved",
          properties: { evidence: "growthos-receipt" },
        })
        .onConflictDoNothing();
    }
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
    await tx.insert(activitiesTable).values({
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
    await tx.insert(crmTasksTable).values({
      organizationId,
      leadId: lead.id,
      contactId: contact.id,
      title: `Review ${service[1].toLowerCase()} inquiry`,
      description:
        "Contact permission covers this inquiry only. Assign an owner and record the follow-up; no email, SMS, appointment or dispatch has been sent or confirmed.",
      sourceEvent: "smart_site.lead_saved",
      priority: urgency,
      dueAt: responseDueAt,
    });
    await tx.insert(auditEventsTable).values({
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

const EVENT_BACKLOG_DAYS = 7;

export function smartSiteMeasurementStatus(
  site: typeof smartSitesTable.$inferSelect,
) {
  return {
    ready: site.isActive && site.analyticsEnabled,
    policyVersion: site.analyticsPolicyVersion,
    retentionDays: site.analyticsRetentionDays,
    contract: "consent-first-first-party-v1",
  };
}

/** Store only allowlisted, pseudonymous events after explicit analytics consent. */
export async function captureSmartSiteAcquisitionEvents(
  site: typeof smartSitesTable.$inferSelect,
  input: SmartSiteAcquisitionBatch,
) {
  if (await customerWorkHeld(site.organizationId)) throw new SmartSiteError("customer_lifecycle_paused", 423);
  if (!site.analyticsEnabled)
    throw new SmartSiteError("site_measurement_disabled", 503);
  if (input.policyVersion !== site.analyticsPolicyVersion)
    throw new SmartSiteError("analytics_policy_version_mismatch", 409);
  const profile = SMART_SITE_PROFILES.find((p) => p.id === site.profile);
  const allowedServices = new Set(profile?.services.map((s) => s[0]) ?? []);
  const now = Date.now();
  const oldestAllowed = now - EVENT_BACKLOG_DAYS * 86_400_000;
  for (const event of input.events) {
    const occurredAt = Date.parse(event.occurredAt);
    if (occurredAt < oldestAllowed || occurredAt > now + 300_000)
      throw new SmartSiteError("event_time_out_of_range");
    if (event.serviceCode && !allowedServices.has(event.serviceCode as never))
      throw new SmartSiteError("service_not_allowed");
  }
  const retentionCutoff = new Date(
    now - site.analyticsRetentionDays * 86_400_000,
  );
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', '3000ms', true)`);
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${`customer-lifecycle:${site.organizationId}`}, 0))`,
    );
    if (!(await getCustomerLifecycleStatus(site.organizationId, tx)).automationAllowed)
      throw new SmartSiteError("customer_lifecycle_paused", 423);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`smart-site-events:${site.id}`}, 0))`,
    );
    const [currentSite] = await tx
      .select()
      .from(smartSitesTable)
      .where(eq(smartSitesTable.id, site.id))
      .for("share");
    if (!currentSite?.isActive || currentSite.keyHash !== site.keyHash)
      throw new SmartSiteError("site_capture_disabled", 503);
    if (!currentSite.analyticsEnabled)
      throw new SmartSiteError("site_measurement_disabled", 503);
    if (input.policyVersion !== currentSite.analyticsPolicyVersion)
      throw new SmartSiteError("analytics_policy_version_mismatch", 409);

    await tx
      .delete(analyticsEventsTable)
      .where(
        and(
          eq(analyticsEventsTable.smartSiteId, site.id),
          lt(analyticsEventsTable.occurredAt, retentionCutoff),
        ),
      );
    const ids = input.events.map((event) => event.eventId);
    const existing = await tx
      .select({
        eventId: analyticsEventsTable.eventId,
        payloadHash: analyticsEventsTable.payloadHash,
      })
      .from(analyticsEventsTable)
      .where(
        and(
          eq(analyticsEventsTable.smartSiteId, site.id),
          inArray(analyticsEventsTable.eventId, ids),
        ),
      );
    const existingById = new Map(
      existing.map((event) => [event.eventId, event.payloadHash]),
    );
    const eventHashes = new Map(
      input.events.map((event) => [
        event.eventId,
        hash(
          JSON.stringify({
            schemaVersion: input.schemaVersion,
            policyVersion: input.policyVersion,
            visitorId: input.visitorId,
            sessionId: input.sessionId,
            event,
          }),
        ),
      ]),
    );
    for (const event of input.events) {
      const prior = existingById.get(event.eventId);
      if (prior && prior !== eventHashes.get(event.eventId))
        throw new SmartSiteError("idempotency_conflict", 409);
    }
    const [linked] = await tx
      .select({ leadId: leadsTable.id })
      .from(smartSiteSubmissionsTable)
      .innerJoin(
        leadsTable,
        and(
          eq(leadsTable.id, smartSiteSubmissionsTable.leadId),
          eq(leadsTable.organizationId, site.organizationId),
          eq(leadsTable.anonymousId, input.visitorId),
        ),
      )
      .where(
        and(
          eq(smartSiteSubmissionsTable.organizationId, site.organizationId),
          eq(smartSiteSubmissionsTable.siteId, site.id),
        ),
      )
      .orderBy(desc(smartSiteSubmissionsTable.createdAt))
      .limit(1);
    const fresh = input.events.filter(
      (event) => !existingById.has(event.eventId),
    );
    if (fresh.length) {
      await tx.insert(analyticsEventsTable).values(
        fresh.map((event) => ({
          organizationId: site.organizationId,
          smartSiteId: site.id,
          eventId: event.eventId,
          schemaVersion: input.schemaVersion,
          leadId: linked?.leadId ?? null,
          consentPolicyVersion: input.policyVersion,
          payloadHash: eventHashes.get(event.eventId)!,
          eventName: event.eventName,
          anonymousId: input.visitorId,
          sessionId: input.sessionId,
          path: event.path,
          referrer: event.referrerHost ?? null,
          source: event.source ?? null,
          medium: event.medium ?? null,
          campaign: event.campaign ?? null,
          serviceCode: event.serviceCode ?? null,
          surface: event.surface ?? null,
          step: event.step ?? null,
          properties: { contract: "smart-sites-acquisition-v1" },
          occurredAt: new Date(event.occurredAt),
        })),
      );
    }
    return {
      accepted: fresh.length,
      duplicates: existing.length,
      contract: "consent-first-first-party-v1",
    };
  });
}

/** Remove this site's pseudonymous behavior history without deleting operational lead records. */
export async function optOutSmartSiteVisitor(
  site: typeof smartSitesTable.$inferSelect,
  visitorId: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`smart-site-opt-out:${site.id}:${visitorId}`}, 0))`,
    );
    const linkedLeads = await tx
      .select({ id: leadsTable.id })
      .from(smartSiteSubmissionsTable)
      .innerJoin(
        leadsTable,
        and(
          eq(leadsTable.id, smartSiteSubmissionsTable.leadId),
          eq(leadsTable.organizationId, site.organizationId),
          eq(leadsTable.anonymousId, visitorId),
        ),
      )
      .where(
        and(
          eq(smartSiteSubmissionsTable.organizationId, site.organizationId),
          eq(smartSiteSubmissionsTable.siteId, site.id),
        ),
      );
    const removed = await tx
      .delete(analyticsEventsTable)
      .where(
        and(
          eq(analyticsEventsTable.organizationId, site.organizationId),
          eq(analyticsEventsTable.smartSiteId, site.id),
          eq(analyticsEventsTable.anonymousId, visitorId),
        ),
      )
      .returning({ id: analyticsEventsTable.id });
    if (linkedLeads.length) {
      await tx
        .update(leadsTable)
        .set({ anonymousId: null, updatedAt: new Date() })
        .where(
          and(
            eq(leadsTable.organizationId, site.organizationId),
            inArray(
              leadsTable.id,
              linkedLeads.map((lead) => lead.id),
            ),
          ),
        );
    }
    await tx.insert(auditEventsTable).values({
      organizationId: site.organizationId,
      action: "smart_site.analytics_opt_out",
      entityType: "smart_site",
      entityId: site.id,
      metadata: {
        removedEvents: removed.length,
        unlinkedLeads: linkedLeads.length,
        visitorIdentifierRetained: false,
      },
    });
    return {
      removedEvents: removed.length,
      unlinkedLeads: linkedLeads.length,
      operationalLeadRecordsPreserved: true,
    };
  });
}

const numberValue = (value: unknown) => Number(value ?? 0);

export async function smartSiteAcquisitionOverview(
  organizationId: string,
  days: number,
) {
  const summaryResult = await db.execute(sql`
    with scoped as (
      select e.*
      from analytics_events e
      join smart_sites s on s.id = e.smart_site_id
      where e.organization_id = ${organizationId}::uuid
        and s.organization_id = ${organizationId}::uuid
        and e.occurred_at >= now() - make_interval(days => least(${days}::int, s.analytics_retention_days))
    ), linked as (
      select distinct lead_id from scoped where lead_id is not null
    )
    select
      (select count(distinct anonymous_id)::int from scoped) as visitors,
      (select count(distinct session_id)::int from scoped) as sessions,
      (select count(distinct anonymous_id)::int from scoped where event_name in ('project_form_started','damage_check_started','voice_session_started','quiet_text_session_started')) as started_visitors,
      (select count(*)::int from scoped where event_name = 'phone_link_clicked') as phone_clicks,
      (select count(distinct anonymous_id)::int from scoped where event_name in ('voice_session_started','quiet_text_session_started')) as voice_visitors,
      (select count(*)::int from linked) as saved_leads,
      (select count(*)::int from linked x join leads l on l.id = x.lead_id where l.status in ('ai_qualified','contact_attempted','inspection_scheduled','inspection_completed','estimate_preparing','estimate_sent','claim_pending','follow_up','won','production_scheduled','in_progress','final_walkthrough','completed','review_requested')) as qualified_leads,
      (select count(*)::int from linked x where exists (select 1 from appointments a where a.organization_id = ${organizationId}::uuid and a.lead_id = x.lead_id and a.status <> 'cancelled')) as appointment_leads,
      (select count(*)::int from linked x where exists (select 1 from estimates est where est.organization_id = ${organizationId}::uuid and est.lead_id = x.lead_id and est.status in ('sent','accepted'))) as estimate_leads,
      (select count(*)::int from linked x join leads l on l.id = x.lead_id where l.won_at is not null) as won_leads,
      (select coalesce(sum(l.won_revenue_cents),0)::float8 from linked x join leads l on l.id = x.lead_id where l.won_at is not null) as won_value_cents,
      (select percentile_cont(0.5) within group (order by extract(epoch from (ss.first_attempt_at - ss.site_received_at)) / 60.0)
        from linked x join smart_site_submissions ss on ss.lead_id = x.lead_id
        where ss.organization_id = ${organizationId}::uuid and ss.first_attempt_at is not null and ss.site_received_at is not null) as median_minutes_to_staff_log
  `);
  const summary = summaryResult.rows[0] as Record<string, unknown>;
  const eventResult = await db.execute(sql`
    select e.event_name, count(*)::int as events, count(distinct e.anonymous_id)::int as visitors
    from analytics_events e
    join smart_sites s on s.id = e.smart_site_id
    where e.organization_id = ${organizationId}::uuid
      and s.organization_id = ${organizationId}::uuid
      and e.occurred_at >= now() - make_interval(days => least(${days}::int, s.analytics_retention_days))
    group by e.event_name order by events desc, e.event_name asc
  `);
  const sourceResult = await db.execute(sql`
    with scoped as (
      select e.*
      from analytics_events e
      join smart_sites s on s.id = e.smart_site_id
      where e.organization_id = ${organizationId}::uuid
        and s.organization_id = ${organizationId}::uuid
        and e.occurred_at >= now() - make_interval(days => least(${days}::int, s.analytics_retention_days))
        and e.anonymous_id is not null
    ), visitor_source as (
      select distinct e.smart_site_id, e.anonymous_id, e.source
      from scoped e where nullif(e.source, '') is not null
      union all
      select distinct e.smart_site_id, e.anonymous_id, 'Direct / unknown'
      from scoped e
      where not exists (
        select 1 from scoped x
        where x.smart_site_id = e.smart_site_id
          and x.anonymous_id = e.anonymous_id
          and nullif(x.source, '') is not null
      )
    ), lead_source as (
      select distinct smart_site_id, anonymous_id, lead_id,
        coalesce(nullif(source, ''), 'Direct / unknown') as source
      from scoped where event_name = 'lead_saved' and lead_id is not null
    )
    select vs.source,
      count(distinct (vs.smart_site_id, vs.anonymous_id))::int as visitors,
      count(distinct ls.lead_id)::int as saved_leads,
      count(distinct ls.lead_id) filter (where l.won_at is not null)::int as won_leads
    from visitor_source vs
    left join lead_source ls on ls.smart_site_id = vs.smart_site_id
      and ls.anonymous_id = vs.anonymous_id and ls.source = vs.source
    left join leads l on l.id = ls.lead_id and l.organization_id = ${organizationId}::uuid
    group by vs.source
    order by saved_leads desc, visitors desc, source asc limit 12
  `);
  const serviceResult = await db.execute(sql`
    with scoped as (
      select e.*
      from analytics_events e
      join smart_sites s on s.id = e.smart_site_id
      where e.organization_id = ${organizationId}::uuid
        and s.organization_id = ${organizationId}::uuid
        and e.occurred_at >= now() - make_interval(days => least(${days}::int, s.analytics_retention_days))
        and e.anonymous_id is not null
    ), visitor_service as (
      select distinct e.smart_site_id, e.anonymous_id, e.service_code
      from scoped e where nullif(e.service_code, '') is not null
      union all
      select distinct e.smart_site_id, e.anonymous_id, 'Not specified'
      from scoped e
      where not exists (
        select 1 from scoped x
        where x.smart_site_id = e.smart_site_id
          and x.anonymous_id = e.anonymous_id
          and nullif(x.service_code, '') is not null
      )
    ), lead_service as (
      select distinct smart_site_id, anonymous_id, lead_id,
        coalesce(nullif(service_code, ''), 'Not specified') as service_code
      from scoped where event_name = 'lead_saved' and lead_id is not null
    )
    select vs.service_code,
      count(distinct (vs.smart_site_id, vs.anonymous_id))::int as visitors,
      count(distinct ls.lead_id)::int as saved_leads,
      count(distinct ls.lead_id) filter (where l.won_at is not null)::int as won_leads
    from visitor_service vs
    left join lead_service ls on ls.smart_site_id = vs.smart_site_id
      and ls.anonymous_id = vs.anonymous_id and ls.service_code = vs.service_code
    left join leads l on l.id = ls.lead_id and l.organization_id = ${organizationId}::uuid
    group by vs.service_code
    order by saved_leads desc, visitors desc, service_code asc limit 12
  `);
  const contentResult = await db.execute(sql`
    with scoped as (
      select e.*
      from analytics_events e
      join smart_sites s on s.id = e.smart_site_id
      where e.organization_id = ${organizationId}::uuid
        and s.organization_id = ${organizationId}::uuid
        and e.occurred_at >= now() - make_interval(days => least(${days}::int, s.analytics_retention_days))
        and e.anonymous_id is not null
    ), ranked_landing as (
      select e.smart_site_id, e.anonymous_id, coalesce(nullif(e.path, ''), '/') as path,
        row_number() over (
          partition by e.smart_site_id, e.anonymous_id
          order by e.occurred_at asc, e.id asc
        ) as position
      from scoped e
    ), landing as (
      select smart_site_id, anonymous_id, path
      from ranked_landing where position = 1
    ), linked_leads as (
      select distinct e.smart_site_id, e.anonymous_id, e.lead_id
      from scoped e
      where e.event_name = 'lead_saved' and e.lead_id is not null
    )
    select landing.path,
      count(distinct (landing.smart_site_id, landing.anonymous_id))::int as visitors,
      count(distinct linked_leads.lead_id)::int as saved_leads,
      count(distinct linked_leads.lead_id) filter (where l.won_at is not null)::int as won_leads
    from landing
    left join linked_leads on linked_leads.smart_site_id = landing.smart_site_id
      and linked_leads.anonymous_id = landing.anonymous_id
    left join leads l on l.id = linked_leads.lead_id and l.organization_id = ${organizationId}::uuid
    group by landing.path
    order by saved_leads desc, visitors desc, landing.path asc limit 20
  `);
  const sites = await db
    .select(publicFields)
    .from(smartSitesTable)
    .where(eq(smartSitesTable.organizationId, organizationId))
    .orderBy(desc(smartSitesTable.createdAt));
  return {
    scope: `Last ${days} days, capped by each site's retention policy`,
    days,
    summary: {
      visitors: numberValue(summary.visitors),
      sessions: numberValue(summary.sessions),
      startedVisitors: numberValue(summary.started_visitors),
      phoneClicks: numberValue(summary.phone_clicks),
      voiceVisitors: numberValue(summary.voice_visitors),
      savedLeads: numberValue(summary.saved_leads),
      qualifiedLeads: numberValue(summary.qualified_leads),
      appointmentLeads: numberValue(summary.appointment_leads),
      estimateLeads: numberValue(summary.estimate_leads),
      wonLeads: numberValue(summary.won_leads),
      wonValueCents: numberValue(summary.won_value_cents),
      medianMinutesToStaffLog:
        summary.median_minutes_to_staff_log === null
          ? null
          : numberValue(summary.median_minutes_to_staff_log),
    },
    events: eventResult.rows.map((row) => ({
      eventName: String(row.event_name),
      events: numberValue(row.events),
      visitors: numberValue(row.visitors),
    })),
    sources: sourceResult.rows.map((row) => ({
      source: String(row.source),
      visitors: numberValue(row.visitors),
      savedLeads: numberValue(row.saved_leads),
      wonLeads: numberValue(row.won_leads),
    })),
    services: serviceResult.rows.map((row) => ({
      serviceCode: String(row.service_code),
      visitors: numberValue(row.visitors),
      savedLeads: numberValue(row.saved_leads),
      wonLeads: numberValue(row.won_leads),
    })),
    content: contentResult.rows.map((row) => ({
      path: String(row.path),
      visitors: numberValue(row.visitors),
      savedLeads: numberValue(row.saved_leads),
      wonLeads: numberValue(row.won_leads),
    })),
    sites,
    measurement: {
      visitors:
        "Distinct consented first-party browser identifiers, not people across devices",
      savedLeads: "GrowthOS receipt-linked inquiries, not submit-button clicks",
      phoneClicks: "Telephone-link clicks; not completed or answered calls",
      medianResponse:
        "Median time to an explicit staff-recorded attempt; not provider delivery or reply",
      wonValue:
        "Recorded won contract value; not collected cash, margin, ROI or profit",
      content:
        "First recorded path within the report window for each consented browser; returning and cross-device journeys remain incomplete",
      excluded:
        "No raw URLs, contact details, files, transcripts, full user agents or cross-site advertising IDs",
    },
  };
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
