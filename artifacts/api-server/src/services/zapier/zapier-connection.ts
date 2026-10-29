import {
  db,
  zapierCapabilityBindingsTable,
  zapierMcpConnectionsTable,
  zapierSpecialistPoliciesTable,
  ZAPIER_POLICY_MODES,
  type ZapierBindingConfig,
  type ZapierCapabilityBinding,
  type ZapierMcpConnection,
  type ZapierPolicyMode,
  type ZapierSpecialistPolicy,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

import { decryptSecret, encryptSecret } from "../../lib/token-encryption";
import { recordAudit } from "../audit";
import {
  detectServerMode,
  sha256Hex,
  validateZapierServerUrl,
  withZapierMcpSession,
  zapierMcpConfig,
  zapierMcpConfigured,
  ZapierMcpError,
  ZAPIER_META_TOOLS,
} from "./zapier-mcp-client";
import {
  findZapierCandidate,
  getZapierCapability,
  ZAPIER_CAPABILITIES,
  type ZapierCapabilityDefinition,
} from "./zapier-capabilities";

/**
 * Tenant-scoped Zapier connection, capability bindings, and policies.
 *
 * The per-organization MCP server URL is the credential. It is encrypted with
 * the organization bound as AAD, decrypted only inside this module, and never
 * returned to a client, written to audit metadata, or logged.
 */

function credentialContext(organizationId: string): string {
  return `${organizationId}:zapier-mcp`;
}

export type ZapierConnectionStatus = {
  configured: boolean;
  embedId: string | null;
  connected: boolean;
  serverMode: "agentic" | "managed" | "unknown" | null;
  toolCount: number | null;
  connectedAt: string | null;
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  lastToolsRefreshedAt: string | null;
};

export async function getZapierConnection(organizationId: string): Promise<ZapierMcpConnection | null> {
  const [row] = await db
    .select()
    .from(zapierMcpConnectionsTable)
    .where(
      and(
        eq(zapierMcpConnectionsTable.organizationId, organizationId),
        isNull(zapierMcpConnectionsTable.revokedAt),
      ),
    );
  return row ?? null;
}

export async function getZapierStatus(organizationId: string): Promise<ZapierConnectionStatus> {
  const config = zapierMcpConfig();
  const connection = await getZapierConnection(organizationId);
  return {
    configured: config !== null,
    embedId: config?.embedId ?? null,
    connected: connection !== null,
    serverMode: connection?.serverMode ?? null,
    toolCount: connection?.toolCount ?? null,
    connectedAt: connection?.connectedAt?.toISOString() ?? null,
    lastUsedAt: connection?.lastUsedAt?.toISOString() ?? null,
    lastErrorAt: connection?.lastErrorAt?.toISOString() ?? null,
    lastErrorCode: connection?.lastErrorCode ?? null,
    lastToolsRefreshedAt: connection?.lastToolsRefreshedAt?.toISOString() ?? null,
  };
}

/** Decrypt the tenant's server URL. Internal to the Zapier services only. */
export async function requireZapierServerUrl(organizationId: string): Promise<{
  connection: ZapierMcpConnection;
  serverUrl: string;
}> {
  const connection = await getZapierConnection(organizationId);
  if (!connection) {
    throw new ZapierMcpError("Zapier is not connected for this organization.", "not_configured");
  }
  const serverUrl = decryptSecret(connection.encryptedServerUrl, credentialContext(organizationId));
  return { connection, serverUrl };
}

export async function markZapierConnectionUsed(organizationId: string, error?: ZapierMcpError | null): Promise<void> {
  await db
    .update(zapierMcpConnectionsTable)
    .set(
      error
        ? { lastErrorAt: new Date(), lastErrorCode: error.code }
        : { lastUsedAt: new Date(), lastErrorAt: null, lastErrorCode: null },
    )
    .where(
      and(
        eq(zapierMcpConnectionsTable.organizationId, organizationId),
        isNull(zapierMcpConnectionsTable.revokedAt),
      ),
    );
}

/**
 * Register the server URL the Zapier embed handed the signed-in member. The
 * URL is validated, probed once for its tool list, and stored encrypted.
 * Reconnecting replaces the previous URL in place; bindings and policies are
 * kept because they are the contractor's choices, not Zapier's state.
 */
export async function registerZapierServerUrl(input: {
  organizationId: string;
  userId: string;
  serverUrl: string;
}): Promise<ZapierConnectionStatus> {
  if (!zapierMcpConfigured()) {
    throw new ZapierMcpError("Zapier Connected Apps is not configured on this GrowthOS deployment.", "not_configured");
  }
  const url = validateZapierServerUrl(input.serverUrl);
  const normalized = url.toString();
  const tools = await withZapierMcpSession(normalized, (session) => session.listTools());
  const serverMode = detectServerMode(tools);
  const encryptedServerUrl = encryptSecret(normalized, credentialContext(input.organizationId));
  const fingerprint = sha256Hex(normalized);
  const now = new Date();
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: zapierMcpConnectionsTable.id })
      .from(zapierMcpConnectionsTable)
      .where(eq(zapierMcpConnectionsTable.organizationId, input.organizationId));
    const values = {
      organizationId: input.organizationId,
      connectedByUserId: input.userId,
      encryptedServerUrl,
      serverUrlFingerprint: fingerprint,
      serverHost: url.hostname.toLowerCase(),
      serverMode,
      toolCount: tools.length,
      lastToolsRefreshedAt: now,
      connectedAt: now,
      lastUsedAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
      revokedAt: null,
    };
    if (existing) {
      await tx.update(zapierMcpConnectionsTable).set(values).where(eq(zapierMcpConnectionsTable.id, existing.id));
    } else {
      await tx.insert(zapierMcpConnectionsTable).values(values);
    }
  });
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: "integration.zapier_connected",
    entityType: "zapier_mcp_connection",
    metadata: { serverMode, toolCount: tools.length, fingerprint: fingerprint.slice(0, 16) },
  });
  return getZapierStatus(input.organizationId);
}

