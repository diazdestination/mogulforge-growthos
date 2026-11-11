import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { FieldCollectError } from "../../services/field-collect";
import { requireMember } from "../../middlewares/requireMember";
import { ZAPIER_EXECUTION_STATES, type ZapierExecutionState } from "@workspace/db";
import {
  bindZapierCapability,
  disconnectZapier,
  enableZapierAction,
  getZapierStatus,
  listZapierCapabilities,
  listZapierEnabledActions,
  registerZapierServerUrl,
  searchZapierActions,
  setZapierPolicy,
  setZapierPollInterval,
  unbindZapierCapability,
  ZapierBindingError,
} from "../../services/zapier/zapier-connection";
import {
  approveZapierAction,
  getZapierExecution,
  listZapierExecutions,
  rejectZapierAction,
  ZapierExecutionError,
} from "../../services/zapier/zapier-executions";
import { ZapierMcpError } from "../../services/zapier/zapier-mcp-client";
import { CallieTextBackSettingsError, describeCallieTextBackSettings, saveCallieTextBackSettings } from "../../services/callie-text-back";
import {
  apptPushAppointmentToCalendar,
  apptRequestOnMyWayText,
  apptRequestReminderText,
  billRequestPayLinkText,
  callieRequestTextBack,
  callieSyncCalls,
  estiRequestApprovalLinkText,
  invoPushInvoiceToAccounting,
  maintainRequestServiceText,
  schedSendCrewDaySheet,
  scoutSyncMarketplaceLeads,
  scoutSyncReviews,
} from "../../services/zapier/zapier-specialist-flows";
import {
  estiRequestMailboxEstimateEmail,
  invoRequestAccountingPayment,
  invoRequestMailboxInvoiceEmail,
  scoutRequestReviewText,
  scoutSyncInboxReplies,
  callieSyncSmsReplies,
} from "../../services/zapier/zapier-owned-app-flows";

/**
 * Zapier Connected Apps. Mirrors the Gmail/Microsoft integration surface:
 * connection management needs a signed-in human (never an API key), binding
 * and policy changes need settings authority, and specialist flows need the
 * same permission the underlying GrowthOS record needs.
 */

const router: IRouter = Router();

const sessionOnly: RequestHandler = (req, res, next) => {
  if (req.get("x-api-key") || !req.user || req.user.id !== req.member?.user.id) {
    res.status(403).json({ error: "Sign in with your own account to manage Zapier Connected Apps." });
    return;
  }
  next();
};

function fail(res: Response, error: unknown): void {
  if (error instanceof ZapierMcpError) {
    const status =
      error.code === "not_configured" ? 503 : error.code === "invalid_server_url" ? 400 : error.code === "unauthorized" ? 409 : 502;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ZapierBindingError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof FieldCollectError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ZapierExecutionError) {
    const status = error.code === "not_found" ? 404 : error.code === "conflict" || error.code === "not_pending" ? 409 : 400;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request", issues: error.issues.slice(0, 5) });
    return;
  }
  res.status(500).json({ error: "Zapier Connected Apps request failed." });
}

