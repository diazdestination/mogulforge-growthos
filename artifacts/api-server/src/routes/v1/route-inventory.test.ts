import { describe, expect, it } from "vitest";

import type { Permission } from "../../lib/permissions";
import v1Router from "./index";
import { requirePlatformAdmin } from "./orgs";

/**
 * Route-inventory test: walks the actual mounted Express router and asserts
 * every non-public route is protected by `requireMember` with exactly the
 * permission the contract below expects. Fails when a route is added without
 * a guard, added without updating the contract, or mounted with the wrong
 * permission (e.g. a DELETE wired with crm.write).
 */

interface RouteEntry {
  method: string;
  path: string;
  /** Permissions of every requireMember guard on the route (usually one). */
  permissions: Permission[];
  /** Number of handlers on the route (guards + terminal handler). */
  handlerCount: number;
  platformGuard: boolean;
}

// Routes that are intentionally reachable without authentication.
// Adding a route here is an explicit, reviewable decision.
// - /public: unauthenticated marketing/lead-capture endpoints.
// - /portal: homeowner portal; authenticates with its own OTP magic-link
//   session token (x-portal-token) plus rate limiting, not requireMember.
const PUBLIC_ROUTE_PREFIXES = ["/public", "/portal"];

// Routes that authenticate a SESSION USER but intentionally do not require an
// organization membership, so they cannot use requireMember:
// - GET /session and POST /orgs must work for signed-in users who don't
//   belong to an org yet (self-serve org creation flow).
// - /platform/* is gated by the platform super-admin flag (requireSessionUser
//   + isPlatformAdmin), which is deliberately org-independent.
// Adding a route here is an explicit, reviewable decision.
const SESSION_ONLY_ROUTES = new Set([
  "GET /session",
  "POST /orgs",
  "GET /platform/orgs",
  "PATCH /platform/orgs/:id",
  "POST /platform/orgs/:id/entitlements",
  "POST /platform/orgs/:id/billing/replacement",
  "POST /platform/orgs/:id/billing/reconcile",
  "GET /platform/clients/profiles",
  "GET /platform/clients/health",
  "GET /platform/runtime",
  "GET /platform/email-deliveries",
  "POST /platform/clients",
  "GET /platform/clients/:orgId/readiness",
  "GET /platform/clients/:orgId/invitations",
  "POST /platform/clients/:orgId/invitations",
  "POST /platform/clients/:orgId/invitations/:invitationId/reissue",
  "POST /platform/clients/:orgId/invitations/:invitationId/revoke",
  "POST /platform/clients/:orgId/sites/:siteId/key",
]);

/**
 * The authorization contract: every protected `METHOD path` in the v1 API and
 * the permission its requireMember guard must carry.
 *
 * When you add, move, or remove a route, this test fails until you record the
 * route's expected permission here — that is the point. Choose deliberately:
 * - crm.read      — read CRM data (all active roles)
 * - crm.write     — create/update CRM records
 * - crm.delete    — destroy CRM records (owner/admin/sales_manager only)
 * - audit.read    — audit log (owner/admin)
 * - users.read    — list teammates
 * - users.manage  — invite/deactivate teammates (owner/admin)
 * - settings.manage — org configuration surfaces (owner/admin)
 */
