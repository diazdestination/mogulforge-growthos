import {
  db,
  googleIntegrationModulesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

import { getGmailConnection } from "./gmail-oauth";

export type GoogleModuleId =
  | "gmail_send"
  | "calendar_availability"
  | "calendar_events"
  | "drive_selected_files"
  | "sheets_selected_files"
  | "analytics"
  | "search_console"
  | "google_ads"
  | "business_profile"
  | "gmail_intelligence";

export type GoogleModuleDefinition = {
  id: GoogleModuleId;
  name: string;
  purpose: string;
  scopes: string[];
  access: "send" | "availability" | "read_only" | "selected_files" | "managed_read_only";
  maturity: "available" | "foundation" | "requires_provider_approval" | "deferred_restricted";
  risk: "standard" | "sensitive" | "restricted";
};

export const GOOGLE_MODULES: readonly GoogleModuleDefinition[] = [
  {
    id: "gmail_send",
    name: "Gmail sending",
    purpose: "Send human-approved follow-up from your own Gmail account.",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    access: "send",
    maturity: "available",
    risk: "sensitive",
  },
  {
    id: "calendar_availability",
    name: "Calendar availability",
    purpose: "Find open capacity and scheduling conflicts without reading event details.",
    scopes: ["https://www.googleapis.com/auth/calendar.freebusy"],
    access: "availability",
    maturity: "foundation",
    risk: "sensitive",
  },
  {
    id: "calendar_events",
    name: "Calendar intelligence",
    purpose: "Use event details to surface missed follow-ups, upcoming work, and scheduling risks.",
    scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
    access: "read_only",
    maturity: "foundation",
    risk: "sensitive",
  },
  {
    id: "drive_selected_files",
    name: "Selected Drive files",
    purpose: "Let users choose the business folders and documents GrowthOS may use.",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    access: "selected_files",
    maturity: "foundation",
    risk: "standard",
  },
  {
    id: "sheets_selected_files",
    name: "Selected Google Sheets",
    purpose: "Analyze explicitly selected operational, sales, estimating, and financial sheets.",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    access: "selected_files",
    maturity: "foundation",
    risk: "standard",
  },
  {
    id: "analytics",
    name: "Google Analytics",
    purpose: "Connect website demand, conversion behavior, and lead outcomes.",
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    access: "read_only",
    maturity: "foundation",
    risk: "sensitive",
  },
  {
    id: "search_console",
    name: "Search Console",
    purpose: "Surface search demand, visibility losses, and content opportunities.",
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    access: "read_only",
    maturity: "foundation",
    risk: "sensitive",
  },
  {
    id: "google_ads",
    name: "Google Ads",
    purpose: "Connect spend, campaigns, calls, leads, estimates, and won revenue.",
    scopes: ["https://www.googleapis.com/auth/adwords"],
    access: "read_only",
    maturity: "foundation",
    risk: "sensitive",
  },
  {
    id: "business_profile",
    name: "Business Profile",
    purpose: "Monitor locations, reviews, visibility, and customer-demand signals.",
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    access: "managed_read_only",
    maturity: "requires_provider_approval",
    risk: "sensitive",
  },
  {
    id: "gmail_intelligence",
    name: "Gmail inbox intelligence",
    purpose: "Scout customer commitments and missed opportunities in mailbox content.",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    access: "read_only",
    maturity: "deferred_restricted",
    risk: "restricted",
  },
] as const;

export function getGoogleModuleDefinition(value: string): GoogleModuleDefinition | null {
  return GOOGLE_MODULES.find((module) => module.id === value) ?? null;
}

export async function listGoogleModules(organizationId: string, userId: string) {
  const [connection, states] = await Promise.all([
    getGmailConnection(organizationId, userId),
    db
      .select()
      .from(googleIntegrationModulesTable)
      .where(
        and(
          eq(googleIntegrationModulesTable.organizationId, organizationId),
          eq(googleIntegrationModulesTable.userId, userId),
        ),
      ),
  ]);
  const byModule = new Map(states.map((state) => [state.module, state]));
  const granted = new Set(connection?.grantedScopes ?? []);
  return GOOGLE_MODULES.map((module) => {
    const state = byModule.get(module.id);
    const permissionGranted = module.scopes.every((scope) => granted.has(scope));
    return {
      ...module,
      permissionGranted,
      enabled: Boolean(state?.enabled && permissionGranted),
      lastSyncedAt: state?.lastSyncedAt ?? null,
      lastErrorAt: state?.lastErrorAt ?? null,
      lastErrorCode: state?.lastErrorCode ?? null,
    };
  });
}

export async function setGoogleModuleEnabled(input: {
  organizationId: string;
  userId: string;
  module: GoogleModuleId;
  enabled: boolean;
}) {
  const definition = getGoogleModuleDefinition(input.module);
  if (!definition) throw new Error("Unknown Google integration module");
  const connection = await getGmailConnection(input.organizationId, input.userId);
  const granted = new Set(connection?.grantedScopes ?? []);
  if (input.enabled && !definition.scopes.every((scope) => granted.has(scope))) {
    throw new Error("This module needs additional Google permission before it can be enabled");
  }
  const now = new Date();
  const [state] = await db
    .insert(googleIntegrationModulesTable)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      module: input.module,
      enabled: input.enabled,
      enabledAt: input.enabled ? now : null,
      disabledAt: input.enabled ? null : now,
    })
    .onConflictDoUpdate({
      target: [
        googleIntegrationModulesTable.organizationId,
        googleIntegrationModulesTable.userId,
        googleIntegrationModulesTable.module,
      ],
      set: {
        enabled: input.enabled,
        enabledAt: input.enabled ? now : null,
        disabledAt: input.enabled ? null : now,
        updatedAt: now,
      },
    })
    .returning();
  return state;
}
