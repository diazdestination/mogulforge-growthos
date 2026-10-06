import { useState } from 'react';
import { Link, useParams, useSearch } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { getGetMeQueryKey, useGetMe } from '@workspace/api-client-react';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import { contractorRequest } from '@/lib/contractor-api';
import { memberAuthorityScope } from '@/lib/member-authority-scope';
import { canReadInvoices } from '@/lib/permissions';
import CustomerAssetsPanel from '@/components/customer-assets-panel';
import { WorkdayDisclosure } from '@/components/workday-ui';
import { customerWorkspaceLocation, customerWorkspacePath } from '@/lib/customer-workspace-links';
import {
  customerWorkspaceHeaderSchema, customerWorkspacePageSchema,
  type CustomerWorkspaceHeader, type CustomerWorkspaceItem, type CustomerWorkspaceSection,
} from '../../../api-server/src/services/customer-workspace-contract';

const LABELS: Record<CustomerWorkspaceSection, string> = {
  appointments: 'Visits', properties: 'Properties', services: 'Service & equipment',
  leads: 'Opportunities', projects: 'Jobs', estimates: 'Estimates', invoices: 'Invoices',
  tasks: 'Tasks', activity: 'History',
};
const SECTIONS: CustomerWorkspaceSection[] = ['appointments', 'services', 'properties', 'leads', 'projects', 'estimates', 'invoices', 'tasks', 'activity'];
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50';
const recordLink = 'inline-flex min-h-11 items-center rounded-lg text-sm font-semibold text-primary underline-offset-4 hover:underline';

const label = (value: string) => value.replace(/_/g, ' ');
function time(value: string | null, timezone?: string) {
  if (!value) return 'Not recorded';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value)); }
  catch { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)); }
}
function dateOnly(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'Not recorded';
}

function Unavailable({ children, retry }: { children: React.ReactNode; retry?: () => void }) {
  return <section role="alert" className="space-y-3 rounded-xl border border-border bg-card p-5">
    <h2 className="font-semibold">Customer work record unavailable</h2><p className="text-sm text-muted-foreground">{children}</p>
    {retry && <button type="button" className={button} onClick={retry}>Try again</button>}
    <Link href="/contacts" className={`${recordLink} ml-3`}>Back to contacts</Link>
  </section>;
}

export default function CustomerWorkspace() {
  const { id } = useParams<{ id: string }>();
  const search = useSearch();
  const profile = useGetMe({ query: { queryKey: getGetMeQueryKey(), refetchOnMount: false } });
  if (profile.isError || (profile.data && (!profile.data.isActive || !profile.data.organization))) {
    return <div className="p-4"><Unavailable retry={() => { void profile.refetch(); }}>Current company access could not be verified. Reload or sign in again; no customer details are shown.</Unavailable></div>;
  }
  if (profile.isLoading || !profile.data?.organization) return <p role="status" className="p-5">Checking current company access…</p>;
  const me = profile.data;
  const context = customerWorkspaceLocation(id, search, me.organization!.id);
  if (context.status !== 'allowed') return <div className="p-4"><Unavailable>{context.status === 'different-company'
    ? 'This link belongs to a different company. Sign in to the matching company to open it; this link does not switch your company.'
    : 'This customer link is invalid. Open the customer from Contacts again.'}</Unavailable></div>;
  const authority = memberAuthorityScope(me);
  return <Workspace key={`${authority}:${context.contactId}`} authority={authority} contactId={context.contactId}
    organizationId={me.organization!.id} organizationName={me.organization!.name} timezone={me.organization!.timezone}
    invoiceAccess={canReadInvoices(me.role)} section={context.section} />;
}

