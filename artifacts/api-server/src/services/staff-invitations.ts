import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditEventsTable,
  db,
  organizationsTable,
  staffInvitationsTable,
  usersTable,
  platformEmailDispatchesTable,
  type StaffInvitation,
  type User,
} from "@workspace/db";
import { hasPermission } from "../lib/permissions";
import { sendInviteEmail } from "./invite-email";
import { INVITE_TOKEN_TTL_MS, verifyInviteToken } from "./invite-token";
import { isPlatformIdentityDeliveryConfigured } from "./platform-email-delivery";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type InvitationActor = { userId: string; scope: "platform" | "member" };
export type InvitationInput = {
  requestId: string;
  email: string;
  role: User["role"];
  firstName?: string;
  lastName?: string;
};
export class StaffInvitationError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
const fail = (code: string, status?: number): never => {
  throw new StaffInvitationError(code, status);
};
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function actorFor(
  tx: Tx,
  actor: InvitationActor,
  organizationId: string,
  role?: User["role"],
) {
  const [user] = await tx
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, actor.userId))
    .for("share");
  if (!user?.isActive || user.id.startsWith("invite:") || !user.emailVerifiedAt)
    fail("invitation_access_denied", 403);
  if (
    actor.scope === "platform"
      ? !user.isPlatformAdmin
      : user.organizationId !== organizationId ||
        !hasPermission(user.role, "users.manage")
  )
    fail("invitation_access_denied", 403);
  if (role === "owner" && actor.scope !== "platform" && user.role !== "owner")
    fail("owner_invitation_requires_owner", 403);
  const [org] = await tx
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId))
    .for("share");
  if (!org) fail("client_not_found", 404);
  return user;
}