const EXPECTED_PERMISSIONS: Record<string, Permission> = {
  "GET /contacts/:id/detail-correction": "crm.read",
  "GET /contacts/:id/memories": "crm.read",
  "POST /contacts/:id/memories": "crm.write",
  "POST /contacts/:id/memories/:memoryId/retire": "crm.write",
  "GET /contacts/:id/context-search": "crm.read",
  "POST /retrieval/reindex": "settings.manage",
  "POST /contacts/:id/detail-corrections": "crm.write",
  "GET /contacts/:id/detail-corrections/:requestId": "crm.read",
  "POST /customer-work/estimates": "crm.write",
  "PATCH /customer-work/estimates/:id": "crm.write",
  "POST /customer-work/projects": "crm.write",
  "PATCH /customer-work/projects/:id": "crm.write",
  "POST /invoices/:id/refunds": "invoices.manage",
  "GET /contacts/:id/assets": "crm.read",
  "POST /contacts/:id/assets": "crm.write",
  "PATCH /assets/:id": "crm.write",
  "GET /work-checklists": "crm.read",
  "GET /work-checklists/:id": "crm.read",
  "POST /work-checklists": "settings.manage",
  "POST /work-checklists/:id/revisions": "settings.manage",
  "POST /work-checklists/:id/preview": "settings.manage",
  "POST /work-checklists/:id/approve": "settings.manage",
  "POST /work-checklists/:id/retire": "settings.manage",
  "GET /appointments/:id/work": "crm.read",
  "POST /appointments/:id/work/entries": "crm.write",
  "PATCH /appointments/:id/work/entries/:entryId": "crm.write",
  "POST /appointments/:id/work/entries/:entryId/cancel": "crm.write",
  "POST /appointments/:id/work/completion-preview": "crm.write",
  "POST /appointments/:id/work/complete": "crm.write",
  "POST /appointments/:id/work/completions/:completionId/corrections": "crm.write",
  "POST /appointments/:id/work/entries/:entryId/photos/request-url": "crm.write",
  "POST /appointments/:id/work/entries/:entryId/photos": "crm.write",
  "GET /appointments/:id/work/photos/:photoId/content": "crm.read",
  "GET /source-nurture": "crm.read",
  "GET /source-nurture/:id": "crm.read",
  "POST /source-nurture/preview": "settings.manage",
  "POST /source-nurture/:id/approve": "settings.manage",
  "POST /source-nurture/:id/start": "settings.manage",
  "POST /source-nurture/:id/stop": "settings.manage",
  "GET /service-obligations/:id/standing-reminders": "crm.read",
  "POST /service-obligations/:id/standing-reminders/preview": "settings.manage",
  "POST /service-obligations/:id/standing-reminders/approve": "settings.manage",
  "POST /service-obligations/:id/standing-reminders/disable": "settings.manage",
  "GET /service-obligations/:id/sms-replies": "crm.read",
  "POST /service-obligations/:id/sms-replies/:replyId/review": "crm.write",
  "GET /communications/callie": "crm.read",
  "GET /communications/callie/reception": "crm.read",
  "POST /communications/callie/reception/binding": "settings.manage",
  "POST /communications/callie/reception/policy/preview": "settings.manage",
  "POST /communications/callie/reception/policy/approve": "settings.manage",
  "GET /communications/callie/policy": "crm.read",
  "POST /communications/callie/policy/preview": "settings.manage",
  "POST /communications/callie/policy/approve": "settings.manage",
  "GET /communications/callie/:id": "crm.read",
  "POST /communications/callie/:id/office-action": "crm.write",
  "POST /communications/callie/:id/review-caller": "crm.write",
  "POST /communications/callie/:id/book": "crm.write",
  "GET /staff-invitations/email-deliveries": "users.manage",
  "GET /service-obligations/:id/mailbox-replies": "crm.read",
  "POST /service-obligations/:id/mailbox-replies/:replyId/review": "crm.write",
  "GET /leads/:id/mailbox-replies": "crm.read",
  "POST /leads/:id/mailbox-replies/:replyId/review": "crm.write",
  "GET /mailbox/microsoft": "crm.write",
  "POST /mailbox/microsoft/connect": "crm.write",
  "GET /mailbox/microsoft/callback": "crm.write",
  "POST /mailbox/microsoft/disable": "crm.write",
  "POST /mailbox/microsoft/lead-monitoring": "crm.write",
  "POST /mailbox/microsoft/nurture-monitoring": "crm.write",
  "GET /contractor/today": "crm.read",
  "GET /tasks/:id": "crm.read",
  "GET /invoices": "invoices.read",
  "GET /invoices/delivery-worklist": "invoices.read",
  "GET /invoices/:id": "invoices.read",
  "GET /invoices/:id/delivery": "invoices.read",
  "POST /invoices/:id/delivery/preview": "invoices.manage",
  "POST /invoices/:id/delivery/send": "invoices.manage",
  "GET /service-obligations/:id/care": "crm.read",
  "POST /service-obligations/:id/care/reminder": "crm.write",
  "POST /service-obligations/:id/care/response": "crm.write",
  "POST /service-obligations/:id/care/book": "crm.write",
  "GET /service-watch": "crm.read",
  "GET /service-obligations/:id/watch": "crm.read",
  "PATCH /service-obligations/:id/watch": "crm.write",
  "GET /financial-migrations": "settings.manage",
  "POST /financial-migrations/preview": "settings.manage",
  "GET /financial-migrations/:id": "settings.manage",
  "POST /financial-migrations/:id/commit": "settings.manage",
  "GET /source-adoption": "crm.read",
  "GET /source-adoption/leads/:id": "crm.read",
  "GET /source-adoption/outreach/:id": "crm.read",
  "POST /source-adoption/leads/:id/preview": "settings.manage",
  "POST /source-adoption/leads/:id/approve": "settings.manage",
  "POST /source-adoption/leads/:id/revoke": "settings.manage",
  "POST /source-adoption/leads/:id/email-permission": "settings.manage",
  "POST /source-adoption/outreach/preview": "settings.manage",
  "POST /source-adoption/outreach/:id/approve": "settings.manage",
  "POST /source-adoption/outreach/:id/revoke": "settings.manage",
  "POST /source-adoption/outreach/:id/send": "settings.manage",
  "GET /communications/missed-call-care": "crm.read",
  "PUT /communications/missed-call-care/policy": "settings.manage",
  "GET /communications/voice/:id/care": "crm.read",
  "POST /communications/voice/:id/care/approve": "crm.write",
  "POST /communications/voice/:id/care/close": "crm.write",
  "POST /invoices": "invoices.manage",
  "PATCH /invoices/:id": "invoices.manage",
  "POST /invoices/:id/issue": "invoices.manage",
  "POST /invoices/:id/void": "invoices.manage",
  "POST /invoices/:id/payments": "invoices.manage",
  "POST /invoices/:id/allocations": "invoices.manage",
  "POST /invoices/:id/allocations/:allocationId/reverse": "invoices.manage",
  "GET /customer-lifecycle": "settings.manage",
  "POST /customer-lifecycle/transition": "settings.manage",
  "GET /customer-lifecycle/export": "settings.manage",
  "GET /staff-push/status": "crm.read",
  "POST /staff-push/subscriptions": "crm.read",
  "POST /staff-push/subscriptions/revoke": "crm.read",
  "GET /staff-push/policy": "settings.manage",
  "PUT /staff-push/policy": "settings.manage",
  "GET /staff-push/deliveries": "settings.manage",
  "GET /staff-push/leads/:leadId/coverage": "settings.manage",
  "GET /integrations/microsoft": "crm.read",
  "POST /integrations/microsoft/connect": "crm.write",
  "GET /integrations/microsoft/callback": "crm.write",
  "DELETE /integrations/microsoft": "crm.write",
  "GET /integrations/email-sender": "crm.read",
  "PUT /integrations/email-sender": "crm.write",
  "GET /leads/:id/manual-sms": "crm.write",
  "POST /leads/:id/manual-sms/draft-opened": "crm.write",
  "GET /revenue/desk": "crm.read",
  "POST /revenue/leads/:id/claim": "crm.write",
  "GET /revenue/profile": "crm.read",
  "POST /revenue/profile": "settings.manage",
  "GET /revenue/rooms/:id": "crm.read",
  "POST /revenue/rooms/:id": "settings.manage",
  "GET /revenue/value": "crm.read",
  "POST /revenue/value": "settings.manage",
  "GET /revenue/evidence/:id": "crm.read",
  "GET /revenue/growth": "crm.read",
  "POST /revenue/growth": "crm.write",
  "POST /revenue/growth/:id/approve": "settings.manage",
  "GET /revenue/executions/:id": "crm.read",
  "POST /revenue/executions/:id/reconcile": "settings.manage",
  "PATCH /revenue/proposals/:id": "crm.write",
  "GET /smart-sites/profiles": "crm.read",
  "GET /smart-sites": "crm.read",
  "GET /smart-sites/overview": "crm.read",
  "GET /smart-sites/acquisition": "crm.read",
  "GET /smart-sites/launch-readiness": "crm.read",
  "POST /smart-sites": "settings.manage",
  "PATCH /smart-sites/:id": "settings.manage",
  "PATCH /smart-sites/:id/measurement": "settings.manage",
  "POST /smart-sites/:id/rotate-key": "settings.manage",
  "GET /smart-sites/follow-up": "crm.read",
  "GET /smart-sites/leads/:id/follow-up": "crm.read",
  "PATCH /smart-sites/:id/response-target": "settings.manage",
  "PATCH /smart-sites/leads/:id/owner": "crm.write",
  "POST /smart-sites/leads/:id/contact-attempts": "crm.write",
  // me / users
  "GET /me": "crm.read",
  "PATCH /me": "crm.read",
  "GET /users": "users.read",
  "POST /users/invite": "users.manage",
  "POST /users/:id/resend-invite": "users.manage",
  "PATCH /users/:id": "users.manage",
  // contacts & properties
  "GET /contacts": "crm.read",
  "POST /contacts": "crm.write",
  "GET /contacts/:id": "crm.read",
  "GET /contacts/:id/workspace": "crm.read",
  "GET /contacts/:id/workspace/:section": "crm.read",
  "PATCH /contacts/:id": "crm.write",
  "DELETE /contacts/:id": "crm.delete",
  "GET /properties": "crm.read",
  "POST /properties": "crm.write",
  "GET /properties/:id": "crm.read",
  "PATCH /properties/:id": "crm.write",
  // leads
  "GET /leads": "crm.read",
  "POST /leads": "crm.write",
  "POST /leads/bulk": "crm.write",
  "GET /leads/duplicates": "crm.read",
  "GET /leads/:id": "crm.read",
  "PATCH /leads/:id": "crm.write",
  // Merging combines two records the rep can already edit; the losing lead
  // is archived (not destroyed), so plain write access is the right bar.
  "POST /leads/:id/merge": "crm.write",
  "GET /leads/:id/activities": "crm.read",
  "GET /leads/:id/behavior": "crm.read",
  "GET /leads/:id/conversations": "crm.read",
  "POST /leads/:id/activities": "crm.write",
  // Sends real outbound mail on behalf of the org, so it needs write access.
  "POST /leads/:id/send-email": "crm.write",
  // Rep photo upload — generates a presigned URL and attaches photos to timeline.
  "POST /leads/:id/photos/request-url": "crm.write",
  "POST /leads/:id/photos": "crm.write",
  "DELETE /leads/:id/photos": "crm.write",
  // Admin-only correction of wonRevenueCents after a win (change orders,
  // refunds, data-entry mistakes). Attribution category is never touched.
  "PATCH /leads/:id/won-revenue": "settings.manage",
  // assistant history is personal to the requesting user (scoped by user id);
  // reading and saving your own history only needs crm.read.
  "GET /assistant/history": "crm.read",
  "POST /assistant/history": "crm.read",
  // assistant chat only reads CRM data on the member's behalf; the route
  // itself performs no writes, so crm.read is the right bar.
  "POST /assistant/chat": "crm.read",
  // saved filters are personal to the requesting user (service layer scopes
  // them to user id), so managing your own only needs crm.read.
  "GET /saved-filters": "crm.read",
  "POST /saved-filters": "crm.read",
  "DELETE /saved-filters/:id": "crm.read",
  // estimates & projects
  "GET /estimates": "crm.read",
  "POST /estimates": "crm.write",
  "GET /estimates/:id": "crm.read",
  "PATCH /estimates/:id": "crm.write",
  "DELETE /estimates/:id": "crm.delete",
  "GET /projects": "crm.read",
  "POST /projects": "crm.write",
  "GET /projects/:id": "crm.read",
  "PATCH /projects/:id": "crm.write",
  "DELETE /projects/:id": "crm.delete",
  // tasks & appointments
  "GET /tasks": "crm.read",
  "POST /tasks": "crm.write",
  "PATCH /tasks/:id": "crm.write",
  "DELETE /tasks/:id": "crm.delete",
  "GET /appointments": "crm.read",
  "GET /appointments/:id": "crm.read",
  "POST /appointments": "crm.write",
  "PATCH /appointments/:id": "crm.write",
  // dashboard & audit
  "GET /dashboard/summary": "crm.read",
  "GET /dashboard/marketing": "crm.read",
  "GET /reports/roi": "crm.read",
  "GET /reports/roi/export": "crm.read",
  "GET /audit-events": "audit.read",
  // Billing changes the organization's subscription and payment-management
  // state; keep every surface admin-only.
  "GET /billing": "settings.manage",
  "GET /billing/entitlements": "crm.read",
  "POST /billing/checkout": "settings.manage",
  "POST /billing/portal": "settings.manage",
  // BIE Revenue Command Center. Read access can inspect tenant-owned
  // evidence; only writers may review/execute actions, and owners/admins
  // exclusively configure or trigger autopilot.
  "GET /bie/briefing": "crm.read",
  "POST /bie/briefing/run": "crm.read",
  "GET /bie/sources": "crm.read",
  "GET /bie/actions": "crm.read",
  "POST /bie/actions/generate": "crm.write",
  "POST /bie/actions/:id/prepare-email": "crm.write",
  "POST /bie/actions/:id/approve": "crm.write",
  "POST /bie/actions/:id/reject": "crm.write",
  "POST /bie/actions/:id/execute": "crm.write",
  "GET /bie/autopilot": "crm.read",
  "PUT /bie/autopilot": "settings.manage",
  "POST /bie/autopilot/run": "settings.manage",
  // Evidence Intelligence stores tenant-owned source artifacts and produces
  // AI drafts only. Every consequential transition remains a human write.
  "GET /bie/claims": "crm.read",
  "POST /bie/claims": "crm.write",
  "GET /bie/claims/:id": "crm.read",
  "POST /bie/claims/:id/artifacts": "crm.write",
  "GET /bie/claims/:id/artifacts/:artifactId/content": "crm.read",
  "POST /bie/claims/:id/analyze": "crm.write",
  "POST /bie/claims/:id/observations/:observationId/review": "crm.write",
  "POST /bie/claims/:id/certificates/:certificateId/issue": "crm.write",
  "GET /bie/claims/:id/graphs": "crm.read",
  "POST /bie/claims/:id/graphs/native-estimate": "crm.write",
  "GET /bie/claims/:id/graphs/:graphId/targets/:target": "crm.read",
  "GET /bie/claims/:id/corroborations": "crm.read",
  "POST /bie/claims/:id/corroborations": "crm.write",
  "POST /bie/claims/:id/corroborations/:corroborationId/review": "crm.write",
  "GET /bie/claims/:id/routes": "crm.read",
  "POST /bie/claims/:id/routes": "crm.write",
  // settings surfaces
  "GET /settings": "crm.read",
  // read-only effective availability; needed by anyone booking appointments
  "GET /settings/inspection-availability": "crm.read",
  "GET /settings/email-provider": "settings.manage",
  "GET /data-lifecycle/inventory": "settings.manage",
  "GET /settings/sms-provider": "settings.manage",
  "GET /communications/sms": "crm.read",
  "GET /communications/voice": "crm.read",
  "POST /communications/voice": "crm.write",
  "POST /communications/voice/:id/review": "crm.write",
  "GET /service-obligations": "crm.read",
  "POST /service-obligations": "crm.write",
  "PATCH /service-obligations/:id": "crm.write",
  "POST /service-obligations/import": "crm.write",
  "POST /service-obligations/:id/recurrence": "crm.write",
  "POST /communications/sms": "crm.write",
  // Gmail authorization is personal to the signed-in member, not an org-wide
  // admin credential. Tenant/user binding is enforced again in the service.
  "GET /integrations/gmail": "crm.read",
  "POST /integrations/gmail/connect": "crm.read",
  "GET /integrations/gmail/callback": "crm.read",
  "DELETE /integrations/gmail": "crm.read",
  "GET /integrations/google/modules": "crm.read",
  "POST /integrations/google/modules/:module/connect": "crm.read",
  "PUT /integrations/google/modules/:module": "crm.read",
  // Email Intelligence source configuration is owner/admin controlled. All
  // members may inspect tenant facts; writers disposition findings.
  "GET /email-intelligence": "crm.read",
  "POST /email-intelligence/source": "settings.manage",
  "PATCH /email-intelligence/source/:id": "settings.manage",
  "GET /email-intelligence/messages": "crm.read",
  "GET /email-intelligence/replies": "crm.read",
  "POST /email-intelligence/replies/:id/review": "crm.write",
  "POST /email-intelligence/replies/:id/resolve": "crm.write",
  "POST /email-intelligence/test": "settings.manage",
  "POST /email-intelligence/facts/:id/review": "crm.write",
  "DELETE /email-intelligence/messages/:id/raw": "settings.manage",
  "DELETE /email-intelligence/messages/:id": "settings.manage",
  "PUT /settings": "settings.manage",
  "GET /installation": "settings.manage",
  "POST /installation/checks": "settings.manage",
  "GET /forms": "settings.manage",
  "POST /forms": "settings.manage",
  "PATCH /forms/:id": "settings.manage",
  "DELETE /forms/:id": "settings.manage",
  "GET /forms/:id/submissions": "settings.manage",
  "GET /forms/:id/share": "settings.manage",
  "GET /knowledge": "settings.manage",
  "POST /knowledge": "settings.manage",
  "PATCH /knowledge/:id": "settings.manage",
  "DELETE /knowledge/:id": "settings.manage",
  "POST /installation/rotate": "settings.manage",
  "POST /installation/domains": "settings.manage",
  "DELETE /installation/domains/:id": "settings.manage",
  "GET /api-keys": "settings.manage",
  "POST /api-keys": "settings.manage",
  "PATCH /api-keys/:id": "settings.manage",
  "DELETE /api-keys/:id": "settings.manage",
  "GET /templates": "crm.read",
  "POST /templates": "settings.manage",
  "PATCH /templates/:id": "settings.manage",
  "DELETE /templates/:id": "settings.manage",
  "GET /automations": "crm.read",
  "POST /automations": "settings.manage",
  "PATCH /automations/:id": "settings.manage",
  "DELETE /automations/:id": "settings.manage",
  "GET /automation-runs": "crm.read",
  "GET /playbook-insights": "crm.read",
  "GET /copilot-performance": "crm.read",
  "GET /next-actions": "crm.read",
  "GET /leads/:id/next-action": "crm.read",
  "POST /leads/:id/next-action/feedback": "crm.write",
  "GET /playbooks": "crm.read",
  "POST /playbooks": "settings.manage",
  "PATCH /playbooks/:id": "settings.manage",
  "GET /leads/:id/enrollment": "crm.read",
  "POST /enrollments/:id/skip": "crm.write",
  // external lead capture (inbound webhook endpoints + mapping)
  "GET /capture-endpoints": "crm.read",
  "POST /capture-endpoints": "crm.write",
  "PATCH /capture-endpoints/:id": "crm.write",
  "DELETE /capture-endpoints/:id": "crm.delete",
  "POST /capture-endpoints/preview": "crm.read",
  "GET /capture-deliveries": "crm.read",
  // reactivation (CSV import + win-back campaigns)
  "POST /lead-imports": "crm.write",
  "GET /lead-imports": "crm.read",
  "GET /reactivation/segments": "crm.read",
  "POST /reactivation/segments/preview": "crm.read",
  "GET /reactivation/campaigns": "crm.read",
  "POST /reactivation/campaigns": "crm.write",
  "POST /reactivation/campaigns/preview-outreach": "crm.write",
  "GET /reactivation/campaigns/:id": "crm.read",
  "POST /reactivation/campaigns/:id/launch": "crm.write",
  "POST /reactivation/campaigns/:id/pause": "crm.write",
  "POST /reactivation/campaigns/:id/resume": "crm.write",
  "POST /reactivation/campaigns/:id/cancel": "crm.write",
  "GET /webhooks": "settings.manage",
  "POST /webhooks": "settings.manage",
  "PATCH /webhooks/:id": "settings.manage",
  "POST /webhooks/:id/rotate-secret": "settings.manage",
  "DELETE /webhooks/:id/previous-secret": "settings.manage",
  "DELETE /webhooks/:id": "settings.manage",
  "GET /webhook-deliveries": "settings.manage",
  // tags
  "GET /tags": "crm.read",
  "POST /tags": "crm.write",
  // storage (photo streaming; service layer verifies org linkage)
  "GET /storage/objects/*path": "crm.read",
  // onboarding wizard: reading progress is fine for any member; writing
  // progress and running the sandbox demo configure the org.
  "GET /onboarding": "crm.read",
  "PATCH /onboarding": "settings.manage",
  "POST /onboarding/test-lead": "settings.manage",
  "DELETE /onboarding/test-lead": "settings.manage",
  // Demo data changes organization-wide sample records, so only admins may
  // load or clear it.
  "POST /demo-data": "settings.manage",
  "DELETE /demo-data": "settings.manage",
};