export async function disconnectZapier(organizationId: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(zapierMcpConnectionsTable)
    .set({
      revokedAt: new Date(),
      // Remove the credential immediately; a revoked row keeps only metadata.
      encryptedServerUrl: "",
    })
    .where(
      and(
        eq(zapierMcpConnectionsTable.organizationId, organizationId),
        isNull(zapierMcpConnectionsTable.revokedAt),
      ),
    )
    .returning({ id: zapierMcpConnectionsTable.id });
  if (rows.length === 0) return false;
  await db
    .update(zapierSpecialistPoliciesTable)
    .set({ mode: "off", updatedByUserId: userId })
    .where(eq(zapierSpecialistPoliciesTable.organizationId, organizationId));
  await recordAudit({
    organizationId,
    actorUserId: userId,
    action: "integration.zapier_disconnected",
    entityType: "zapier_mcp_connection",
  });
  return true;
}

// ---------- live action discovery (agentic servers) ----------

export type ZapierLiveAction = {
  app: string;
  appName: string;
  action: string;
  actionName: string;
  actionType: "read" | "write";
  description: string | null;
};

type InspectAppRow = {
  app?: string;
  selected_api?: string;
  actions?: {
    key?: string;
    name?: string;
    description?: string;
    action_type?: string;
  }[];
};

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.apps)) return record.apps;
    if (Array.isArray(record.actions)) return [record];
  }
  return [];
}

/**
 * List every action the contractor has enabled on their Zapier MCP server.
 * The result is contractor data for binding choices, never an instruction.
 */