function Workspace({ authority, contactId, organizationId, organizationName, timezone, invoiceAccess, section }: {
  authority: string; contactId: string; organizationId: string; organizationName: string; timezone: string;
  invoiceAccess: boolean; section: CustomerWorkspaceSection;
}) {
  const [refresh, setRefresh] = useState(0);
  const header = useQuery({
    queryKey: ['customer-workspace', authority, contactId, 'header'], retry: false, staleTime: 0, refetchOnMount: 'always',
    queryFn: async ({ signal }) => {
      const data = customerWorkspaceHeaderSchema.parse(await contractorRequest(`/contacts/${contactId}/workspace`, { signal }));
      if (data.organizationId !== organizationId || data.contact.id !== contactId || new Set(data.availableSections).size !== data.availableSections.length) throw new Error('Customer context changed');
      return data;
    },
  });
  const reload = () => { setRefresh(value => value + 1); void header.refetch(); };
  if (header.isError) return <div className="p-4"><Unavailable retry={reload}>The current customer could not be loaded or your access changed. Check your connection and refresh; customer records are not saved for offline use.</Unavailable></div>;
  if (!header.data) return <p role="status" className="flex items-center gap-2 p-5"><Loader2 className="size-4 animate-spin" />Loading customer work record…</p>;
  const data = header.data;
  const available = SECTIONS.filter(value => data.availableSections.includes(value) && (value !== 'invoices' || (invoiceAccess && data.permissions.canReadInvoices)));
  return <div className="h-full min-w-0 overflow-y-auto bg-background p-4 pb-24 md:p-6">
    <div className="mx-auto max-w-5xl min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/contacts" className={recordLink}><ArrowLeft className="mr-2 size-4" />Contacts</Link>
        <button type="button" className={button} onClick={reload} disabled={header.isFetching}><RefreshCw className="size-4" />Refresh record</button>
      </div>
      <CustomerHeader data={data} organizationName={organizationName} timezone={timezone} />
      <nav aria-label="Customer record sections" className="flex flex-wrap gap-2">
        {available.map(value => <Link key={value} href={customerWorkspacePath(contactId, organizationId, value)!}
          aria-current={section === value ? 'page' : undefined}
          className={`${button} ${section === value ? 'border-primary bg-primary/10 text-primary' : 'bg-card'}`}>{LABELS[value]}</Link>)}
      </nav>
      {available.includes(section)
        ? <Records key={`${section}:${refresh}`} authority={authority} contactId={contactId} organizationId={organizationId} section={section} timezone={timezone} invoiceAccess={invoiceAccess && data.permissions.canReadInvoices} refresh={refresh} />
        : <section role="alert" className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">This section is not available to your current role</h2><p className="mt-2 text-sm text-muted-foreground">Choose an available section above. No restricted records were requested.</p></section>}
    </div>
  </div>;
}

function CustomerHeader({ data, organizationName, timezone }: { data: CustomerWorkspaceHeader; organizationName: string; timezone: string }) {
  const contact = data.contact;
  return <header className="min-w-0 rounded-xl border border-border bg-card p-4 md:p-5">
    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Customer work record · {organizationName}</p>
    <h1 className="mt-2 break-words text-2xl font-bold">{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Customer'}</h1>
    <p className="mt-1 text-sm text-muted-foreground">One customer’s existing records. Updates and actions stay in their original workflows.</p>
    <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
      <dl className="min-w-0 space-y-2 text-sm">
        <div><dt className="text-muted-foreground">Email</dt><dd className="break-all">{contact.email || 'Not recorded'}</dd></div>
        <div><dt className="text-muted-foreground">Phone</dt><dd className="break-words">{contact.phone || 'Not recorded'}</dd></div>
        <div><dt className="text-muted-foreground">Recorded contact preference</dt><dd>{contact.preferredContactMethod ? label(contact.preferredContactMethod) : 'Not recorded'}</dd></div>
      </dl>
      <div className="min-w-0 rounded-lg border border-border bg-muted/20 p-3 text-sm">
        <h2 className="font-semibold">Contact restrictions</h2>
        <ul className="mt-2 space-y-1">
          <li>All contact: {contact.doNotContact ? 'Do not contact' : 'No restriction recorded'}</li>
          <li>Email: {contact.doNotContactEmail ? 'Do not email' : 'No restriction recorded'}</li>
          <li>SMS: {contact.doNotContactSms ? 'Do not text' : 'No restriction recorded'}</li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">These flags and preferences are existing data, not consent or permission to send.</p>
      </div>
    </div>
    <p className="mt-4 break-all text-xs text-muted-foreground">Customer ID: {contact.id}</p>
    <p className="mt-1 text-xs text-muted-foreground">Created {time(contact.createdAt, timezone)} · Updated {time(contact.updatedAt, timezone)}</p>
  </header>;
}

function Records({ authority, contactId, organizationId, section, timezone, invoiceAccess, refresh }: {
  authority: string; contactId: string; organizationId: string; section: CustomerWorkspaceSection; timezone: string; invoiceAccess: boolean; refresh: number;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const cursor = cursors[pageIndex];
  const query = useQuery({
    queryKey: ['customer-workspace', authority, contactId, section, refresh, cursor], retry: false, staleTime: 0, refetchOnMount: 'always',
    queryFn: async ({ signal }) => {
      const result = customerWorkspacePageSchema.parse(await contractorRequest(`/contacts/${contactId}/workspace/${section}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }));
      if (result.organizationId !== organizationId || result.contactId !== contactId || result.section !== section ||
          new Set(result.items.map(item => item.id)).size !== result.items.length ||
          result.items.some(item => item.kind === 'appointment' && item.contactId !== contactId) ||
          result.hasMore !== (result.nextCursor !== null) || (result.nextCursor && cursors.slice(0, pageIndex + 1).includes(result.nextCursor)) ||
          (result.nextCursor && !/^[A-Za-z0-9_-]+$/.test(result.nextCursor)) ||
          (!invoiceAccess && result.items.some(item => item.kind === 'invoice' || (item.kind === 'activity' && item.category === 'invoice')))) throw new Error('Customer section context changed');
      return result;
    },
  });
  return <section aria-labelledby="customer-section-title" className="min-w-0 space-y-3">
    <div><h2 id="customer-section-title" className="text-lg font-bold">{LABELS[section]}</h2>
      <p className="text-sm text-muted-foreground">Newest-created records first, up to 25 per page. Visit and due dates are shown separately; this is not a next-visit schedule.</p>
      <p className="mt-1 text-xs text-muted-foreground">Times use {timezone || 'UTC'}. Refresh or reload starts at the newest page; these pages are not a frozen export.</p>
    </div>
    {query.isError ? <div role="alert" className="space-y-3 rounded-xl border border-border bg-card p-4">
      <p>This page could not be verified. The record, access, or page cursor may have changed. Refresh the record to start again.</p>
      <button type="button" className={button} onClick={() => { void query.refetch(); }}>Try page again</button>
    </div> : !query.data ? <p role="status" className="flex items-center gap-2 p-4"><Loader2 className="size-4 animate-spin" />Loading {LABELS[section].toLowerCase()}…</p>
      : query.data.items.length === 0 ? <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No {LABELS[section].toLowerCase()} records on this page for this customer.</p>
        : <ul aria-label={`${LABELS[section]} records`} className="min-w-0 space-y-3">{query.data.items.map(item => <li key={item.id}><RecordCard item={item} organizationId={organizationId} timezone={timezone} /></li>)}</ul>}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={button} disabled={pageIndex === 0 || query.isFetching} onClick={() => setPageIndex(value => value - 1)}>Newer page</button>
      <span className="text-sm text-muted-foreground">Page {pageIndex + 1}</span>
      <button type="button" className={button} disabled={query.isError || query.isFetching || !query.data?.hasMore} onClick={() => {
        const next = query.data?.nextCursor;
        if (!next) return;
        setCursors(previous => [...previous.slice(0, pageIndex + 1), next]); setPageIndex(value => value + 1);
      }}>Older records</button>
    </div>
    {section === 'services' && !query.isError && query.data && <WorkdayDisclosure title="Equipment & assets"><CustomerAssetsPanel organizationId={organizationId} contactId={contactId} scopeKey={authority} /></WorkdayDisclosure>}
    {section === 'properties' && <Link href="/properties" className={recordLink}>Open property directory (all customers)</Link>}
    {section === 'activity' && <p className="text-xs text-muted-foreground">History shows recorded events, not proof of delivery, a confirmed booking, completed work, or collected revenue.</p>}
  </section>;
}

function RecordCard({ item, organizationId, timezone }: { item: CustomerWorkspaceItem; organizationId: string; timezone: string }) {
  const leadLink = (id: string) => `/leads/${id}?organizationId=${organizationId}`;
  const property = 'property' in item ? item.property : undefined;
  const owner = 'owner' in item ? item.owner : undefined;
  let title: string;
  let details: React.ReactNode;
  let destination: string | null = null;
  let destinationLabel = '';
  switch (item.kind) {
    case 'property': title = item.addressLine1; details = <><p>{item.addressLine2}</p><p>{item.city}, {item.state} {item.postalCode}</p><p className="text-muted-foreground">{item.propertyType ? label(item.propertyType) : 'Property type not recorded'}</p></>; break;
    case 'appointment': title = `${label(item.type)} visit`; details = <><p>{label(item.status)}</p><p>Visit start: {time(item.scheduledStart, timezone)}</p><p>Visit end: {time(item.scheduledEnd, timezone)}</p></>; destination = `/appointments?appointmentId=${item.id}&organizationId=${organizationId}`; destinationLabel = 'Open visit'; break;
    // Service dueAt encodes a calendar day at noon UTC, not a booked visit time.
    case 'service': title = item.equipmentLabel; details = <><p>{label(item.serviceKind)} · {label(item.status)}</p><p>Service due: {dateOnly(item.dueAt.slice(0, 10))}</p><p>Recorded coverage: {dateOnly(item.coverageStartsOn)} – {dateOnly(item.coverageEndsOn)}</p><p className="text-xs text-muted-foreground">Recorded coverage dates are not a determination of warranty eligibility.</p>{item.completedAt && <p>Completed: {time(item.completedAt, timezone)}</p>}</>; destination = `/service?serviceObligationId=${item.id}&organizationId=${organizationId}`; destinationLabel = 'Open service'; break;
    case 'lead': title = item.serviceType || 'Opportunity'; details = <p>{label(item.status)} · {item.urgency} urgency</p>; destination = leadLink(item.id); destinationLabel = 'Open opportunity'; break;
    case 'project': title = item.name; details = <><p>{label(item.status)}</p><p>Scheduled start: {time(item.scheduledStart, timezone)}</p><p>Scheduled end: {time(item.scheduledEnd, timezone)}</p>{item.completedAt && <p>Completed: {time(item.completedAt, timezone)}</p>}</>; destination = leadLink(item.leadId); destinationLabel = 'Open related opportunity'; break;
    case 'estimate': title = item.title; details = <p>{label(item.status)}</p>; destination = leadLink(item.leadId); destinationLabel = 'Open related opportunity'; break;
    case 'invoice': title = item.title; details = <><p>Invoice {item.invoiceNumber || 'number not assigned'} · {item.status}</p><p>Issued: {time(item.issuedAt, timezone)}</p><p className="text-xs text-muted-foreground">Open the invoice for its authoritative balance and details.</p></>; destination = `/invoices/${item.id}`; destinationLabel = 'Open invoice'; break;
    case 'task': title = item.title; details = <><p>{label(item.status)} · {item.priority} priority</p><p>Due: {time(item.dueAt, timezone)}</p>{item.completedAt && <p>Completed: {time(item.completedAt, timezone)}</p>}</>; destination = `/tasks?taskId=${item.id}`; destinationLabel = 'Open task'; break;
    case 'activity': title = item.label; details = <p>Recorded event: {time(item.occurredAt, timezone)}</p>; destination = item.leadId ? leadLink(item.leadId) : null; destinationLabel = 'Open related opportunity'; break;
  }
  return <article className="min-w-0 break-words rounded-xl border border-border bg-card p-4">
    <h3 className="font-semibold">{title}</h3><div className="mt-2 space-y-1 text-sm">{details}</div>
    {property !== undefined && <div className="mt-3 text-sm text-muted-foreground">{property ? <><p>{property.addressLine1}{property.addressLine2 ? `, ${property.addressLine2}` : ''}</p><p>{property.city}, {property.state} {property.postalCode}</p></> : <p>No property linked</p>}</div>}
    {owner !== undefined && <p className="mt-2 text-sm text-muted-foreground">Owner: {owner ? owner.name || `Staff member ${owner.id}` : 'Unassigned'}</p>}
    <p className="mt-3 text-xs text-muted-foreground">Created {time(item.createdAt, timezone)}</p>
    <p className="mt-1 break-all text-xs text-muted-foreground">Record ID: {item.id}</p>
    {destination && <Link href={destination} className={`${recordLink} mt-1`}>{destinationLabel}</Link>}
  </article>;
}