// DELETE routes allowed to use something weaker than crm.delete, with the
// reason. Everything else destructive must be crm.delete or settings.manage.
const DELETE_EXEMPTIONS: Record<string, Permission> = {
  // Personal Microsoft authorization only; the explicit session-only gate
  // forbids API keys and scopes revocation to the caller, never tenant data.
  "DELETE /integrations/microsoft": "crm.write",
  // Personal, per-user resource — deleting your own saved filter.
  "DELETE /saved-filters/:id": "crm.read",
  // Personal, per-user authorization — revokes only the caller's own Gmail
  // token and cannot remove another member's connection or organization data.
  "DELETE /integrations/gmail": "crm.read",
  // Removes one photo path from a lead's activity row, not the lead itself;
  // write-level access is the correct bar.
  "DELETE /leads/:id/photos": "crm.write",
  // Removes only the sandbox demo lead the wizard created; org-configuration
  // level access is the right bar.
  "DELETE /onboarding/test-lead": "settings.manage",
};

function isTaggedGuard(
  handle: unknown,
): handle is { requiredPermission: Permission } {
  return (
    typeof handle === "function" &&
    typeof (handle as { requiredPermission?: unknown }).requiredPermission ===
      "string"
  );
}

/** Recursively collect every route mounted on a router. */
function collectRoutes(
  router: unknown,
  routes: RouteEntry[] = [],
): RouteEntry[] {
  const stack = (router as { stack?: unknown[] }).stack;
  if (!Array.isArray(stack)) return routes;
  for (const layer of stack as Array<{
    route?: {
      path: string | string[];
      stack: Array<{ method?: string; handle: unknown }>;
    };
    handle?: unknown;
  }>) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      const methods = new Set(
        layer.route.stack
          .map((l) => l.method)
          .filter((m): m is string => typeof m === "string"),
      );
      const permissions = layer.route.stack
        .map((l) => l.handle)
        .filter(isTaggedGuard)
        .map((h) => h.requiredPermission);
      for (const path of paths) {
        for (const method of methods) {
          routes.push({
            method: method.toUpperCase(),
            path,
            permissions,
            handlerCount: layer.route.stack.length,
            platformGuard: layer.route.stack.some(
              (l) => l.handle === requirePlatformAdmin,
            ),
          });
        }
      }
    } else if (
      layer.handle &&
      Array.isArray((layer.handle as { stack?: unknown[] }).stack)
    ) {
      // Nested router mounted via router.use()
      collectRoutes(layer.handle, routes);
    }
  }
  return routes;
}

