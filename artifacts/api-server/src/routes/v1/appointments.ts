import {
  CreateAppointmentBody,
  UpdateAppointmentBody,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { emitAutomationEvent } from "../../services/automation";
import * as crm from "../../services/crm";
import { z } from "zod";
import {
  contractorMutation,
  contractorScheduleError,
} from "../../middlewares/contractor-mutation";
import {
  createManualScheduledAppointment,
  manualSchedulingError,
  nativeManualCommand,
} from "../../services/manual-scheduling";
import { projectSchedulingEvidence } from "../../services/scheduling-policy";

const router: IRouter = Router();
router.use(["/appointments", "/appointments/:id"], contractorMutation);

router.get(
  "/appointments",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const leadId =
      typeof req.query.leadId === "string" ? req.query.leadId : undefined;
    const query = z
      .object({
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
        assignedUserId: z.string().min(1).max(200).optional(),
        contactId: z.uuid().optional(),
      })
      .safeParse(req.query);
    if (
      !query.success ||
      Boolean(query.data.from) !== Boolean(query.data.to) ||
      (query.data.from &&
        query.data.to &&
        (Date.parse(query.data.to) <= Date.parse(query.data.from) ||
          Date.parse(query.data.to) - Date.parse(query.data.from) >
            31 * 86_400_000))
    ) {
      res
        .status(400)
        .json({ error: "Choose a valid date range of at most 31 days." });
      return;
    }
    const rows = await crm.listAppointments(
      req.member!.organizationId,
      leadId,
      {
        from: query.data.from ? new Date(query.data.from) : undefined,
        to: query.data.to ? new Date(query.data.to) : undefined,
        assignedUserId: query.data.assignedUserId,
        contactId: query.data.contactId,
      },
    );
    res.set("X-Result-Limit-Reached", rows.length >= 200 ? "true" : "false");
    res.json(rows);
  },
);

router.post(
  "/appointments",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const actor = {
      organizationId: req.member!.organizationId,
      userId: req.member!.user.id,
    };
    if (req.body?.operationId !== undefined) {
      let command;
      try {
        command = nativeManualCommand(actor, "appointment_create", req.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          res.status(400).json({ error: "Invalid scheduling command" });
          return;
        }
        throw error;
      }
      const result = await createManualScheduledAppointment(actor, command);
      if (!result.record) {
        res.status(409).json(manualSchedulingError(result.ack));
        return;
      }
      if (result.newlyCreated) await notifyBooked(actor, result.record);
      res
        .status(result.newlyCreated ? 201 : 200)
        .json({ ...result.record, schedulingOperation: result.ack });
      return;
    }
    if (req.body?.schedulingReview !== undefined) {
      res
        .status(400)
        .json({
          error:
            "Reviewed scheduling requires the original operation identity.",
          code: "scheduling_operation_required",
        });
      return;
    }
    const parsed = CreateAppointmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid appointment" });
      return;
    }
    const appointment = await crm.createAppointment(
      req.member!.organizationId,
      parsed.data,
      actor,
    );
    if (appointment === "past_start") {
      res
        .status(400)
        .json({
          error:
            "That start time has already passed. Pick a time in the future.",
        });
      return;
    }
    if (appointment === "conflict") {
      res
        .status(409)
        .json({ error: "That inspection window is already fully booked" });
      return;
    }
    if (!appointment) {
      res
        .status(400)
        .json({ error: "Related record not found in your organization" });
      return;
    }
    // Field parity with the concierge's appointment.booked emission so a
    // single org rule (e.g. conditioned on lead.urgency) covers both booking
    // paths.
    await notifyBooked(actor, appointment);
    res
      .status(201)
      .json({
        ...appointment,
        ...projectSchedulingEvidence("appointment", appointment),
      });
  },
);

async function notifyBooked(
  actor: { organizationId: string; userId: string },
  appointment: NonNullable<
    Exclude<Awaited<ReturnType<typeof crm.createAppointment>>, string>
  >,
) {
  try {
    const lead = appointment.leadId
      ? await crm.getLead(actor.organizationId, appointment.leadId)
      : null;
    emitAutomationEvent(actor.organizationId, "appointment.booked", {
      appointmentId: appointment.id,
      leadId: appointment.leadId ?? undefined,
      contactId: appointment.contactId ?? undefined,
      actorUserId: actor.userId,
      fields: {
        "appointment.type": appointment.type,
        "appointment.source": "crm",
        ...(lead?.urgency ? { "lead.urgency": lead.urgency } : {}),
      },
    });
  } catch {
    /* Observer failure cannot change the already committed native outcome. */
  }
}

router.patch(
  "/appointments/:id",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateAppointmentBody.extend({
      expectedUpdatedAt: z.iso.datetime().optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid appointment update" });
      return;
    }
    const appointment = await crm.updateAppointment(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data as Record<string, never>,
      undefined,
      {
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
      },
    );
    if (appointment === "past_start") {
      res
        .status(400)
        .json({
          error:
            "That start time has already passed. Pick a time in the future.",
        });
      return;
    }
    if (appointment === "conflict") {
      res
        .status(409)
        .json({ error: "That inspection window is already fully booked" });
      return;
    }
    if (!appointment) {
      res.status(404).json({ error: "Appointment not found" });
      return;
    }
    res.json({
      ...appointment,
      ...projectSchedulingEvidence("appointment", appointment),
    });
  },
);

router.use(contractorScheduleError);
export default router;
