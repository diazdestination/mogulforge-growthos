import { customerLifecycleTable, db } from "@workspace/db";
import { and, eq, ne, notExists } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";

/** Filter before LIMIT so paused companies cannot starve other companies' work. */
export function customerWorkAllowedSql(organizationColumn: AnyPgColumn) {
  return notExists(db.select({ id: customerLifecycleTable.organizationId })
    .from(customerLifecycleTable).where(and(
      eq(customerLifecycleTable.organizationId, organizationColumn),
      ne(customerLifecycleTable.state, "active"),
    )));
}

/** Missing organization/schema/database access is an error, never an allow. */
export async function customerWorkHeld(organizationId: string) {
  return !(await getCustomerLifecycleStatus(organizationId)).automationAllowed;
}
