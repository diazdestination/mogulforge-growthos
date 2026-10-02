import { InviteUserBody, UpdateUserBody } from "@workspace/api-zod";
import {
  db,
  organizationsTable,
  staffInvitationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { consumeCooldown } from "../../lib/rateLimit";
import { hasPermission } from "../../lib/permissions";
import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import { listMembers } from "../../services/crm";
import { sendInviteEmail } from "../../services/invite-email";
import { isTransactionalEmailConfigured } from "../../services/providers";
import {
  createStaffInvitation,
  updateStaffInvitation,
  StaffInvitationError,
} from "../../services/staff-invitations";

const router: IRouter = Router();

function invitationOriginAllowed(req: Request, res: Response) {
  if (req.headers.origin && req.headers.origin !== process.env.APP_ORIGIN) {
    res.status(403).json({ error: "Origin is not allowed" });
    return false;
  }
  return true;
}
function invitationFailure(res: Response, error: unknown) {
  if (!(error instanceof StaffInvitationError)) throw error;
  const messages: Record<string, string> = {
    email_unavailable:
      "An account or invitation already uses this email. Review its existing workspace; membership was not changed.",
    already_a_member: "This person is already a member of this workspace.",
    invitation_recently_attempted:
      "Invitation was recently attempted. Wait a minute, then review its delivery before retrying.",
  };
  res
    .status(error.status)
    .json({
      error:
        messages[error.code] ??
        "The invitation changed or cannot be managed. Refresh and review its current status.",
      code: error.code,
    });
}

const UpdateMyProfileBody = z
  .object({
    firstName: z.string().trim().max(100).nullable().optional(),
    lastName: z.string().trim().max(100).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.firstName !== undefined || value.lastName !== undefined,
    { message: "At least one profile field is required" },
  );

function memberDto(u: {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  isActive: boolean;
}) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role,
    isActive: u.isActive,
  };
}

router.get(
  "/me",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const { user, organizationId } = req.member!;
    const [organization] = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));
    res.json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isActive: user.isActive,
      organization: organization
        ? {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            timezone: organization.timezone,
          }
        : null,
    });
  },
);

router.patch(
  "/me",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateMyProfileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid profile" });
      return;
    }

    const actor = req.member!;
    const changedFields = [
      ...(parsed.data.firstName !== undefined ? ["firstName"] : []),
      ...(parsed.data.lastName !== undefined ? ["lastName"] : []),
    ];
    const [updated] = await db
      .update(usersTable)
      .set({
        ...(parsed.data.firstName !== undefined
          ? { firstName: parsed.data.firstName || null }
          : {}),
        ...(parsed.data.lastName !== undefined
          ? { lastName: parsed.data.lastName || null }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(usersTable.id, actor.user.id),
          eq(usersTable.organizationId, actor.organizationId),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    await recordAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.user.id,
      action: "user.profile_updated",
      entityType: "user",
      metadata: { targetUserId: actor.user.id, changedFields },
    });
    res.json(memberDto(updated));
  },
);

router.get(
  "/users",
  requireMember("users.read"),
  async (req: Request, res: Response): Promise<void> => {
    const members = await listMembers(req.member!.organizationId);
    res.json(
      members.map((m) => ({
        id: m.id,
        email: m.email,
        firstName: m.firstName,
        lastName: m.lastName,
        role: m.role,
        isActive: m.isActive,
        operationallyEligible: m.isActive && !m.id.startsWith("invite:") && m.emailVerifiedAt !== null && hasPermission(m.role, "crm.write"),
      })),
    );
  },
);

router.post(
  "/users/invite",
  requireMember("users.manage"),
  async (req: Request, res: Response): Promise<void> => {
    if (!invitationOriginAllowed(req, res)) return;
    if (
      process.env.NODE_ENV === "production" &&
      !isTransactionalEmailConfigured()
    ) {
      res.status(503).json({
        error:
          "Team invitations are temporarily unavailable because MogulForge transactional email is not configured.",
        code: "TRANSACTIONAL_EMAIL_NOT_CONFIGURED",
      });
      return;
    }
    const parsed = InviteUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid invite" });
      return;
    }
    const { email, role, firstName, lastName } = parsed.data;
    if (role === "owner" && req.member!.role !== "owner") {
      res
        .status(403)
        .json({ error: "Only the owner can grant the owner role" });
      return;
    }
    const suppliedRequestId = req.header("Idempotency-Key");
    if (
      suppliedRequestId &&
      !z.string().uuid().safeParse(suppliedRequestId).success
    ) {
      res.status(400).json({ error: "Invalid invitation request identity" });
      return;
    }
    try {
      const result = await createStaffInvitation(
        { userId: req.member!.user.id, scope: "member" },
        req.member!.organizationId,
        {
          requestId: suppliedRequestId ?? crypto.randomUUID(),
          email,
          role,
          firstName: firstName ?? undefined,
          lastName: lastName ?? undefined,
        },
      );
      const [user] = await db
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.email, email.trim().toLowerCase()),
            eq(usersTable.organizationId, req.member!.organizationId),
          ),
        );
      if (!user) {
        res
          .status(409)
          .json({ error: "Membership changed; refresh the team list" });
        return;
      }
      const sent = result.invitation.deliveryState === "sent";
      res
        .status(result.duplicate ? 200 : 201)
        .json({
          ...memberDto(user),
          inviteEmail: {
            sent,
            error: sent
              ? null
              : "Invitation delivery is unconfirmed. Review provider evidence before sending again.",
          },
        });
    } catch (error) {
      invitationFailure(res, error);
    }
  },
);