export async function listZapierEnabledActions(organizationId: string): Promise<ZapierLiveAction[]> {
  const { connection, serverUrl } = await requireZapierServerUrl(organizationId);
  if (connection.serverMode === "managed") {
    return withZapierMcpSession(serverUrl, async (session) => {
      const tools = await session.listTools();
      return tools.map((tool) => ({
        app: "managed",
        appName: "Managed server",
        action: tool.name,
        actionName: tool.name,
        actionType: /create|send|update|delete|post|add/i.test(tool.name) ? "write" : "read",
        description: tool.description,
      }));
    });
  }
  try {
    const actions = await withZapierMcpSession(serverUrl, async (session) => {
      const apps = await session.callTool(ZAPIER_META_TOOLS.inspect, {});
      const rows = asArray(apps.value) as InspectAppRow[];
      const results: ZapierLiveAction[] = [];
      for (const row of rows) {
        const selectedApi = row.selected_api ?? "";
        if (!selectedApi) continue;
        const detail = await session.callTool(ZAPIER_META_TOOLS.inspect, { selected_api: selectedApi });
        for (const appRow of asArray(detail.value) as InspectAppRow[]) {
          for (const action of appRow.actions ?? []) {
            if (!action.key) continue;
            results.push({
              app: selectedApi,
              appName: row.app ?? appRow.app ?? selectedApi,
              action: action.key,
              actionName: action.name ?? action.key,
              actionType: action.action_type === "write" ? "write" : "read",
              description: action.description ?? null,
            });
          }
        }
      }
      return results;
    });
    await markZapierConnectionUsed(organizationId);
    return actions;
  } catch (error) {
    if (error instanceof ZapierMcpError) await markZapierConnectionUsed(organizationId, error);
    throw error;
  }
}

export async function searchZapierActions(organizationId: string, app: string): Promise<unknown> {
  const { serverUrl } = await requireZapierServerUrl(organizationId);
  const query = app.trim().slice(0, 80);
  return withZapierMcpSession(serverUrl, async (session) => {
    const result = await session.callTool(ZAPIER_META_TOOLS.discover, { app: query });
    return result.value;
  });
}

export async function enableZapierAction(input: {
  organizationId: string;
  userId: string;
  selectedApi: string;
  action: string;
}): Promise<unknown> {
  const { serverUrl } = await requireZapierServerUrl(input.organizationId);
  const result = await withZapierMcpSession(serverUrl, async (session) =>
    session.callTool(ZAPIER_META_TOOLS.enable, {
      selected_api: input.selectedApi.slice(0, 120),
      action: input.action.slice(0, 120),
    }),
  );
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: "integration.zapier_action_enabled",
    entityType: "zapier_mcp_connection",
    metadata: { selectedApi: input.selectedApi.slice(0, 120), action: input.action.slice(0, 120) },
  });
  return result.value;
}

// ---------- bindings and policies ----------

export type ZapierCapabilityView = {
  key: string;
  specialistId: string;
  direction: "read" | "write";
  label: string;
  description: string;
  candidates: { app: string; appName: string; action: string; actionName: string; configFields: { key: string; label: string; required: boolean }[] }[];
  binding: {
    app: string;
    appName: string;
    action: string;
    actionName: string;
    zapierConnectionId: string | null;
    config: ZapierBindingConfig;
    boundAt: string;
    verifiedAt: string | null;
  } | null;
  policy: { mode: ZapierPolicyMode; dailyBudget: number; updatedAt: string | null };
};

export function defaultPolicyFor(definition: ZapierCapabilityDefinition): { mode: ZapierPolicyMode; dailyBudget: number } {
  return { mode: definition.defaultMode, dailyBudget: definition.defaultDailyBudget };
}