const serverUrlBody = z.object({ serverUrl: z.string().min(1).max(2000) });
const enableBody = z.object({ selectedApi: z.string().min(1).max(120), action: z.string().min(1).max(120) });
const bindingBody = z.object({
  app: z.string().min(1).max(120),
  action: z.string().min(1).max(120),
  zapierConnectionId: z.string().max(120).optional().nullable(),
  config: z.record(z.string(), z.unknown()).optional(),
});
const policyBody = z.object({ mode: z.enum(["off", "approve", "auto"]), dailyBudget: z.number().int().min(0).max(500).optional() });
const recordId = z.string().uuid();
const pollIntervalBody = z.object({ minutes: z.number().int() });
const rejectBody = z.object({ reason: z.string().max(500).optional() });
const daySheetBody = z.object({ userId: z.string().min(1).max(120), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
// The caller number comes only from the recorded missed call, never from the request.
const textBackBody = z.object({ taskId: z.string().uuid() });
const textBackSettingsBody = z.object({ messagingRegistered: z.boolean(), windowHours: z.number().int().min(1).max(168).optional() });

// ---------- connection ----------

router.get("/integrations/zapier", requireMember("crm.read"), async (req: Request, res: Response): Promise<void> => {
  res.json(await getZapierStatus(req.member!.organizationId));
});

router.post(
  "/integrations/zapier/server-url",
  requireMember("settings.manage"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = serverUrlBody.parse(req.body);
      res.json(
        await registerZapierServerUrl({
          organizationId: req.member!.organizationId,
          userId: req.member!.user.id,
          serverUrl: body.serverUrl,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

router.delete(
  "/integrations/zapier",
  requireMember("settings.manage"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    res.json({ disconnected: await disconnectZapier(req.member!.organizationId, req.member!.user.id) });
  },
);

router.put(
  "/integrations/zapier/poll-interval",
  requireMember("settings.manage"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = pollIntervalBody.parse(req.body);
      res.json(await setZapierPollInterval({ organizationId: req.member!.organizationId, userId: req.member!.user.id, minutes: body.minutes }));
    } catch (error) {
      fail(res, error);
    }
  },
);

// ---------- live actions on the contractor's server ----------

router.get("/integrations/zapier/actions", requireMember("settings.manage"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json({ actions: await listZapierEnabledActions(req.member!.organizationId) });
  } catch (error) {
    fail(res, error);
  }
});

router.get("/integrations/zapier/actions/search", requireMember("settings.manage"), async (req: Request, res: Response): Promise<void> => {
  const app = typeof req.query.app === "string" ? req.query.app : "";
  if (!app.trim()) {
    res.status(400).json({ error: "Provide an app name to search." });
    return;
  }
  try {
    res.json({ results: await searchZapierActions(req.member!.organizationId, app) });
  } catch (error) {
    fail(res, error);
  }
});

router.post(
  "/integrations/zapier/actions/enable",
  requireMember("settings.manage"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = enableBody.parse(req.body);
      res.json({
        result: await enableZapierAction({
          organizationId: req.member!.organizationId,
          userId: req.member!.user.id,
          selectedApi: body.selectedApi,
          action: body.action,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  },
);

// ---------- capabilities, bindings, policies ----------

router.get("/integrations/zapier/capabilities", requireMember("crm.read"), async (req: Request, res: Response): Promise<void> => {
  res.json({ capabilities: await listZapierCapabilities(req.member!.organizationId) });
});

router.put(
  "/integrations/zapier/capabilities/:capability/binding",
  requireMember("settings.manage"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = bindingBody.parse(req.body);
      const binding = await bindZapierCapability({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        capability: String(req.params.capability),
        app: body.app,
        action: body.action,
        zapierConnectionId: body.zapierConnectionId ?? null,
        config: body.config,
      });
      res.json({ binding: { id: binding.id, capability: binding.capability, app: binding.zapierApp, action: binding.zapierAction } });
    } catch (error) {
      fail(res, error);
    }
  },
);

router.delete(
  "/integrations/zapier/capabilities/:capability/binding",
  requireMember("settings.manage"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    res.json({ unbound: await unbindZapierCapability(req.member!.organizationId, req.member!.user.id, String(req.params.capability)) });
  },
);

router.put(
  "/integrations/zapier/capabilities/:capability/policy",
  requireMember("settings.manage"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = policyBody.parse(req.body);
      const policy = await setZapierPolicy({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        capability: String(req.params.capability),
        mode: body.mode,
        dailyBudget: body.dailyBudget,
      });
      res.json({ policy: { capability: policy.capability, mode: policy.mode, dailyBudget: policy.dailyBudget } });
    } catch (error) {
      fail(res, error);
    }
  },
);

router.put(
  "/integrations/zapier/callie/text-back-settings",
  requireMember("settings.manage"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = textBackSettingsBody.parse(req.body);
      const saved = await saveCallieTextBackSettings({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        messagingRegistered: body.messagingRegistered,
        windowHours: body.windowHours,
      });
      res.json({ textBack: await describeCallieTextBackSettings(req.member!.organizationId, saved) });
    } catch (error) {
      if (error instanceof CallieTextBackSettingsError) {
        res.status(400).json({ error: error.message });
        return;
      }
      fail(res, error);
    }
  },
);

// ---------- execution ledger ----------

router.get("/integrations/zapier/executions", requireMember("crm.read"), async (req: Request, res: Response): Promise<void> => {
  const state = typeof req.query.state === "string" && ZAPIER_EXECUTION_STATES.includes(req.query.state as ZapierExecutionState)
    ? (req.query.state as ZapierExecutionState)
    : undefined;
  const capability = typeof req.query.capability === "string" ? req.query.capability : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  res.json({ executions: await listZapierExecutions(req.member!.organizationId, { state, capability, limit: Number.isFinite(limit) ? limit : undefined }) });
});

router.get("/integrations/zapier/executions/:id", requireMember("crm.read"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json({ execution: await getZapierExecution(req.member!.organizationId, String(req.params.id)) });
  } catch (error) {
    fail(res, error);
  }
});

router.post(
  "/integrations/zapier/executions/:id/approve",
  requireMember("crm.write"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json({
        execution: await approveZapierAction({
          organizationId: req.member!.organizationId,
          executionId: String(req.params.id),
          userId: req.member!.user.id,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post(
  "/integrations/zapier/executions/:id/reject",
  requireMember("crm.write"),
  sessionOnly,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = rejectBody.parse(req.body ?? {});
      res.json({
        execution: await rejectZapierAction({
          organizationId: req.member!.organizationId,
          executionId: String(req.params.id),
          userId: req.member!.user.id,
          reason: body.reason,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  },
);

// ---------- specialist flows ----------

router.post("/integrations/zapier/flows/scout/leads", requireMember("crm.write"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await scoutSyncMarketplaceLeads({ organizationId: req.member!.organizationId, actorUserId: req.member!.user.id }));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/integrations/zapier/flows/scout/reviews", requireMember("crm.write"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await scoutSyncReviews({ organizationId: req.member!.organizationId, actorUserId: req.member!.user.id }));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/integrations/zapier/flows/callie/calls", requireMember("crm.write"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await callieSyncCalls({ organizationId: req.member!.organizationId, actorUserId: req.member!.user.id }));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/integrations/zapier/flows/callie/text-back", requireMember("crm.write"), async (req: Request, res: Response): Promise<void> => {
  try {
    const body = textBackBody.parse(req.body);
    res.json(
      await callieRequestTextBack({
        organizationId: req.member!.organizationId,
        taskId: body.taskId,
        actorUserId: req.member!.user.id,
      }),
    );
  } catch (error) {
    fail(res, error);
  }
});

router.post(
  "/integrations/zapier/flows/appointments/:id/calendar",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(
        await apptPushAppointmentToCalendar({
          organizationId: req.member!.organizationId,
          appointmentId: String(req.params.id),
          actorUserId: req.member!.user.id,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post(
  "/integrations/zapier/flows/appointments/:id/reminder-text",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(
        await apptRequestReminderText({
          organizationId: req.member!.organizationId,
          appointmentId: String(req.params.id),
          actorUserId: req.member!.user.id,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

const onMyWayBody = z.object({ etaMinutes: z.number().int().min(1).max(240).nullable().optional() }).strict();

router.post(
  "/integrations/zapier/flows/appointments/:id/on-my-way",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = onMyWayBody.parse(req.body ?? {});
      res.json(
        await apptRequestOnMyWayText({
          organizationId: req.member!.organizationId,
          appointmentId: z.string().uuid().parse(String(req.params.id)),
          actorUserId: req.member!.user.id,
          etaMinutes: body.etaMinutes ?? null,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post(
  "/integrations/zapier/flows/invoices/:id/pay-link-text",
  requireMember("invoices.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(
        await billRequestPayLinkText({
          organizationId: req.member!.organizationId,
          invoiceId: z.string().uuid().parse(String(req.params.id)),
          actorUserId: req.member!.user.id,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

// Field collection: a tech texts the pay link for an invoice linked to their own assigned job.
router.post(
  "/integrations/zapier/flows/appointments/:appointmentId/invoices/:id/pay-link-text",
  requireMember("payments.collect"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      z.object({}).strict().parse(req.body ?? {});
      res.json(
        await billRequestPayLinkText({
          organizationId: req.member!.organizationId,
          invoiceId: z.string().uuid().parse(String(req.params.id)),
          actorUserId: req.member!.user.id,
          field: { appointmentId: z.string().uuid().parse(String(req.params.appointmentId)), effectiveRole: req.member!.role },
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post(
  "/integrations/zapier/flows/services/:id/reminder-text",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(
        await maintainRequestServiceText({
          organizationId: req.member!.organizationId,
          obligationId: String(req.params.id),
          actorUserId: req.member!.user.id,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post(
  "/integrations/zapier/flows/estimates/:id/approval-text",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(
        await estiRequestApprovalLinkText({
          organizationId: req.member!.organizationId,
          estimateId: String(req.params.id),
          actorUserId: req.member!.user.id,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post(
  "/integrations/zapier/flows/invoices/:id/accounting",
  requireMember("invoices.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(
        await invoPushInvoiceToAccounting({
          organizationId: req.member!.organizationId,
          invoiceId: String(req.params.id),
          actorUserId: req.member!.user.id,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post("/integrations/zapier/flows/sched/day-sheet", requireMember("crm.write"), async (req: Request, res: Response): Promise<void> => {
  try {
    const body = daySheetBody.parse(req.body);
    res.json(
      await schedSendCrewDaySheet({
        organizationId: req.member!.organizationId,
        userId: body.userId,
        date: body.date,
        actorUserId: req.member!.user.id,
      }),
    );
  } catch (error) {
    fail(res, error);
  }
});

router.post("/integrations/zapier/flows/scout/inbox", requireMember("crm.write"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await scoutSyncInboxReplies({ organizationId: req.member!.organizationId, actorUserId: req.member!.user.id }));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/integrations/zapier/flows/callie/sms-replies", requireMember("crm.write"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await callieSyncSmsReplies({ organizationId: req.member!.organizationId, actorUserId: req.member!.user.id }));
  } catch (error) {
    fail(res, error);
  }
});

router.post(
  "/integrations/zapier/flows/invoices/:id/email",
  requireMember("invoices.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await invoRequestMailboxInvoiceEmail({ organizationId: req.member!.organizationId, invoiceId: recordId.parse(req.params.id), actorUserId: req.member!.user.id }));
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post(
  "/integrations/zapier/flows/invoices/:id/receipts/:allocationId/accounting",
  requireMember("invoices.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await invoRequestAccountingPayment({ organizationId: req.member!.organizationId, invoiceId: recordId.parse(req.params.id), allocationId: recordId.parse(req.params.allocationId), actorUserId: req.member!.user.id }));
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post(
  "/integrations/zapier/flows/estimates/:id/email",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await estiRequestMailboxEstimateEmail({ organizationId: req.member!.organizationId, estimateId: recordId.parse(req.params.id), actorUserId: req.member!.user.id }));
    } catch (error) {
      fail(res, error);
    }
  },
);

for (const [path, kind] of [["appointments", "appointment"], ["projects", "project"]] as const) {
  router.post(
    `/integrations/zapier/flows/${path}/:id/review-request`,
    requireMember("crm.write"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        res.json(await scoutRequestReviewText({ organizationId: req.member!.organizationId, kind, id: recordId.parse(req.params.id), actorUserId: req.member!.user.id }));
      } catch (error) {
        fail(res, error);
      }
    },
  );
}

export default router;
