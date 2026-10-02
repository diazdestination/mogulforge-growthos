import {
  auditEventsTable,
  db,
  organizationsTable,
  usersTable,
  type EntitlementCapability,
  type EntitlementPlanId,
  type Organization,
  type OrganizationEntitlements,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { hasPermission, type Permission } from "../lib/permissions";

export const PLAN_CATALOG_VERSION = 1;
export const PLAN_CATALOG = {
  beta: { capabilities: [] },
  growth: { capabilities: ["revenue.autopilot"] },
  scale: { capabilities: ["revenue.autopilot"] },
} as const satisfies Record<EntitlementPlanId, { capabilities: readonly EntitlementCapability[] }>;

const policySchema = z.object({
  version: z.literal(1),
  planId: z.enum(["beta", "growth", "scale"]),
  source: z.enum(["manual", "stripe"]),
  grants: z.array(z.literal("revenue.autopilot")).max(1),
}).strict();

export const entitlementAssignmentSchema = policySchema.omit({ version: true }).extend({
  reason: z.string().trim().min(10).max(500),
}).strict();

export interface CapabilityDecision {
  allowed: boolean;
  reason: string;
  detail: string;
}
export interface EntitlementStatus {
  catalogVersion: 1;
  mode: "legacy" | "managed";
  planId: EntitlementPlanId | null;
  source: "manual" | "stripe" | null;
  capabilities: Record<EntitlementCapability, CapabilityDecision>;
}

/** Server configuration only. An unknown or malformed mapping cannot sell or unlock a tier. */
export function mappedPlanForPrice(priceId: string | null): EntitlementPlanId | null {
  if (!priceId) return null;
  const raw = process.env.STRIPE_PLAN_PRICE_MAP;
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const result = z.record(z.string().regex(/^price_[A-Za-z0-9_]+$/), z.enum(["beta", "growth", "scale"])).safeParse(parsed);
  return result.success ? result.data[priceId] ?? null : null;
}

export function resolveEntitlements(org: Pick<Organization, "entitlements" | "planTier" | "subscriptionStatus">): EntitlementStatus {
  const legacy = org.entitlements == null;
  const parsed = policySchema.safeParse(org.entitlements);
  const policy = parsed.success ? parsed.data : null;
  let decision: CapabilityDecision;
  if (legacy) {
    decision = { allowed: true, reason: "legacy_access", detail: "Existing access is preserved until an operator agrees and assigns this company's scope." };
  } else if (!policy) {
    decision = { allowed: false, reason: "invalid_policy", detail: "An operator must repair this company's capability configuration." };
  } else if (policy.source === "stripe" && mappedPlanForPrice(org.planTier) !== policy.planId) {
    decision = { allowed: false, reason: "unmapped_price", detail: "Billing does not have a verified price mapping for this company's assigned plan." };
  } else if (policy.source === "stripe" && !["active", "trialing"].includes(org.subscriptionStatus ?? "")) {
    decision = { allowed: false, reason: "billing_inactive", detail: "Automated execution is paused while the subscription is inactive. Approved work and history are retained." };
  } else if (policy.grants.includes("revenue.autopilot")) {
    decision = { allowed: true, reason: "tenant_grant", detail: "Automated execution is included in this company's recorded grant." };
  } else if ((PLAN_CATALOG[policy.planId].capabilities as readonly string[]).includes("revenue.autopilot")) {
    decision = { allowed: true, reason: "plan_included", detail: "Automated execution is included in this company's assigned plan." };
  } else {
    decision = { allowed: false, reason: "not_in_plan", detail: "Automated execution is outside this company's current scope. Contact your GrowthOS operator to review the included workflow." };
  }
  return {
    catalogVersion: PLAN_CATALOG_VERSION,
    mode: legacy ? "legacy" : "managed",
    planId: policy?.planId ?? null,
    source: policy?.source ?? null,
    capabilities: { "revenue.autopilot": decision },
  };
}

export class CapabilityAccessError extends Error {
  readonly status = 403;
  readonly code = "capability_unavailable";
  constructor(readonly capability: EntitlementCapability, readonly reason: string, detail: string) {
    super(detail);
    this.name = "CapabilityAccessError";
  }
}

export async function getEntitlements(organizationId: string): Promise<EntitlementStatus> {
  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
  if (!org) throw new CapabilityAccessError("revenue.autopilot", "organization_missing", "Organization not found.");
  return resolveEntitlements(org);
}

export async function assertCapability(organizationId: string, capability: EntitlementCapability): Promise<void> {
  const decision = (await getEntitlements(organizationId)).capabilities[capability];
  if (!decision.allowed) throw new CapabilityAccessError(capability, decision.reason, decision.detail);
}

export async function assertCapabilityForActor(organizationId: string, actorUserId: string, capability: EntitlementCapability, permission: Permission): Promise<void> {
  const [actor] = await db.select().from(usersTable).where(and(eq(usersTable.id, actorUserId), eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true)));
  if (!actor || !hasPermission(actor.role, permission)) {
    throw new CapabilityAccessError(capability, "permission_required", "An active, authorized member of this company is required.");
  }
  await assertCapability(organizationId, capability);
}

/** Explicit operator enrollment. No customer-facing upgrade/grant mutation exists. */
export async function assignEntitlements(organizationId: string, operatorUserId: string, input: unknown): Promise<EntitlementStatus> {
  const assignment = entitlementAssignmentSchema.parse(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', '3000ms', true), set_config('statement_timeout', '15000ms', true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${organizationId}`}, 0))`);
    const [operator] = await tx.select().from(usersTable).where(and(eq(usersTable.id, operatorUserId), eq(usersTable.isActive, true), eq(usersTable.isPlatformAdmin, true)));
    if (!operator) throw new CapabilityAccessError("revenue.autopilot", "operator_required", "An active platform operator is required to change company scope.");
    const [org] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
    if (!org) throw new CapabilityAccessError("revenue.autopilot", "organization_missing", "Organization not found.");
    if (assignment.source === "stripe" && (!org.stripeCustomerId || !org.stripeSubscriptionId || mappedPlanForPrice(org.planTier) !== assignment.planId)) {
      throw new CapabilityAccessError("revenue.autopilot", "unmapped_price", "Reconcile this company's Stripe subscription and known price before assigning Stripe-managed scope.");
    }
    const entitlements: OrganizationEntitlements = { version: 1, planId: assignment.planId, source: assignment.source, grants: assignment.grants };
    const [updated] = await tx.update(organizationsTable).set({ entitlements }).where(eq(organizationsTable.id, organizationId)).returning();
    await tx.insert(auditEventsTable).values({ organizationId, actorUserId: operatorUserId, action: "billing.entitlements_assigned", entityType: "organization", entityId: organizationId, metadata: { previous: org.entitlements, next: entitlements, reason: assignment.reason } });
    return resolveEntitlements(updated);
  });
}