async function lockEmail(tx: Tx, email: string) {
  await tx.execute(sql`select set_config('lock_timeout', '3000ms', true)`);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`staff-invitation:${email}`}, 0))`,
  );
}

function view(row: StaffInvitation) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    version: row.version,
    state:
      row.state === "pending" && row.expiresAt.getTime() <= Date.now()
        ? "expired"
        : row.state,
    deliveryState:
      row.deliveryState === "sending" &&
      row.deliveryAttemptedAt.getTime() < Date.now() - 30_000
        ? "unconfirmed"
        : row.deliveryState,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function audit(
  tx: Tx,
  row: StaffInvitation,
  actorUserId: string,
  action: string,
) {
  await tx.insert(auditEventsTable).values({
    organizationId: row.organizationId,
    actorUserId,
    action: `staff_invitation.${action}`,
    entityType: "staff_invitation",
    entityId: row.id,
    metadata: {
      role: row.role,
      version: row.version,
      deliveryState: row.deliveryState,
    },
  });
}

async function deliver(
  row: StaffInvitation,
  actor: InvitationActor,
  inviterName: string,
) {
  // The durable sending marker precedes every attempt. A crash or unknown result
  // requires explicit review; repeating create never sends another email.
  const deadline = Date.now() + 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ sent: boolean; error: string | null }>(
    (resolve) => {
      timer = setTimeout(
        () => resolve({ sent: false, error: "unconfirmed" }),
        15_000,
      );
    },
  );
  const attempt = sendInviteEmail({
    invitedUserId: row.pendingUserId,
    invitationId: row.id,
    actorUserId: actor.userId,
    organizationId: row.organizationId,
    to: row.email,
    inviterName,
    role: row.role,
    tokenRevision: row.tokenRevision,
    shouldSend: async () => {
      if (Date.now() >= deadline) return false;
      const [current] = await db
        .select({ id: staffInvitationsTable.id })
        .from(staffInvitationsTable)
        .innerJoin(
          usersTable,
          eq(usersTable.id, staffInvitationsTable.pendingUserId),
        )
        .where(
          and(
            eq(staffInvitationsTable.id, row.id),
            eq(staffInvitationsTable.tokenRevision, row.tokenRevision),
            eq(staffInvitationsTable.state, "pending"),
            eq(usersTable.isActive, true),
          ),
        );
      return Boolean(current) && Date.now() < deadline;
    },
  }).catch(() => ({ sent: false, error: "unconfirmed" }));
  let result;
  try {
    result = await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(staffInvitationsTable)
      .set({
        deliveryState: result.sent ? "sent" : "unconfirmed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(staffInvitationsTable.id, row.id),
          eq(staffInvitationsTable.tokenRevision, row.tokenRevision),
          eq(staffInvitationsTable.state, "pending"),
        ),
      )
      .returning();
    if (updated)
      await audit(
        tx,
        updated,
        actor.userId,
        result.sent ? "email_accepted" : "email_unconfirmed",
      );
  });
  const [current] = await db
    .select()
    .from(staffInvitationsTable)
    .where(
      and(
        eq(staffInvitationsTable.id, row.id),
        eq(staffInvitationsTable.organizationId, row.organizationId),
      ),
    );
  return view(current);
}

export async function listStaffInvitations(
  actor: InvitationActor,
  organizationId: string,
) {
  return db.transaction(async (tx) => {
    await actorFor(tx, actor, organizationId);
    const rows = await tx
      .select()
      .from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.organizationId, organizationId))
      .orderBy(desc(staffInvitationsTable.createdAt))
      .limit(101);
    return {
      organizationId,
      invitations: rows.slice(0, 100).map(view),
      truncated: rows.length > 100,
    };
  });
}

export async function createStaffInvitation(
  actor: InvitationActor,
  organizationId: string,
  input: InvitationInput,
) {
  if (
    process.env.NODE_ENV === "production" &&
    !isPlatformIdentityDeliveryConfigured()
  )
    fail("transactional_email_unavailable", 503);
  const email = input.email.trim().toLowerCase();
  const data = {
    email,
    role: input.role,
    firstName: input.firstName?.trim() || null,
    lastName: input.lastName?.trim() || null,
  };
  const hash = fingerprint(data);
  const prepared = await db.transaction(async (tx) => {
    const user = await actorFor(tx, actor, organizationId, input.role);
    await tx.execute(sql`select set_config('lock_timeout', '3000ms', true)`);
    // Request identity is wider than an email. Serialize differing payloads
    // with the same request ID before taking their mailbox-specific lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`staff-invitation-request:${organizationId}:${input.requestId}`}, 0))`,
    );
    await lockEmail(tx, email);
    const [prior] = await tx
      .select()
      .from(staffInvitationsTable)
      .where(
        and(
          eq(staffInvitationsTable.organizationId, organizationId),
          eq(staffInvitationsTable.requestId, input.requestId),
        ),
      );
    if (prior) {
      if (prior.payloadHash !== hash) fail("invitation_request_changed");
      return { row: prior, duplicate: true, name: "" };
    }
    const [existing] = await tx
      .select()
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = ${email}`)
      .for("update");
    if (existing) {
      if (
        existing.organizationId === organizationId &&
        !existing.id.startsWith("invite:")
      )
        fail("already_a_member");
      // Do not move, reactivate, promote or silently replace another account or invitation.
      fail("email_unavailable");
    }
    const [pending] = await tx
      .insert(usersTable)
      .values({
        ...data,
        organizationId,
        id: `invite:${randomUUID()}`,
        emailVerifiedAt: null,
      })
      .returning();
    const [row] = await tx
      .insert(staffInvitationsTable)
      .values({
        organizationId,
        requestId: input.requestId,
        payloadHash: hash,
        pendingUserId: pending.id,
        email,
        role: input.role,
        expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
        createdByUserId: actor.userId,
      })
      .returning();
    await audit(tx, row, actor.userId, "created");
    return {
      row,
      duplicate: false,
      name:
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        "Your GrowthOS administrator",
    };
  });
  return {
    invitation: prepared.duplicate
      ? view(prepared.row)
      : await deliver(prepared.row, actor, prepared.name),
    duplicate: prepared.duplicate,
  };
}

export async function updateStaffInvitation(
  actor: InvitationActor,
  organizationId: string,
  id: string,
  command: {
    action: "reissue" | "revoke";
    expectedVersion: number;
    confirmed: true;
  },
) {
  const prepared = await db.transaction(async (tx) => {
    const user = await actorFor(tx, actor, organizationId);
    const [found] = await tx
      .select()
      .from(staffInvitationsTable)
      .where(
        and(
          eq(staffInvitationsTable.id, id),
          eq(staffInvitationsTable.organizationId, organizationId),
        ),
      );
    if (!found) fail("invitation_not_found", 404);
    if (
      found.role === "owner" &&
      actor.scope !== "platform" &&
      user.role !== "owner"
    )
      fail("owner_invitation_requires_owner", 403);
    await lockEmail(tx, found.email);
    const [row] = await tx
      .select()
      .from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, id))
      .for("update");
    if (row.version !== command.expectedVersion) fail("invitation_changed");
    if (row.state === "accepted") fail("invitation_already_accepted");
    const [pending] = await tx
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, row.pendingUserId),
          eq(usersTable.organizationId, organizationId),
        ),
      )
      .for("update");
    if (
      !pending ||
      !pending.id.startsWith("invite:") ||
      pending.email !== row.email ||
      pending.role !== row.role
    )
      fail("invitation_member_changed");
    if (command.action === "reissue") {
      // A new token revision is not an escape hatch for an unknown prior send.
      const [uncertain] = await tx.select({ id: platformEmailDispatchesTable.id }).from(platformEmailDispatchesTable).where(and(
        eq(platformEmailDispatchesTable.invitationId, row.id),
        sql`${platformEmailDispatchesTable.outcome} in ('claimed','unknown')`,
      )).limit(1);
      if (uncertain) fail("invitation_delivery_reconciliation_required");
      if (
        process.env.NODE_ENV === "production" &&
        !isPlatformIdentityDeliveryConfigured()
      )
        fail("transactional_email_unavailable", 503);
      if (row.deliveryAttemptedAt.getTime() > Date.now() - 60_000)
        fail("invitation_recently_attempted", 429);
    }
    const now = new Date();
    const [updated] = await tx
      .update(staffInvitationsTable)
      .set(
        command.action === "revoke"
          ? {
              state: "revoked",
              revokedAt: now,
              tokenRevision: randomUUID(),
              version: row.version + 1,
              updatedAt: now,
            }
          : {
              state: "pending",
              revokedAt: null,
              tokenRevision: randomUUID(),
              version: row.version + 1,
              expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
              deliveryState: "sending",
              deliveryAttemptedAt: now,
              updatedAt: now,
            },
      )
      .where(eq(staffInvitationsTable.id, id))
      .returning();
    await tx
      .update(usersTable)
      .set({ isActive: command.action === "reissue", updatedAt: now })
      .where(eq(usersTable.id, pending.id));
    await audit(
      tx,
      updated,
      actor.userId,
      command.action === "revoke" ? "revoked" : "reissued",
    );
    return {
      row: updated,
      name:
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        "Your GrowthOS administrator",
    };
  });
  return command.action === "reissue"
    ? deliver(prepared.row, actor, prepared.name)
    : view(prepared.row);
}

/** Both local signup and trusted OIDC adoption use this atomic acceptance boundary. */
export async function acceptPendingStaffInvitation(input: {
  pendingUserId: string;
  email: string;
  newUserId: string;
  token?: string;
  trustedOidc?: boolean;
  oidcEmailVerified?: boolean;
  passwordHash?: string;
  firstName?: string | null;
  lastName?: string | null;
  profileImageUrl?: string | null;
}) {
  return db.transaction(async (tx) => {
    const email = input.email.trim().toLowerCase();
    await lockEmail(tx, email);
    const [pending] = await tx
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, input.pendingUserId),
          sql`lower(${usersTable.email}) = ${email}`,
        ),
      )
      .for("update");
    if (
      !pending?.isActive ||
      !pending.id.startsWith("invite:") ||
      !pending.organizationId
    )
      fail("invitation_inactive", 403);
    const organizationId = pending.organizationId!;
    const [existingIdentity] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, input.newUserId))
      .for("share");
    if (existingIdentity) fail("invitation_identity_already_exists", 403);
    const [invitation] = await tx
      .select()
      .from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.pendingUserId, pending.id))
      .for("update");
    if (
      invitation &&
      (invitation.state !== "pending" ||
        invitation.expiresAt.getTime() <= Date.now() ||
        invitation.organizationId !== pending.organizationId ||
        invitation.email !== email ||
        invitation.role !== pending.role)
    )
      fail("invitation_inactive", 403);
    if (input.trustedOidc && input.oidcEmailVerified !== true)
      fail("invitation_mailbox_unverified", 403);
    if (
      !input.trustedOidc &&
      (!input.token ||
        !verifyInviteToken(input.token, {
          inviteId: pending.id,
          organizationId,
          email,
          ...(invitation ? { tokenRevision: invitation.tokenRevision } : {}),
        }))
    )
      fail("invitation_invalid_or_expired", 403);
    const [adopted] = await tx
      .update(usersTable)
      .set({
        id: input.newUserId,
        ...(input.passwordHash ? { passwordHash: input.passwordHash } : {}),
        firstName: input.firstName ?? pending.firstName,
        lastName: input.lastName ?? pending.lastName,
        ...(input.profileImageUrl !== undefined
          ? { profileImageUrl: input.profileImageUrl }
          : {}),
        emailVerifiedAt: new Date(),
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, pending.id))
      .returning();
    if (invitation) {
      const [accepted] = await tx
        .update(staffInvitationsTable)
        .set({
          state: "accepted",
          acceptedUserId: adopted.id,
          acceptedAt: new Date(),
          version: invitation.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(staffInvitationsTable.id, invitation.id))
        .returning();
      await audit(tx, accepted, adopted.id, "accepted");
    } else {
      await tx.insert(auditEventsTable).values({
        organizationId,
        actorUserId: adopted.id,
        action: "user.invitation_accepted",
        entityType: "user",
        entityId: adopted.id,
        metadata: {
          method: input.trustedOidc ? "oidc" : "signed_invitation",
        },
      });
    }
    return adopted;
  });
}