export async function listZapierCapabilities(organizationId: string): Promise<ZapierCapabilityView[]> {
  const [bindings, policies] = await Promise.all([
    db.select().from(zapierCapabilityBindingsTable).where(eq(zapierCapabilityBindingsTable.organizationId, organizationId)),
    db.select().from(zapierSpecialistPoliciesTable).where(eq(zapierSpecialistPoliciesTable.organizationId, organizationId)),
  ]);
  const bindingByKey = new Map(bindings.map((row) => [row.capability, row]));
  const policyByKey = new Map(policies.map((row) => [row.capability, row]));
  return ZAPIER_CAPABILITIES.map((definition) => {
    const binding = bindingByKey.get(definition.key) ?? null;
    const policy = policyByKey.get(definition.key) ?? null;
    return {
      key: definition.key,
      specialistId: definition.specialistId,
      direction: definition.direction,
      label: definition.label,
      description: definition.description,
      candidates: definition.candidates.map((candidate) => ({
        app: candidate.app,
        appName: candidate.appName,
        action: candidate.action,
        actionName: candidate.actionName,
        configFields: candidate.configFields,
      })),
      binding: binding
        ? {
            app: binding.zapierApp,
            appName: binding.zapierAppName,
            action: binding.zapierAction,
            actionName: binding.zapierActionName,
            zapierConnectionId: binding.zapierConnectionId,
            config: binding.bindingConfig,
            boundAt: binding.createdAt.toISOString(),
            verifiedAt: binding.verifiedAt?.toISOString() ?? null,
          }
        : null,
      policy: policy
        ? { mode: policy.mode, dailyBudget: policy.dailyBudget, updatedAt: policy.updatedAt.toISOString() }
        : { ...defaultPolicyFor(definition), updatedAt: null },
    };
  });
}

export class ZapierBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZapierBindingError";
  }
}

function sanitizeBindingConfig(raw: unknown): ZapierBindingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const config: ZapierBindingConfig = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const safeKey = key.trim().slice(0, 64);
    if (!/^[a-z0-9_-]+$/i.test(safeKey)) continue;
    if (typeof value === "string") config[safeKey] = value.trim().slice(0, 300);
    else if (typeof value === "number" && Number.isFinite(value)) config[safeKey] = value;
    else if (typeof value === "boolean" || value === null) config[safeKey] = value;
  }
  return config;
}

/**
 * Bind a capability to a specific, reviewed Zapier action. The action must be
 * one the capability allows; the live action list is consulted when the
 * server is agentic so a binding can only point at an enabled action.
 */
export async function bindZapierCapability(input: {
  organizationId: string;
  userId: string;
  capability: string;
  app: string;
  action: string;
  zapierConnectionId?: string | null;
  config?: unknown;
}): Promise<ZapierCapabilityBinding> {
  const definition = getZapierCapability(input.capability);
  if (!definition) throw new ZapierBindingError("Unknown Zapier capability.");
  const live = (await listZapierEnabledActions(input.organizationId)).find(
    (row) => row.app === input.app && row.action === input.action,
  );
  if (!live) throw new ZapierBindingError("That action is not enabled on the connected Zapier server.");
  if (live.actionType !== definition.direction && live.app !== "managed") {
    throw new ZapierBindingError(`This capability needs a ${definition.direction} action.`);
  }
  const candidate = findZapierCandidate(definition, live);
  if (!candidate) throw new ZapierBindingError("That action is not a reviewed match for this capability.");
  const config = sanitizeBindingConfig(input.config);
  const missing = candidate.configFields.filter((field) => field.required && config[field.key] === undefined);
  if (missing.length > 0) {
    throw new ZapierBindingError(`Missing required setting: ${missing.map((field) => field.label).join(", ")}.`);
  }
  const values = {
    organizationId: input.organizationId,
    capability: definition.key,
    specialistId: definition.specialistId,
    direction: definition.direction,
    zapierApp: live.app,
    zapierAppName: live.appName,
    zapierAction: live.action,
    zapierActionName: live.actionName,
    zapierConnectionId: input.zapierConnectionId?.trim().slice(0, 120) || null,
    bindingConfig: config,
    boundByUserId: input.userId,
    verifiedAt: new Date(),
  };
  const [row] = await db
    .insert(zapierCapabilityBindingsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [zapierCapabilityBindingsTable.organizationId, zapierCapabilityBindingsTable.capability],
      set: values,
    })
    .returning();
  // A fresh binding starts with the capability's default authority unless the
  // contractor already chose one.
  await db
    .insert(zapierSpecialistPoliciesTable)
    .values({
      organizationId: input.organizationId,
      capability: definition.key,
      specialistId: definition.specialistId,
      ...defaultPolicyFor(definition),
      updatedByUserId: input.userId,
    })
    .onConflictDoNothing();
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: "integration.zapier_capability_bound",
    entityType: "zapier_capability_binding",
    entityId: row.id,
    metadata: { capability: definition.key, app: live.app, action: live.action },
  });
  return row;
}