router.post(
  "/users/:id/resend-invite",
  requireMember("users.manage"),
  async (req: Request, res: Response): Promise<void> => {
    if (!invitationOriginAllowed(req, res)) return;
    if (
      process.env.NODE_ENV === "production" &&
      !isTransactionalEmailConfigured()
    ) {
      res.status(503).json({
        error:
          "Team invitations are temporarily unavailable because MogulForge transactional email is not configured.",
        code: "TRANSACTIONAL_EMAIL_NOT_CONFIGURED",
      });
      return;
    }
    const actor = req.member!;
    const [target] = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, String(req.params.id)),
          eq(usersTable.organizationId, actor.organizationId),
        ),
      );
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (!target.id.startsWith("invite:")) {
      res.status(400).json({ error: "This member is not a pending invite" });
      return;
    }
    if (!target.email) {
      res.status(400).json({ error: "Pending invite has no email address" });
      return;
    }
    const [tracked] = await db
      .select()
      .from(staffInvitationsTable)
      .where(
        and(
          eq(staffInvitationsTable.pendingUserId, target.id),
          eq(staffInvitationsTable.organizationId, actor.organizationId),
        ),
      );
    if (tracked) {
      try {
        const result = await updateStaffInvitation(
          { userId: actor.user.id, scope: "member" },
          actor.organizationId,
          tracked.id,
          {
            action: "reissue",
            expectedVersion: tracked.version,
            confirmed: true,
          },
        );
        const sent = result.deliveryState === "sent";
        res.json({
          sent,
          error: sent
            ? null
            : "Invitation delivery is unconfirmed. Review provider evidence before sending again.",
        });
      } catch (error) {
        invitationFailure(res, error);
      }
      return;
    }
    if (!target.isActive) {
      res
        .status(409)
        .json({
          error:
            "This legacy invitation was revoked. Review access before issuing a new invitation.",
        });
      return;
    }
    // Cooldown: one resend per invite per minute, shared across instances,
    // so a stuck button or rapid clicks can't spam the invitee.
    const cooldown = await consumeCooldown({
      key: `invite-resend:${actor.organizationId}:${target.id}`,
      windowMs: 60_000,
    });
    if (!cooldown.allowed) {
      res
        .status(429)
        .setHeader(
          "Retry-After",
          String(Math.ceil(cooldown.retryAfterMs / 1000)),
        )
        .json({
          error:
            "Invite was just resent. Please wait a minute before trying again.",
        });
      return;
    }
    const inviterName =
      [actor.user.firstName, actor.user.lastName].filter(Boolean).join(" ") ||
      actor.user.email ||
      "A teammate";
    const result = await sendInviteEmail({
      invitedUserId: target.id,
      organizationId: actor.organizationId,
      to: target.email,
      inviteeFirstName: target.firstName,
      inviterName,
      role: target.role,
    });
    await recordAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.user.id,
      action: "user.invite_resent",
      entityType: "user",
      metadata: {
        invitedUserId: target.id,
        email: target.email,
        inviteEmailSent: result.sent,
        ...(result.error ? { inviteEmailError: result.error } : {}),
      },
    });
    res.json(result);
  },
);

router.patch(
  "/users/:id",
  requireMember("users.manage"),
  async (req: Request, res: Response): Promise<void> => {
    if (!invitationOriginAllowed(req, res)) return;
    const parsed = UpdateUserBody.safeParse(req.body);
    if (
      !parsed.success ||
      (parsed.data.role === undefined && parsed.data.isActive === undefined)
    ) {
      res.status(400).json({ error: "Invalid change" });
      return;
    }
    const actor = req.member!;
    if (String(req.params.id) === actor.user.id) {
      res
        .status(403)
        .json({ error: "You cannot change your own role or status" });
      return;
    }
    const [target] = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, String(req.params.id)),
          eq(usersTable.organizationId, actor.organizationId),
        ),
      );
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (
      (target.role === "owner" || parsed.data.role === "owner") &&
      actor.role !== "owner"
    ) {
      res
        .status(403)
        .json({ error: "Only the owner can change owner membership" });
      return;
    }
    if (target.id.startsWith("invite:")) {
      const [tracked] = await db
        .select()
        .from(staffInvitationsTable)
        .where(
          and(
            eq(staffInvitationsTable.pendingUserId, target.id),
            eq(staffInvitationsTable.organizationId, actor.organizationId),
          ),
        );
      if (tracked) {
        if (parsed.data.role !== undefined || parsed.data.isActive !== false) {
          res
            .status(409)
            .json({
              error:
                "Accept the invitation before changing its role. Use resend to explicitly reissue a revoked invitation.",
            });
          return;
        }
        try {
          await updateStaffInvitation(
            { userId: actor.user.id, scope: "member" },
            actor.organizationId,
            tracked.id,
            {
              action: "revoke",
              expectedVersion: tracked.version,
              confirmed: true,
            },
          );
          res.json(memberDto({ ...target, isActive: false }));
        } catch (error) {
          invitationFailure(res, error);
        }
        return;
      }
    }
    const [updated] = await db
      .update(usersTable)
      .set({
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
      })
      .where(eq(usersTable.id, target.id))
      .returning();
    if (!updated) {
      res
        .status(409)
        .json({ error: "Membership changed. Refresh before trying again." });
      return;
    }
    await recordAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.user.id,
      action: "user.updated",
      entityType: "user",
      metadata: {
        targetUserId: target.id,
        ...(parsed.data.role !== undefined
          ? { roleFrom: target.role, roleTo: parsed.data.role }
          : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
      },
    });
    res.json(memberDto(updated));
  },
);

export default router;
