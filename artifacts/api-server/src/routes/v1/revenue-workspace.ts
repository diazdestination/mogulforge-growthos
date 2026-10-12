import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod/v4";
import {
  db,
  revenueExecutionsTable,
  revenueExecutionEventsTable,
  bieActionProposalsTable,
  leadsTable,
  auditEventsTable,
  organizationsTable,
  crmTasksTable,
} from "@workspace/db";
import { and, desc, eq, isNull, inArray } from "drizzle-orm";
import { requireMember } from "../../middlewares/requireMember";
import { parseReportingPeriod } from "../../services/reporting-period";
import { canReadInvoiceProposals } from "../../services/specialists/invo";
import { requirePlatformAdmin } from "./orgs";
import { rateLimit } from "../../lib/rateLimit";
import { getSchedulerHealth } from "../../services/scheduler-runtime";
import {
  getPortalSession,
  requestLoginCode,
  verifyLoginCode,
} from "../../services/portal";
import {
  expireInterruptedActions,
  reconcileExecution,
} from "../../services/durable-execution";
import {
  revenueDesk,
  getOperatingProfile,
  saveOperatingProfile,
  decisionRoom,
  saveDecisionRoom,
  portalDecisionRoom,
  valueLedger,
  recordValueEntry,
  leadEvidence,
  projectGrowth,
  saveProjectStory,
  approveProjectStory,
  clientOperations,
  RevenueError,
} from "../../services/revenue-workspace";

const router = Router();
const id = (req: Request) => z.uuid().parse(req.params.id);
const safe =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: "Invalid request. Check required fields and confirmation.",
        });
        return;
      }
      if (error instanceof RevenueError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      next(error);
    }
  };
