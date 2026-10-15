import type {
  CustomerWorkEstimate,
  CustomerWorkProject,
} from "../../../api-server/src/services/returning-customer-contract";
import { sampleInvoice } from "./invoice-fixtures";
export const workId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const workOrg = workId(701),
  workContact = workId(702),
  workRoot = workId(703),
  workProperty = workId(704);
export const workMember = {
  id: "fictional-work-member",
  email: "staff@example.test",
  firstName: "Fictional",
  lastName: "Staff",
  isActive: true,
  role: "office" as const,
  organization: {
    id: workOrg,
    name: "Fictional Contractor",
    slug: "fictional",
    timezone: "America/New_York",
  },
};
export const workCustomer = (id = workContact) => ({
  id,
  organizationId: workOrg,
  firstName: "Fictional",
  lastName: id === workContact ? "Customer" : "Other Customer",
  email: null,
  phone: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});
const context = {
  organizationId: workOrg,
  leadId: null,
  customerWorkId: workRoot,
  contactId: workContact,
  propertyId: null,
  sourceKind: "customer_work" as const,
  customerLabel: "Fictional Customer",
  propertyLabel: null,
  leadLabel: null,
  workVersion: 1,
};
const dates = {
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};
export const workEstimate = (
  overrides: Partial<CustomerWorkEstimate> = {},
): CustomerWorkEstimate => ({
  id: workId(705),
  ...context,
  title: "Fictional repeat service estimate",
  status: "draft",
  lineItems: [
    {
      description: "Inspected and reviewed scope",
      quantity: 1,
      unitPriceCents: 12500,
      totalCents: 12500,
    },
  ],
  subtotalCents: 12500,
  taxCents: 0,
  totalCents: 12500,
  notes: "Original staff notes",
  sentAt: null,
  acceptedAt: null,
  ...dates,
  ...overrides,
});
export const workProject = (
  overrides: Partial<CustomerWorkProject> = {},
): CustomerWorkProject => ({
  id: workId(706),
  ...context,
  estimateId: null,
  name: "Fictional recurring repair",
  status: "scheduled",
  scheduledStart: null,
  scheduledEnd: null,
  crewUserIds: [],
  crewNotes: "Original crew notes",
  completedAt: null,
  schedulingReservation: null,
  schedulingEvidence: "legacy",
  schedulingTargetFingerprint: "a".repeat(64),
  ...dates,
  ...overrides,
});
export const workInvoice = (
  overrides: Parameters<typeof sampleInvoice>[0] = {},
) =>
  sampleInvoice({
    organizationId: workOrg,
    leadId: null,
    customerWorkId: workRoot,
    contactId: workContact,
    propertyId: null,
    sourceKind: "customer_work",
    ...overrides,
  });
export const workPropertyRow = (n = 704) => ({
  kind: "property" as const,
  id: workId(n),
  createdAt: "2026-10-01T00:00:00Z",
  addressLine1: `${n} Fictional Lane`,
  addressLine2: null,
  city: "Atlanta",
  state: "GA",
  postalCode: "30301",
  propertyType: "residential",
});
export const workProperties = (
  contactId = workContact,
  items = [workPropertyRow()],
  nextCursor: string | null = null,
) => ({
  organizationId: workOrg,
  contactId,
  section: "properties",
  order: "created_desc",
  limit: 25,
  items,
  nextCursor,
  hasMore: nextCursor !== null,
});
