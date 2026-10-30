import { appointmentsTable, contactsTable, db, organizationsTable, propertiesTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { getRoutePlan, locateDayStops, RoutePlanError, setGeocoderForTests } from "./route-plan";

const orgIds: string[] = [];
const userIds: string[] = [];
const DAY = "2026-11-04";

// Stops on an east-west line, booked in zig-zag time order (A, D, B, C).
const coordinates: Record<string, [number, number] | null> = {
  A: [34.4, -84.1],
  D: [34.4, -83.8],
  B: [34.4, -84.0],
  C: null, // no coordinates yet: needs a lookup
};
const geocoded: Record<string, [number, number]> = { "3 C St, Dawsonville, GA 30534": [34.4, -83.9] };

beforeAll(async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (const suffix of ["a", "b"]) {
    const [org] = await db
      .insert(organizationsTable)
      .values({ name: `Route ${suffix}`, slug: `test-route-${suffix}-${nonce}`, timezone: "America/New_York" })
      .returning();
    const userId = `route-user-${suffix}-${nonce}`;
    await db.insert(usersTable).values({ id: userId, email: `route-${suffix}-${nonce}@example.test`, organizationId: org!.id, role: "owner" });
    orgIds.push(org!.id);
    userIds.push(userId);
  }
  const hours = { A: 13, D: 14, B: 15, C: 16 } as const;
  let street = 1;
  for (const [label, hour] of Object.entries(hours)) {
    const [contact] = await db.insert(contactsTable).values({ organizationId: orgIds[0]!, firstName: `Customer ${label}` }).returning();
    const point = coordinates[label];
    const [property] = await db
      .insert(propertiesTable)
      .values({
        organizationId: orgIds[0]!,
        contactId: contact!.id,
        addressLine1: label === "C" ? "3 C St" : `${street} ${label} St`,
        city: "Dawsonville",
        state: "GA",
        postalCode: "30534",
        latitude: point ? String(point[0]) : null,
        longitude: point ? String(point[1]) : null,
      })
      .returning();
    street += 1;
    await db.insert(appointmentsTable).values({
      organizationId: orgIds[0]!,
      contactId: contact!.id,
      propertyId: property!.id,
      assignedUserId: userIds[0]!,
      scheduledStart: new Date(`${DAY}T${hour}:00:00.000Z`),
      scheduledEnd: new Date(`${DAY}T${hour}:45:00.000Z`),
    });
  }
  // Cancelled visit and another day's visit are excluded.
  await db.insert(appointmentsTable).values({ organizationId: orgIds[0]!, assignedUserId: userIds[0]!, status: "cancelled", scheduledStart: new Date(`${DAY}T17:00:00.000Z`) });
  await db.insert(appointmentsTable).values({ organizationId: orgIds[0]!, assignedUserId: userIds[0]!, scheduledStart: new Date("2026-11-05T15:00:00.000Z") });
});

afterAll(async () => {
  setGeocoderForTests(undefined);
  for (let index = 0; index < userIds.length; index += 1) {
    await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, userIds[index]!));
    await deleteTestOrgs(orgIds[index]!);
    await db.delete(usersTable).where(eq(usersTable.id, userIds[index]!));
  }
});

describe("SCHED route plan", () => {
  it("lists the day's open stops in time order and suggests a shorter order", async () => {
    const plan = await getRoutePlan(orgIds[0]!, userIds[0]!, { date: DAY });
    expect(plan.stops.map((stop) => stop.customerName)).toEqual(["Customer A", "Customer D", "Customer B", "Customer C"]);
    expect(plan.unlocatedCount).toBe(1);
    expect(plan.currentOrder).toHaveLength(3);
    expect(plan.savedMiles).toBeGreaterThan(0);
    expect(plan.suggestedMiles).toBeLessThan(plan.currentMiles);
    const names = plan.suggestedOrder.map((id) => plan.stops.find((stop) => stop.appointmentId === id)!.customerName);
    expect(names).toEqual(["Customer A", "Customer B", "Customer D"]);
    expect(plan.mapsUrl).toContain("google.com/maps/dir");
    expect(plan.suggestedMapsUrl).toContain("google.com/maps/dir");
  });

  it("fills missing coordinates without overwriting existing ones", async () => {
    setGeocoderForTests(async (address) => {
      const hit = geocoded[address];
      return hit ? { latitude: hit[0], longitude: hit[1] } : null;
    });
    const result = await locateDayStops(orgIds[0]!, userIds[0]!, { date: DAY });
    expect(result).toMatchObject({ located: 1, notFound: 0 });
    expect(result.plan.unlocatedCount).toBe(0);
    const names = result.plan.suggestedOrder.map((id) => result.plan.stops.find((stop) => stop.appointmentId === id)!.customerName);
    expect(names).toEqual(["Customer A", "Customer B", "Customer C", "Customer D"]);
  });

  it("keeps the booked order when it is already the shortest", async () => {
    const empty = await getRoutePlan(orgIds[0]!, userIds[0]!, { date: "2026-11-05" });
    expect(empty.stops).toHaveLength(1);
    expect(empty.savedMiles).toBe(0);
    expect(empty.suggestedMapsUrl).toBeNull();
  });

  it("refuses another company's crew member and invalid dates", async () => {
    await expect(getRoutePlan(orgIds[1]!, userIds[1]!, { date: DAY, userId: userIds[0]! })).rejects.toBeInstanceOf(RoutePlanError);
    await expect(getRoutePlan(orgIds[0]!, userIds[0]!, { date: "2026-02-30" })).rejects.toBeInstanceOf(RoutePlanError);
    expect((await getRoutePlan(orgIds[1]!, userIds[1]!, { date: DAY })).stops).toEqual([]);
  });
});
