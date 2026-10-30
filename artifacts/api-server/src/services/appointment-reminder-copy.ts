import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import { formatAppointmentWindow } from "./contractor-scheduling";
import { getAppointmentReminderSettings, getBusinessName, getOrgSettings } from "./settings";

/**
 * The single renderer for pre-appointment reminder copy. The automated
 * reminder and the APPT text sent through the contractor's own number use the
 * same admin-customizable wording, so an approval re-derives exactly the
 * message the customer would have received.
 */
export async function renderAppointmentReminderCopy(
  organizationId: string,
  appointment: { scheduledStart: Date },
  contactFirstName: string | null | undefined,
) {
  const settings = await getOrgSettings(organizationId);
  const businessName = await getBusinessName(organizationId);
  const businessPhone = settings.businessProfile.phone ?? "";
  // Resolve the same company timezone used by Today. Invalid or missing
  // settings are shown explicitly as UTC, never as a host-wide default.
  const configuredZone = settings.inspectionAvailability?.timezone;
  const zones = await db.execute(sql`select name from pg_timezone_names where name=${configuredZone ?? "UTC"} limit 1`);
  const windowLabel = formatAppointmentWindow(appointment.scheduledStart, zones.rows[0]?.name ?? "UTC");
  const reschedule = businessPhone
    ? `Need to reschedule? Call or text us at ${businessPhone}.`
    : "Need to reschedule? Contact our office and we'll find a time that works.";
  // Admin-customizable copy (org settings), rendered with the same
  // placeholder syntax message templates use. Defaults keep the built-in
  // wording.
  const reminderSettings = await getAppointmentReminderSettings(organizationId);
  const vars: Record<string, string> = {
    "contact.firstName": contactFirstName ?? "there",
    "business.name": businessName,
    "business.phone": businessPhone,
    "appointment.window": windowLabel,
    "reschedule.line": reschedule,
  };
  const render = (input: string) => input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
  return {
    settings,
    businessName,
    configuredZone,
    reminderSettings,
    windowLabel,
    smsBody: render(reminderSettings.smsBody),
    emailSubject: render(reminderSettings.emailSubject),
    emailBody: render(reminderSettings.emailBody),
  };
}
