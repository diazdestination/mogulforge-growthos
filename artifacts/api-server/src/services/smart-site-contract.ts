import { z } from "zod/v4";

/** Configuration packs, not claims that every vertical's operational workflow is complete. */
export const SMART_SITE_PROFILES = [
  {
    id: "roofing-exteriors",
    name: "Roofing & exteriors",
    services: [
      ["roof-replacement", "Roof replacement"],
      ["roof-repair", "Roof repair"],
      ["new-construction", "New construction"],
      ["siding", "Siding"],
      ["gutters", "Gutters & downspouts"],
      ["metal-roofing", "Metal roofing & siding"],
      ["commercial-roofing", "Commercial roofing"],
      ["roof-leak", "Roof leak"],
      ["storm-damage", "Storm damage"],
      ["water-damage", "Water damage"],
      ["not-sure", "Help choosing a service"],
    ],
  },
  {
    id: "hvac",
    name: "HVAC",
    services: [
      ["repair", "Repair"],
      ["replacement", "System replacement"],
      ["maintenance", "Maintenance"],
      ["new-installation", "New installation"],
      ["not-sure", "Help choosing a service"],
    ],
  },
  {
    id: "commercial-construction",
    name: "Commercial construction",
    services: [
      ["new-build", "New construction"],
      ["renovation", "Renovation"],
      ["tenant-improvement", "Tenant improvements"],
      ["project-consultation", "Project consultation"],
    ],
  },
  {
    id: "local-retail",
    name: "Local retail & tea shop",
    services: [
      ["general-inquiry", "General inquiry"],
      ["group-order", "Group order inquiry"],
      ["event", "Event inquiry"],
      ["partnership", "Partnership inquiry"],
    ],
  },
] as const;

const shortText = (max: number) => z.string().trim().max(max);
const campaign = shortText(100).regex(
  /^[a-zA-Z0-9_. -]*$/,
  "Use a campaign label, not a URL or personal information",
);
export const SMART_SITE_EVENT_NAMES = [
  "page_view",
  "project_form_opened",
  "project_form_started",
  "damage_check_opened",
  "damage_check_started",
  "damage_check_details",
  "voice_assistant_opened",
  "voice_session_started",
  "quiet_text_session_started",
  "phone_link_clicked",
  "project_gallery_opened",
  "review_source_opened",
] as const;

const analyticsLabel = shortText(100).regex(/^[a-zA-Z0-9_. -]+$/);
export const smartSiteAcquisitionBatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    consent: z.literal(true),
    policyVersion: shortText(80).regex(/^[a-zA-Z0-9._-]+$/),
    visitorId: z.uuid(),
    sessionId: z.uuid(),
    events: z
      .array(
        z
          .object({
            eventId: z.uuid(),
            eventName: z.enum(SMART_SITE_EVENT_NAMES),
            occurredAt: z.iso.datetime({ offset: true }),
            path: shortText(200).regex(/^\/[a-zA-Z0-9/_-]*$/),
            source: analyticsLabel.optional(),
            medium: analyticsLabel.optional(),
            campaign: analyticsLabel.optional(),
            referrerHost: shortText(200)
              .regex(/^[a-zA-Z0-9.-]+$/)
              .optional(),
            serviceCode: shortText(60)
              .regex(/^[a-z0-9-]+$/)
              .optional(),
            surface: shortText(60)
              .regex(/^[a-z0-9-]+$/)
              .optional(),
            step: shortText(60)
              .regex(/^[a-z0-9-]+$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const smartSiteAnalyticsOptOutSchema = z
  .object({ schemaVersion: z.literal(1), visitorId: z.uuid() })
  .strict();

export type SmartSiteAcquisitionBatch = z.infer<
  typeof smartSiteAcquisitionBatchSchema
>;
export const smartSiteIntakeSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    contact: z
      .object({
        name: shortText(100).min(2),
        email: z.email().max(254).optional(),
        phone: shortText(30)
          .regex(/^\+?[0-9 ()-]{10,30}$/)
          .refine((v) => v.replace(/\D/g, "").length >= 10)
          .optional(),
      })
      .strict()
      .refine((v) => Boolean(v.email || v.phone), "Provide email or phone"),
    project: z
      .object({
        serviceCode: shortText(60).min(1),
        postalCode: z
          .string()
          .regex(/^\d{5}$/)
          .optional(),
        address: shortText(180).optional(),
        city: shortText(100).optional(),
        state: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
        summary: shortText(2000).optional(),
        timing: z
          .enum(["urgent", "soon", "planning", "unsure"])
          .default("unsure"),
      })
      .strict(),
    consent: z
      .object({
        contact: z.literal(true),
        policyVersion: shortText(80).regex(/^[a-zA-Z0-9._-]+$/),
        analytics: z.boolean().default(false),
        channels: z.array(z.enum(["phone", "email", "sms"])).max(3).default([]),
      })
      .strict(),
    attribution: z
      .object({
        source: campaign.optional(),
        medium: campaign.optional(),
        campaign: campaign.optional(),
        landingPath: shortText(200)
          .regex(/^\/[a-zA-Z0-9/_-]*$/)
          .optional(),
        referrerHost: shortText(200)
          .regex(/^[a-zA-Z0-9.-]+$/)
          .optional(),
      })
      .strict()
      .optional(),
    measurement: z
      .object({
        visitorId: z.uuid(),
        sessionId: z.uuid().optional(),
        policyVersion: shortText(80).regex(/^[a-zA-Z0-9._-]+$/),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SmartSiteIntake = z.infer<typeof smartSiteIntakeSchema>;
export function normalizeSmartSiteIntake(raw: unknown): SmartSiteIntake {
  const value = smartSiteIntakeSchema.parse(raw);
  return {
    ...value,
    contact: {
      ...value.contact,
      email: value.contact.email?.toLowerCase(),
      phone: value.contact.phone?.replace(/\D/g, ""),
    },
    // Contact consent is not tracking consent. Never infer identity/behavior linkage.
    attribution: value.consent.analytics ? value.attribution : undefined,
    measurement: value.consent.analytics ? value.measurement : undefined,
  };
}
