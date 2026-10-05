import { z } from 'zod/v4';
import { customerWorkspaceSectionSchema, type CustomerWorkspaceSection } from '../../../api-server/src/services/customer-workspace-contract';

const validId = (value: string | null | undefined): value is string => !!value && z.uuid().safeParse(value).success;

/** Only canonical record identity is carried in these links; this never switches company. */
export function customerWorkspacePath(contactId: string, organizationId: string, section?: CustomerWorkspaceSection): string | null {
  if (!validId(contactId) || !validId(organizationId)) return null;
  return `/contacts/${contactId}?organizationId=${organizationId}${section ? `&section=${section}` : ''}`;
}

export function customerWorkspaceLocation(contactId: string | undefined, search: string, currentOrganizationId: string) {
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  const organizationId = params.get('organizationId');
  const section = customerWorkspaceSectionSchema.safeParse(params.get('section') ?? 'appointments');
  if (!validId(contactId) || keys.some(key => key !== 'organizationId' && key !== 'section') ||
      new Set(keys).size !== keys.length || (params.has('organizationId') && !validId(organizationId)) || !section.success) {
    return { status: 'invalid' as const };
  }
  if (organizationId && organizationId !== currentOrganizationId) return { status: 'different-company' as const };
  return { status: 'allowed' as const, contactId, section: section.data };
}

function localUrl(input: string, origin: string): URL | null {
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\')) return null;
  try {
    const url = new URL(input, origin);
    return url.origin === origin && !url.hash ? url : null;
  } catch { return null; }
}

/** A fixed, pinned customer route may survive a login reload. Never accept returnTo. */
export function customerWorkspaceLoginPath(input: string, origin: string): string | null {
  const url = localUrl(input, origin);
  if (!url) return null;
  const match = /^\/contacts\/([^/]+)$/.exec(url.pathname);
  const organizationId = url.searchParams.get('organizationId');
  if (!match || !validId(organizationId)) return null;
  const parsed = customerWorkspaceLocation(match[1], url.search, organizationId);
  if (parsed.status !== 'allowed') return null;
  return customerWorkspacePath(parsed.contactId, organizationId, url.searchParams.has('section') ? parsed.section : undefined);
}

/** The companion exact-visit card, not a general schedule or arbitrary return URL. */
export function appointmentWorkspaceLoginPath(input: string, origin: string): string | null {
  const url = localUrl(input, origin);
  if (!url || url.pathname !== '/appointments') return null;
  const keys = [...url.searchParams.keys()];
  const appointmentId = url.searchParams.get('appointmentId');
  const organizationId = url.searchParams.get('organizationId');
  if (keys.length !== 2 || new Set(keys).size !== 2 || keys.some(key => key !== 'appointmentId' && key !== 'organizationId') ||
      !validId(appointmentId) || !validId(organizationId)) return null;
  return `/appointments?appointmentId=${appointmentId}&organizationId=${organizationId}`;
}
