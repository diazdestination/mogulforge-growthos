import type { MemberProfile } from "@workspace/api-client-react";

/**
 * Successful profile polling is not a new authority or a new session. Keep
 * in-progress work until identity/company/role/access actually changes. The
 * current auth API exposes no session epoch; logout reloads the application.
 * Callers must separately unmount on profile errors or revoked access.
 */
export function memberAuthorityScope(profile: Pick<MemberProfile, "id" | "organization" | "role" | "isActive">) {
  return JSON.stringify([profile.id, profile.organization?.id ?? null, profile.role, profile.isActive]);
}
