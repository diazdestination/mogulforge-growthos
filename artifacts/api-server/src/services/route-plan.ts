import {
  appointmentsTable,
  contactsTable,
  db,
  organizationsTable,
  propertiesTable,
  usersTable,
} from "@workspace/db";
import { companyDayBounds } from "@workspace/scheduling-core";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";

import { recordAudit } from "./audit";
import {
  estimatedMinutes,
  mapsDirectionsUrl,
  routeMiles,
  suggestOrder,
  type Point,
} from "./route-plan-math";

/**
 * SCHED route plan for one crew member's work day. Read-only: it reports the
 * day's stops in appointment-time order, the estimated miles, and a shorter
 * stop order when one exists. Appointment times are customer commitments, so
 * nothing is rescheduled here; staff decide whether to move anything.
 */

export class RoutePlanError extends Error {
  constructor(message: string, readonly code: "invalid" | "not_found") {
    super(message);
    this.name = "RoutePlanError";
  }
}

export const routePlanQuery = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    userId: z.string().min(1).max(120).optional(),
  })
  .strict();

export type RouteStop = {
  appointmentId: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  type: string;
  status: string;
  customerName: string;
  address: string | null;
  propertyId: string | null;
  located: boolean;
};

export type RoutePlan = {
  date: string;
  timeZone: string;
  userId: string;
  stops: RouteStop[];
  /** Located stops in appointment-time order. */
  currentOrder: string[];
  /** Located stops in the shortest order found (same first stop). */
  suggestedOrder: string[];
  currentMiles: number;
  suggestedMiles: number;
  savedMiles: number;
  currentDriveMinutes: number;
  suggestedDriveMinutes: number;
  unlocatedCount: number;
  mapsUrl: string | null;
  suggestedMapsUrl: string | null;
  estimateNote: string;
};

function addressOf(property: typeof propertiesTable.$inferSelect | null): string | null {
  if (!property) return null;
  return [property.addressLine1, property.addressLine2, `${property.city}, ${property.state} ${property.postalCode}`]
    .filter((part) => part && part.trim())
    .join(", ");
}

function pointOf(property: typeof propertiesTable.$inferSelect | null): Point | null {
  if (!property?.latitude || !property.longitude) return null;
  const latitude = Number(property.latitude);
  const longitude = Number(property.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

async function dayRows(organizationId: string, date: string, userId: string) {
  const [org] = await db
    .select({ timezone: organizationsTable.timezone })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  if (!org) throw new RoutePlanError("Company not found.", "not_found");
  const [crew] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.organizationId, organizationId)));
  if (!crew) throw new RoutePlanError("That team member is not in this company.", "not_found");
  let bounds: { from: string; to: string };
  try {
    bounds = companyDayBounds(date, org.timezone);
  } catch {
    throw new RoutePlanError("Choose a valid calendar date.", "invalid");
  }
  const rows = await db
    .select({ appointment: appointmentsTable, contact: contactsTable, property: propertiesTable })
    .from(appointmentsTable)
    .leftJoin(contactsTable, eq(contactsTable.id, appointmentsTable.contactId))
    .leftJoin(propertiesTable, eq(propertiesTable.id, appointmentsTable.propertyId))
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        eq(appointmentsTable.assignedUserId, userId),
        inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
        gte(appointmentsTable.scheduledStart, new Date(bounds.from)),
        lt(appointmentsTable.scheduledStart, new Date(bounds.to)),
      ),
    )
    .orderBy(asc(appointmentsTable.scheduledStart), asc(appointmentsTable.id))
    .limit(40);
  return { timeZone: org.timezone, rows };
}

