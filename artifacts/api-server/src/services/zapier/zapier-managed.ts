import {
  auditEventsTable,
  db,
  organizationsTable,
  zapierActionExecutionsTable as executions,
  zapierCapabilityBindingsTable as bindings,
  zapierMcpConnectionsTable as connections,
  zapierSpecialistPoliciesTable as policies,
} from "@workspace/db";
import { and, count, eq, gte, inArray, lt, ne, like, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../../lib/token-encryption";
import { describeZapierStatus } from "./zapier-connection";
import {
  lockZapierResource,
  withZapierOrgTransaction,
  managedMetadata,
  newManagedFingerprint,
  monthlyStarted,
  utcMonth,
  publicVersion,
  type ZapierTransaction,
} from "./zapier-credential-metadata";
import {
  sha256Hex,
  withZapierMcpSession,
  ZAPIER_META_TOOLS,
} from "./zapier-mcp-client";

export class ManagedZapierError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function rowFor(tx: ZapierTransaction, organizationId: string) {
  const [org] = await tx
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId))
    .for("key share");
  if (!org) throw new ManagedZapierError(404, "Client not found.");
  const [row] = await tx
    .select()
    .from(connections)
    .where(eq(connections.organizationId, organizationId));
  return row ?? null;
}

async function describe(tx: ZapierTransaction, organizationId: string) {
  const row = await rowFor(tx, organizationId);
  const status = describeZapierStatus(row);
  const { start, end } = utcMonth();
  const monthlyActionsUsed = await monthlyStarted(tx, organizationId, start);
  const monthlyActionLimit = status.monthlyActionLimit;
  const counts = await tx
    .select({ state: executions.state, total: count() })
    .from(executions)
    .where(
      and(
        eq(executions.organizationId, organizationId),
        gte(executions.completedAt, start),
        lt(executions.completedAt, end),
        inArray(executions.state, ["succeeded", "indeterminate"]),
      ),
    )
    .groupBy(executions.state);
  const successfulActions =
    counts.find((item) => item.state === "succeeded")?.total ?? 0;
  const indeterminateActions =
    counts.find((item) => item.state === "indeterminate")?.total ?? 0;
  let serverReference: string | null = null;
  if (row && !row.revokedAt && status.provisioning === "mogulforge") {
    serverReference = JSON.parse(
      decryptSecret(row.encryptedServerUrl, organizationId + ":zapier-mcp"),
    ).serverReference;
  }
  return {
    organizationId,
    status,
    serverReference,
    usage: {
      monthlyActionLimit,
      monthlyActionsUsed,
      monthlyActionsRemaining:
        monthlyActionLimit === null
          ? null
          : Math.max(0, monthlyActionLimit - monthlyActionsUsed),
      monthStartUtc: start.toISOString(),
      successfulActions,
      indeterminateActions,
      estimatedTasksFromRecordedActions: 2 * successfulActions,
    },
  };
}

export function platformZapierStatus(organizationId: string) {
  return db.transaction((tx) => describe(tx, organizationId));
}

async function invalidate(
  tx: ZapierTransaction,
  organizationId: string,
  userId: string,
  clearBindings = true,
) {
  await tx
    .update(policies)
    .set({ mode: "off", updatedByUserId: userId, updatedAt: new Date() })
    .where(eq(policies.organizationId, organizationId));
  if (clearBindings)
    await tx
      .delete(bindings)
      .where(eq(bindings.organizationId, organizationId));
}