router.get(
  "/platform/runtime",
  requirePlatformAdmin,
  safe(async (_req, res) => res.json(await getSchedulerHealth())),
);
router.get(
  "/revenue/desk",
  requireMember("crm.read"),
  safe(async (req, res) =>
    res.json(await revenueDesk(req.member!.organizationId, { includeInvoiceProposals: canReadInvoiceProposals(req.member!.user.role, req.member!.role) })),
  ),
);
router.post(
  "/revenue/leads/:id/claim",
  requireMember("crm.write"),
  safe(async (req, res) => {
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    const org = req.member!.organizationId;
    const leadId = id(req);
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(leadsTable)
        .set({ assignedUserId: req.member!.user.id })
        .where(
          and(
            eq(leadsTable.id, leadId),
            eq(leadsTable.organizationId, org),
            isNull(leadsTable.assignedUserId),
          ),
        )
        .returning({ id: leadsTable.id });
      if (!row)
        throw new RevenueError(
          "The lead is unavailable or already has an owner. Refresh before reassignment.",
          409,
        );
      await tx
        .update(crmTasksTable)
        .set({ assignedUserId: req.member!.user.id })
        .where(
          and(
            eq(crmTasksTable.organizationId, org),
            eq(crmTasksTable.leadId, leadId),
            eq(crmTasksTable.sourceEvent, "smart_site.lead_saved"),
            inArray(crmTasksTable.status, ["open", "in_progress"]),
          ),
        );
      await tx.insert(auditEventsTable).values({
        organizationId: org,
        actorUserId: req.member!.user.id,
        action: "revenue.inquiry_claimed",
        entityType: "lead",
        entityId: leadId,
      });
      return row;
    });
    res.json(result);
  }),
);
router.get(
  "/revenue/profile",
  requireMember("crm.read"),
  safe(async (req, res) =>
    res.json(await getOperatingProfile(req.member!.organizationId)),
  ),
);
router.post(
  "/revenue/profile",
  requireMember("settings.manage"),
  safe(async (req, res) =>
    res
      .status(201)
      .json(
        await saveOperatingProfile(
          req.member!.organizationId,
          req.member!.user.id,
          req.body,
        ),
      ),
  ),
);
router.get(
  "/revenue/rooms/:id",
  requireMember("crm.read"),
  safe(async (req, res) =>
    res.json(await decisionRoom(req.member!.organizationId, id(req))),
  ),
);
router.post(
  "/revenue/rooms/:id",
  requireMember("settings.manage"),
  safe(async (req, res) =>
    res
      .status(201)
      .json(
        await saveDecisionRoom(
          req.member!.organizationId,
          id(req),
          req.member!.user.id,
          req.body,
        ),
      ),
  ),
);
router.get(
  "/revenue/value",
  requireMember("crm.read"),
  safe(async (req, res) =>
    res.json(await valueLedger(req.member!.organizationId, parseReportingPeriod(req.query))),
  ),
);
router.post(
  "/revenue/value",
  requireMember("settings.manage"),
  safe(async (req, res) =>
    res
      .status(201)
      .json(
        await recordValueEntry(
          req.member!.organizationId,
          req.member!.user.id,
          req.body,
        ),
      ),
  ),
);
router.get(
  "/revenue/evidence/:id",
  requireMember("crm.read"),
  safe(async (req, res) =>
    res.json(await leadEvidence(req.member!.organizationId, id(req))),
  ),
);
router.get(
  "/revenue/growth",
  requireMember("crm.read"),
  safe(async (req, res) =>
    res.json(await projectGrowth(req.member!.organizationId)),
  ),
);
router.post(
  "/revenue/growth",
  requireMember("crm.write"),
  safe(async (req, res) =>
    res
      .status(201)
      .json(
        await saveProjectStory(
          req.member!.organizationId,
          req.member!.user.id,
          req.body,
        ),
      ),
  ),
);
router.post(
  "/revenue/growth/:id/approve",
  requireMember("settings.manage"),
  safe(async (req, res) => {
    z.object({ confirmedContentPermission: z.literal(true) })
      .strict()
      .parse(req.body);
    res.json(
      await approveProjectStory(
        req.member!.organizationId,
        id(req),
        req.member!.user.id,
      ),
    );
  }),
);
router.get(
  "/revenue/executions/:id",
  requireMember("crm.read"),
  safe(async (req, res) => {
    const org = req.member!.organizationId;
    const [execution] = await db
      .select()
      .from(revenueExecutionsTable)
      .where(
        and(
          eq(revenueExecutionsTable.id, id(req)),
          eq(revenueExecutionsTable.organizationId, org),
        ),
      );
    if (!execution) throw new RevenueError("Execution not found.", 404);
    const events = await db
      .select()
      .from(revenueExecutionEventsTable)
      .where(
        and(
          eq(revenueExecutionEventsTable.organizationId, org),
          eq(revenueExecutionEventsTable.executionId, execution.id),
        ),
      )
      .orderBy(desc(revenueExecutionEventsTable.createdAt));
    res.json({ execution, events });
  }),
);
router.post(
  "/revenue/executions/:id/reconcile",
  requireMember("settings.manage"),
  safe(async (req, res) => {
    const input = z
      .object({
        outcome: z.enum(["confirmed_succeeded", "confirmed_not_performed"]),
        evidence: z.string().trim().min(20).max(900),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const org = req.member!.organizationId;
    await expireInterruptedActions(org);
    const result = await reconcileExecution(
      org,
      id(req),
      req.member!.user.id,
      input.outcome,
      input.evidence,
    );
    if (!result)
      throw new RevenueError(
        "Only an indeterminate execution can be reconciled. Refresh its state.",
        409,
      );
    res.json(result);
  }),
);
router.patch(
  "/revenue/proposals/:id",
  requireMember("crm.write"),
  safe(async (req, res) => {
    const input = z
      .object({
        subject: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(5000),
      })
      .strict()
      .parse(req.body);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bieActionProposalsTable)
        // Replacing (not merging) clears any frozen email/mailbox review.
        // The edited draft must be explicitly prepared and reviewed again.
        .set({ payload: input })
        .where(
          and(
            eq(bieActionProposalsTable.id, id(req)),
            eq(
              bieActionProposalsTable.organizationId,
              req.member!.organizationId,
            ),
            eq(bieActionProposalsTable.status, "proposed"),
            eq(bieActionProposalsTable.actionType, "send_email"),
          ),
        )
        .returning();
      if (!updated)
        throw new RevenueError(
          "Only an email awaiting review can be edited.",
          409,
        );
      await tx.insert(auditEventsTable).values({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: "revenue.proposal_edited",
        entityType: "bie_action_proposal",
        entityId: updated.id,
      });
      return updated;
    });
    res.json(row);
  }),
);
router.get(
  "/platform/clients/health",
  requirePlatformAdmin,
  safe(async (_req, res) => res.json(await clientOperations())),
);
for (const step of ["request", "verify"] as const) {
  router.post(
    `/portal/workspaces/:slug/login/${step}`,
    rateLimit({
      windowMs: 60_000,
      max: step === "request" ? 5 : 10,
      key: `project-room-login-${step}`,
    }),
    safe(async (req, res) => {
      const slug = z
        .string()
        .min(2)
        .max(80)
        .regex(/^[a-z0-9-]+$/)
        .parse(req.params.slug);
      const input = (
        step === "request"
          ? z.object({ identifier: z.string().trim().min(3).max(200) }).strict()
          : z
              .object({
                identifier: z.string().trim().min(3).max(200),
                code: z.string().regex(/^\d{6}$/),
              })
              .strict()
      ).parse(req.body);
      const [org] = await db
        .select({ id: organizationsTable.id })
        .from(organizationsTable)
        .where(eq(organizationsTable.slug, slug));
      if (step === "request") {
        if (org)
          await requestLoginCode({
            organizationId: org.id,
            rawIdentifier: input.identifier,
          });
        res.status(202).json({
          accepted: true,
          message:
            "If the project and approved delivery channel are available, a sign-in code will be sent.",
        });
        return;
      }
      const session =
        org && "code" in input
          ? await verifyLoginCode({
              organizationId: org.id,
              rawIdentifier: input.identifier,
              code: String(input.code),
            })
          : null;
      if (!session) {
        res.status(401).json({ error: "That code is incorrect or expired." });
        return;
      }
      res.json({
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      });
    }),
  );
}
router.get(
  "/portal/projects/:id/decision-room",
  rateLimit({ windowMs: 60_000, max: 60, key: "portal-decision-room" }),
  safe(async (req, res) => {
    const session = await getPortalSession(
      String(req.headers["x-portal-token"] ?? ""),
    );
    if (!session) {
      res.status(401).json({ error: "Please sign in again." });
      return;
    }
    const room = await portalDecisionRoom(session, id(req));
    if (!room) throw new RevenueError("Project not found.", 404);
    res.json(room);
  }),
);
export default router;
