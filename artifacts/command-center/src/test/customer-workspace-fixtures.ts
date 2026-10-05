import {
  CUSTOMER_WORKSPACE_SECTIONS, type CustomerWorkspaceHeader, type CustomerWorkspacePage, type CustomerWorkspaceItem,
} from '../../../api-server/src/services/customer-workspace-contract';

export const workspaceId = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const workspaceOrg = workspaceId(1);
export const workspaceContact = workspaceId(2);
export const workspaceTime = '2026-10-05T15:00:00.000Z';
export const workspaceHeader = (contactId = workspaceContact): CustomerWorkspaceHeader => ({
  organizationId: workspaceOrg,
  contact: { id: contactId, firstName: 'Morgan', lastName: 'Synthetic Customer', email: 'morgan@example.test', phone: '+14045550123',
    preferredContactMethod: 'email', doNotContact: false, doNotContactEmail: true, doNotContactSms: false,
    createdAt: workspaceTime, updatedAt: workspaceTime },
  permissions: { canWrite: true, canReadInvoices: true }, availableSections: [...CUSTOMER_WORKSPACE_SECTIONS],
});
export function workspaceRows(): CustomerWorkspaceItem[] {
  const base = { createdAt: workspaceTime };
  const property = { id: workspaceId(3), addressLine1: '15 Fictional Lane', addressLine2: null, city: 'Atlanta', state: 'GA', postalCode: '30301', propertyType: 'residential' };
  const owner = { id: 'synthetic-office', name: 'Office Person' };
  return [
    { ...property, ...base, kind: 'property' },
    { ...base, id: workspaceId(4), kind: 'appointment', type: 'other', status: 'confirmed', scheduledStart: workspaceTime, scheduledEnd: null, updatedAt: workspaceTime, contactId: workspaceContact, leadId: null, property: null, owner },
    { ...base, id: workspaceId(5), kind: 'service', equipmentLabel: 'Synthetic heat pump', serviceKind: 'warranty_check', status: 'active', dueAt: workspaceTime, completedAt: null, coverageStartsOn: '2026-01-01', coverageEndsOn: '2027-01-01', occurrenceIndex: 0, predecessorObligationId: null, taskId: workspaceId(9), appointmentId: workspaceId(4), property, owner },
    { ...base, id: workspaceId(6), kind: 'lead', status: 'new', urgency: 'normal', serviceType: 'Furnace repair', property, owner },
    { ...base, id: workspaceId(7), kind: 'project', name: 'Synthetic installation', status: 'scheduled', scheduledStart: workspaceTime, scheduledEnd: null, completedAt: null, leadId: workspaceId(6), estimateId: workspaceId(8), property },
    { ...base, id: workspaceId(8), kind: 'estimate', title: 'Synthetic estimate', status: 'sent', leadId: workspaceId(6), property },
    { ...base, id: workspaceId(10), kind: 'invoice', title: 'Synthetic service invoice', invoiceNumber: 'SYN-1', status: 'issued', issuedAt: workspaceTime, leadId: workspaceId(6), projectId: null, estimateId: null, property },
    { ...base, id: workspaceId(9), kind: 'task', title: 'Review service appointment', status: 'open', priority: 'normal', dueAt: workspaceTime, completedAt: null, leadId: null, owner },
    { ...base, id: workspaceId(11), kind: 'activity', category: 'communication', label: 'Customer response recorded', occurredAt: workspaceTime, leadId: workspaceId(6) },
  ];
}
export function workspacePage(section: CustomerWorkspacePage['section'], contactId = workspaceContact): CustomerWorkspacePage {
  const kinds = { properties: 'property', appointments: 'appointment', services: 'service', leads: 'lead', projects: 'project', estimates: 'estimate', invoices: 'invoice', tasks: 'task', activity: 'activity' };
  return { organizationId: workspaceOrg, contactId, section, order: 'created_desc', limit: 25, items: workspaceRows().filter(row => row.kind === kinds[section]), hasMore: false, nextCursor: null } as CustomerWorkspacePage;
}