export async function assignZapier(
  organizationId: string,
  userId: string,
  input: {
    serverReference: string;
    connectionToken: string;
    expectedConnectionFingerprint: string | null;
    ownershipConfirmed: true;
    dedicatedConnectionConfirmed: true;
    monthlyActionLimit?: number;
  },
) {
  if (
    input.monthlyActionLimit !== undefined &&
    (!Number.isInteger(input.monthlyActionLimit) ||
      input.monthlyActionLimit < 0 ||
      input.monthlyActionLimit > 100000)
  )
    throw new ManagedZapierError(400, "Invalid monthly action limit.");
  if (
    !input.ownershipConfirmed ||
    !input.dedicatedConnectionConfirmed ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.serverReference) ||
    !/^[!-~]{1,4096}$/.test(input.connectionToken) ||
    input.serverReference.includes(input.connectionToken)
  )
    throw new ManagedZapierError(400, "Invalid managed connection details.");
  return withZapierOrgTransaction(organizationId, async (tx) => {
    const row = await rowFor(tx, organizationId);
    if (publicVersion(row) !== input.expectedConnectionFingerprint)
      throw new ManagedZapierError(
        409,
        "Connection changed. Refresh before saving.",
      );
    const referenceHash = sha256Hex(input.serverReference);
    const tokenHash = sha256Hex(input.connectionToken);
    const previous = row && managedMetadata(row.serverUrlFingerprint);
    if (previous && previous.referenceHash !== referenceHash)
      throw new ManagedZapierError(
        409,
        "This client already has a dedicated server reference.",
      );
    await lockZapierResource(tx, "reference:" + referenceHash);
    await lockZapierResource(tx, "token:" + tokenHash);
    const others = await tx
      .select({ fingerprint: connections.serverUrlFingerprint })
      .from(connections)
      .where(
        and(
          ne(connections.organizationId, organizationId),
          like(connections.serverUrlFingerprint, "mf1:%"),
        ),
      );
    // Keep history in the append-only assignment audit. The indexed current
    // fingerprint stays bounded after any number of same-company rotations.
    const [priorOwner] = await tx
      .select({ id: auditEventsTable.id })
      .from(auditEventsTable)
      .where(
        and(
          ne(auditEventsTable.organizationId, organizationId),
          eq(auditEventsTable.action, "integration.zapier_managed_assigned"),
          sql`${auditEventsTable.metadata}->>'tokenHash' = ${tokenHash}`,
        ),
      )
      .limit(1);
    if (
      priorOwner ||
      others.some((other) => {
        const record = managedMetadata(other.fingerprint);
        return (
          record &&
          (record.referenceHash === referenceHash ||
            record.tokenHash === tokenHash)
        );
      })
    )
      throw new ManagedZapierError(
        409,
        "This credential or reference belongs to another client.",
      );
    const monthlyActionLimit =
      input.monthlyActionLimit ?? previous?.monthlyActionLimit ?? 1000;
    const envelope = JSON.stringify({
      source: "mogulforge",
      version: 1,
      monthlyActionLimit,
      serverReference: input.serverReference,
      connectionToken: input.connectionToken,
    });
    const sameCredential =
      row &&
      previous &&
      !row.revokedAt &&
      JSON.parse(
        decryptSecret(row.encryptedServerUrl, organizationId + ":zapier-mcp"),
      ).connectionToken === input.connectionToken;
    if (sameCredential) {
      if (previous.monthlyActionLimit !== monthlyActionLimit) {
        await tx
          .update(connections)
          .set({
            encryptedServerUrl: encryptSecret(
              envelope,
              organizationId + ":zapier-mcp",
            ),
            serverUrlFingerprint: newManagedFingerprint(
              input.serverReference,
              input.connectionToken,
              monthlyActionLimit,
            ),
          })
          .where(eq(connections.id, row.id));
        await tx.insert(auditEventsTable).values({
          organizationId,
          actorUserId: userId,
          action: "integration.zapier_monthly_limit_changed",
          entityType: "zapier_mcp_connection",
          metadata: { monthlyActionLimit },
        });
      }
      return describe(tx, organizationId);
    }
    // Verify the tenant encryption key before transmitting the credential.
    const encryptedServerUrl = encryptSecret(
      envelope,
      organizationId + ":zapier-mcp",
    );
    const tools = await withZapierMcpSession(envelope, (session) =>
      session.listTools(),
    );
    const names = new Set(tools.map((tool) => tool.name));
    if (
      ![
        ZAPIER_META_TOOLS.inspect,
        ZAPIER_META_TOOLS.executeRead,
        ZAPIER_META_TOOLS.executeWrite,
      ].every((name) => names.has(name))
    ) {
      throw new ManagedZapierError(
        422,
        "A dedicated agentic server with inspection, read and write actions is required.",
      );
    }
    const values = {
      organizationId,
      connectedByUserId: userId,
      encryptedServerUrl,
      serverUrlFingerprint: newManagedFingerprint(
        input.serverReference,
        input.connectionToken,
        monthlyActionLimit,
      ),
      serverHost: "mcp.zapier.com",
      serverMode: "agentic" as const,
      toolCount: tools.length,
      lastToolsRefreshedAt: new Date(),
      connectedAt: new Date(),
      revokedAt: null,
      lastUsedAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
    };
    await invalidate(tx, organizationId, userId);
    await tx
      .insert(connections)
      .values(values)
      .onConflictDoUpdate({ target: connections.organizationId, set: values });
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId: userId,
      action: "integration.zapier_managed_assigned",
      entityType: "zapier_mcp_connection",
      metadata: {
        tokenHash,
        ownershipConfirmed: true,
        dedicatedConnectionConfirmed: true,
      },
    });
    return describe(tx, organizationId);
  });
}

export function revokeZapier(
  organizationId: string,
  userId: string,
  expected?: string | null,
) {
  return withZapierOrgTransaction(organizationId, async (tx) => {
    const row = await rowFor(tx, organizationId);
    if (expected !== undefined && publicVersion(row) !== expected)
      throw new ManagedZapierError(
        409,
        "Connection changed. Refresh before revoking.",
      );
    if (!row || row.revokedAt) return false;
    await tx
      .update(connections)
      .set({ revokedAt: new Date(), encryptedServerUrl: "" })
      .where(eq(connections.id, row.id));
    await invalidate(
      tx,
      organizationId,
      userId,
      !!managedMetadata(row.serverUrlFingerprint),
    );
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId: userId,
      action: "integration.zapier_disconnected",
      entityType: "zapier_mcp_connection",
    });
    return true;
  });
}