const routes = collectRoutes(v1Router);
const isPublic = (path: string) =>
  PUBLIC_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
const keyOf = (r: RouteEntry) => `${r.method} ${r.path}`;
const protectedRoutes = routes.filter(
  (r) => !isPublic(r.path) && !SESSION_ONLY_ROUTES.has(keyOf(r)),
);

describe("v1 route inventory", () => {
  it("platform routes carry the fresh session and platform-admin gate", () => {
    expect(
      routes
        .filter((r) => r.path.startsWith("/platform/") && !r.platformGuard)
        .map(keyOf),
    ).toEqual([]);
  });
  it("discovers a non-trivial number of routes (walker sanity check)", () => {
    // If Express internals change and the walker silently finds nothing,
    // every other assertion would vacuously pass. Guard against that.
    expect(routes.length).toBeGreaterThanOrEqual(50);
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(40);
  });

  it("every non-public route is guarded by requireMember", () => {
    const unguarded = protectedRoutes
      .filter((r) => r.permissions.length === 0)
      .map(keyOf);
    expect(
      unguarded,
      `Routes missing requireMember: ${unguarded.join(", ")}`,
    ).toEqual([]);
  });

  it("every non-public route carries exactly the permission the contract expects", () => {
    const violations: string[] = [];
    for (const r of protectedRoutes) {
      const expected = EXPECTED_PERMISSIONS[keyOf(r)];
      if (!expected) {
        violations.push(
          `${keyOf(r)} is not in EXPECTED_PERMISSIONS — new routes must declare their permission in this contract`,
        );
        continue;
      }
      if (r.permissions.length !== 1 || r.permissions[0] !== expected) {
        violations.push(
          `${keyOf(r)} expected requireMember("${expected}"), found [${r.permissions.join(", ")}]`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the contract has no stale entries for routes that no longer exist", () => {
    const mounted = new Set(protectedRoutes.map(keyOf));
    const stale = Object.keys(EXPECTED_PERMISSIONS).filter(
      (key) => !mounted.has(key),
    );
    expect(stale, `Remove stale contract entries: ${stale.join(", ")}`).toEqual(
      [],
    );
  });

  it("DELETE routes are destructive-grade (crm.delete / settings.manage) unless explicitly exempted", () => {
    // Guards the contract itself: even a contract edit cannot quietly grant a
    // weak permission to a destructive route without an explicit exemption.
    const violations: string[] = [];
    for (const [key, expected] of Object.entries(EXPECTED_PERMISSIONS)) {
      if (!key.startsWith("DELETE ")) continue;
      const exemption = DELETE_EXEMPTIONS[key];
      if (exemption) {
        if (expected !== exemption) {
          violations.push(
            `${key} exemption says ${exemption} but contract says ${expected}`,
          );
        }
        continue;
      }
      if (expected !== "crm.delete" && expected !== "settings.manage") {
        violations.push(
          `${key} uses ${expected}; destructive routes need crm.delete or settings.manage (or an explicit exemption with rationale)`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("requireMember runs alongside a terminal handler (guard is not the only handler)", () => {
    const suspicious = protectedRoutes
      .filter((r) => r.permissions.length > 0 && r.handlerCount < 2)
      .map(keyOf);
    expect(suspicious).toEqual([]);
  });
});