export async function getRoutePlan(organizationId: string, viewerUserId: string, raw: unknown): Promise<RoutePlan> {
  const input = routePlanQuery.parse(raw);
  const userId = input.userId ?? viewerUserId;
  const { timeZone, rows } = await dayRows(organizationId, input.date, userId);

  const stops: RouteStop[] = rows.map(({ appointment, contact, property }) => ({
    appointmentId: appointment.id,
    scheduledStart: appointment.scheduledStart.toISOString(),
    scheduledEnd: appointment.scheduledEnd?.toISOString() ?? null,
    type: appointment.type,
    status: appointment.status,
    customerName: [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || "Customer",
    address: addressOf(property),
    propertyId: property?.id ?? null,
    located: pointOf(property) !== null,
  }));

  const located = rows
    .map((row, index) => ({ row, index, point: pointOf(row.property) }))
    .filter((entry): entry is { row: (typeof rows)[number]; index: number; point: Point } => entry.point !== null);
  const points = located.map((entry) => entry.point);
  const timeOrder = located.map((_, index) => index);
  const suggested = suggestOrder(points);
  const currentMiles = routeMiles(points, timeOrder);
  let suggestedMiles = routeMiles(points, suggested);
  let finalOrder = suggested;
  // Never suggest a "better" order that is not meaningfully shorter.
  if (suggestedMiles >= currentMiles - 0.5) {
    finalOrder = timeOrder;
    suggestedMiles = currentMiles;
  }
  const round = (value: number) => Math.round(value * 10) / 10;
  const addressesFor = (order: number[]) =>
    order.map((index) => stops[located[index]!.index]!.address).filter((value): value is string => Boolean(value));

  return {
    date: input.date,
    timeZone,
    userId,
    stops,
    currentOrder: timeOrder.map((index) => located[index]!.row.appointment.id),
    suggestedOrder: finalOrder.map((index) => located[index]!.row.appointment.id),
    currentMiles: round(currentMiles),
    suggestedMiles: round(suggestedMiles),
    savedMiles: round(currentMiles - suggestedMiles),
    currentDriveMinutes: estimatedMinutes(currentMiles),
    suggestedDriveMinutes: estimatedMinutes(suggestedMiles),
    unlocatedCount: stops.filter((stop) => !stop.located).length,
    mapsUrl: mapsDirectionsUrl(stops.map((stop) => stop.address ?? "").filter(Boolean)),
    suggestedMapsUrl: finalOrder === timeOrder ? null : mapsDirectionsUrl(addressesFor(finalOrder)),
    estimateNote: "Miles and drive times are straight-line estimates adjusted for roads, not turn-by-turn navigation.",
  };
}

// ---------- geocoding ----------

export type Geocoder = (address: string) => Promise<Point | null>;

let geocoderOverride: Geocoder | null | undefined;

/** Test seam. */
export function setGeocoderForTests(geocoder: Geocoder | null | undefined): void {
  geocoderOverride = geocoder;
}

/** US Census Bureau geocoder: free, no key, US addresses only. */
const censusGeocoder: Geocoder = async (address) => {
  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const body = (await response.json()) as { result?: { addressMatches?: { coordinates?: { x?: number; y?: number } }[] } };
  const match = body.result?.addressMatches?.[0]?.coordinates;
  if (typeof match?.x !== "number" || typeof match?.y !== "number") return null;
  return { latitude: match.y, longitude: match.x };
};

function activeGeocoder(): Geocoder | null {
  if (geocoderOverride !== undefined) return geocoderOverride;
  return process.env.PROPERTY_GEOCODER?.trim().toLowerCase() === "off" ? null : censusGeocoder;
}

export function geocoderEnabled(): boolean {
  return activeGeocoder() !== null;
}

/** Fill missing coordinates for that day's stops. Existing coordinates are never overwritten. */
export async function locateDayStops(
  organizationId: string,
  actorUserId: string,
  raw: unknown,
): Promise<{ located: number; notFound: number; plan: RoutePlan }> {
  const input = routePlanQuery.parse(raw);
  const geocode = activeGeocoder();
  if (!geocode) throw new RoutePlanError("Address lookup is turned off on this deployment.", "invalid");
  const userId = input.userId ?? actorUserId;
  const { rows } = await dayRows(organizationId, input.date, userId);
  const pending = new Map<string, typeof propertiesTable.$inferSelect>();
  for (const { property } of rows) if (property && !pointOf(property)) pending.set(property.id, property);
  let located = 0;
  let notFound = 0;
  for (const property of [...pending.values()].slice(0, 25)) {
    const address = addressOf(property);
    let point: Point | null = null;
    try {
      point = address ? await geocode(address) : null;
    } catch {
      point = null;
    }
    if (!point) {
      notFound += 1;
      continue;
    }
    const updated = await db
      .update(propertiesTable)
      .set({ latitude: point.latitude.toFixed(6), longitude: point.longitude.toFixed(6) })
      .where(and(eq(propertiesTable.organizationId, organizationId), eq(propertiesTable.id, property.id)))
      .returning({ id: propertiesTable.id });
    if (updated.length > 0) located += 1;
  }
  if (located > 0) {
    await recordAudit({
      organizationId,
      actorUserId,
      action: "scheduling.route_stops_located",
      entityType: "route_plan",
      metadata: { date: input.date, crewUserId: userId, located, notFound },
    });
  }
  return { located, notFound, plan: await getRoutePlan(organizationId, actorUserId, input) };
}
