import type { MemberProfile } from "@workspace/api-client-react";
import { getGetMeQueryKey } from '@workspace/api-client-react';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Successful profile polling is not a new authority or a new session. Keep
 * in-progress work until identity/company/role/access actually changes. The
 * current auth API exposes no session epoch; logout reloads the application.
 * Callers must separately unmount on profile errors or revoked access.
 */
export function memberAuthorityScope(profile: Pick<MemberProfile, "id" | "organization" | "role" | "isActive">) {
  return JSON.stringify([profile.id, profile.organization?.id ?? null, profile.role, profile.isActive]);
}

/** Query updates may settle before React commits the semantic remount. A late
 * command callback must also respect the freshest cached authority/error. */
export function currentMemberAuthorityMatches(client: QueryClient, scope: string) {
  const state = client.getQueryState<MemberProfile>(getGetMeQueryKey());
  if (state?.status === 'error') return false;
  return !state?.data || (state.data.isActive && memberAuthorityScope(state.data) === scope);
}