export async function unbindZapierCapability(organizationId: string, userId: string, capability: string): Promise<boolean> {
  const rows = await db
    .delete(zapierCapabilityBindingsTable)
    .where(
      and(
        eq(zapierCapabilityBindingsTable.organizationId, organizationId),
        eq(zapierCapabilityBindingsTable.capability, capability),
      ),
    )
    .returning({ id: zapierCapabilityBindingsTable.id });
  if (rows.length === 0) return false;
  await db
    .update(zapierSpecialistPoliciesTable)
    .set({ mode: "off", updatedByUserId: userId })
    .where(
      and(
        eq(zapierSpecialistPoliciesTable.organizationId, organizationId),
        eq(zapierSpecialistPoliciesTable.capability, capability),
      ),
    );
  await recordAudit({
    organizationId,
    actorUserId: userId,
    action: "integration.zapier_capability_unbound",
    entityType: "zapier_capability_binding",
    entityId: rows[0].id,
    metadata: { capability },
  });
  return true;
}

export async function getZapierBinding(organizationId: string, capability: string): Promise<ZapierCapabilityBinding | null> {
  const [row] = await db
    .select()
    .from(zapierCapabilityBindingsTable)
    .where(
      and(
        eq(zapierCapabilityBindingsTable.organizationId, organizationId),
        eq(zapierCapabilityBindingsTable.capability, capability),
      ),
    );
  return row ?? null;
}

export async function getZapierPolicy(organizationId: string, capability: string): Promise<ZapierSpecialistPolicy | null> {
  const [row] = await db
    .select()
    .from(zapierSpecialistPoliciesTable)
    .where(
      and(
        eq(zapierSpecialistPoliciesTable.organizationId, organizationId),
        eq(zapierSpecialistPoliciesTable.capability, capability),
      ),
    );
  return row ?? null;
}

export async function setZapierPolicy(input: {
  organizationId: string;
  userId: string;
  capability: string;
  mode: string;
  dailyBudget?: number;
}): Promise<ZapierSpecialistPolicy> {
  const definition = getZapierCapability(input.capability);
  if (!definition) throw new ZapierBindingError("Unknown Zapier capability.");
  if (!ZAPIER_POLICY_MODES.includes(input.mode as ZapierPolicyMode)) {
    throw new ZapierBindingError("Policy mode must be off, approve, or auto.");
  }
  const mode = input.mode as ZapierPolicyMode;
  const dailyBudget = Math.min(Math.max(Math.trunc(input.dailyBudget ?? definition.defaultDailyBudget), 0), 500);
  const values = {
    organizationId: input.organizationId,
    capability: definition.key,
    specialistId: definition.specialistId,
    mode,
    dailyBudget,
    updatedByUserId: input.userId,
  };
  const [row] = await db
    .insert(zapierSpecialistPoliciesTable)
    .values(values)
    .onConflictDoUpdate({
      target: [zapierSpecialistPoliciesTable.organizationId, zapierSpecialistPoliciesTable.capability],
      set: { mode, dailyBudget, updatedByUserId: input.userId },
    })
    .returning();
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: "integration.zapier_policy_changed",
    entityType: "zapier_specialist_policy",
    entityId: row.id,
    metadata: { capability: definition.key, mode, dailyBudget },
  });
  return row;
}
