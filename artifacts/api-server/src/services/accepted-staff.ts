import { usersTable } from "@workspace/db";
import { and, eq, isNotNull, notLike } from "drizzle-orm";

/** Legacy verified accounts retain eligibility via the additive verification-column default.
 * Pending placeholders and explicitly unverified registrations are not office coverage.
 * This predicate does not revoke account membership or modify any user row.
 */
export function acceptedStaffCondition() {
  return and(
    eq(usersTable.isActive, true),
    notLike(usersTable.id, "invite:%"),
    isNotNull(usersTable.emailVerifiedAt),
  );
}
