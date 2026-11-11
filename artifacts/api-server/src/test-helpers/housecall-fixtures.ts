/**
 * Synthetic Housecall Pro exports (no real customers). Headers follow the
 * published export layouts; see "Move from Housecall Pro" in
 * HOUSECALL-PRO-REPLACEMENT-GATE.md for which headers were confirmed where.
 */
export const HCP_JOBS_HEADER = [
  "Invoice", "HCP Id", "Created At", "Date", "End Time", "Travel Duration", "On Job Duration", "Total Duration",
  "Customer", "First Name", "Last Name", "Email", "Company", "Mobile Phone", "Home Phone", "Customer Tags",
  "Address", "Street", "Street Line 2", "City", "State", "Zip", "Description", "Line Items", "Amount", "Labor",
  "Materials", "Subtotal", "Payment History", "Credit Card Fee", "Paid Amount", "Due", "Discount", "Tax",
  "Taxable Amount", "Tax rate", "Job Tags", "Notes", "Employee", "Job Status", "Finished", "Payment",
  "Invoice Sent", "Window", "HC Job", "Tip Amount", "Online Booking Source",
] as const;
export const HCP_CUSTOMERS_HEADER = [
  "First Name", "Last Name", "Mobile Number", "Email", "Company", "Job Title", "Work Number", "Tags", "Notes", "ID",
  "Address_1 Street Line 1", "Address_1 Street Line 2", "Address_1 City", "Address_1 State", "Address_1 Postal Code", "Address_1 Billing?", "Address_1 Notes",
  "Address_1 Street Line 1", "Address_1 Street Line 2", "Address_1 City", "Address_1 State", "Address_1 Postal Code", "Address_1 Billing?", "Address_1 Notes",
] as const;
const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function csv(header: readonly string[], rows: (Record<string, string> | string[])[]): string {
  return [header.map(cell).join(","), ...rows.map((r) => (Array.isArray(r) ? r : header.map((h) => r[h] ?? "")).map(cell).join(","))].join("\r\n");
}
export type HcpJobRow = Partial<Record<(typeof HCP_JOBS_HEADER)[number], string>>;
export const hcpJobsCsv = (rows: HcpJobRow[]) => csv(HCP_JOBS_HEADER, rows as Record<string, string>[]);
/** The staff-confirmed mapping for the published jobs report layout. */
export function hcpJobsMapping() {
  const at = (name: (typeof HCP_JOBS_HEADER)[number]) => HCP_JOBS_HEADER.indexOf(name);
  return {
    jobNumber: at("Invoice"), jobId: at("HCP Id"), createdAt: at("Created At"), scheduledStart: at("Date"), scheduledEnd: at("End Time"),
    customerName: at("Customer"), firstName: at("First Name"), lastName: at("Last Name"), email: at("Email"), phone: at("Mobile Phone"),
    homePhone: at("Home Phone"), customerTags: at("Customer Tags"), street: at("Street"), street2: at("Street Line 2"), city: at("City"),
    state: at("State"), postalCode: at("Zip"), description: at("Description"), lineItems: at("Line Items"), amount: at("Amount"),
    paymentHistory: at("Payment History"), paidAmount: at("Paid Amount"), due: at("Due"), tax: at("Tax"), jobTags: at("Job Tags"),
    employees: at("Employee"), status: at("Job Status"), completedAt: at("Finished"), invoiceSentAt: at("Invoice Sent"), leadSource: at("Online Booking Source"),
  };
}

/** Published estimates report columns ("Estimate" column switched to "Invoice", as the migration guide instructs). */
export const HCP_ESTIMATES_HEADER = [
  "Invoice", "HCP Id", "Created At", "Date", "End Time", "Travel Duration", "On Job Duration", "Total Duration",
  "Customer", "First Name", "Last Name", "Email", "Company", "Mobile Phone", "Home Phone", "Customer Tag",
  "Address", "Street", "Street Line 2", "City", "State", "Zip",
] as const;
/** Status and money columns are not in the published layout; these names are assumed. */
export const HCP_ESTIMATES_EXTRA = ["Estimate Status", "Amount", "Tax"] as const;
export type HcpEstimateRow = Partial<Record<(typeof HCP_ESTIMATES_HEADER)[number] | (typeof HCP_ESTIMATES_EXTRA)[number], string>>;
export const hcpEstimatesCsv = (rows: HcpEstimateRow[], extra = false) =>
  csv(extra ? [...HCP_ESTIMATES_HEADER, ...HCP_ESTIMATES_EXTRA] : HCP_ESTIMATES_HEADER, rows as Record<string, string>[]);
export function hcpEstimatesMapping(extra = false) {
  const at = (name: string) => (HCP_ESTIMATES_HEADER as readonly string[]).indexOf(name);
  const base = {
    estimateNumber: at("Invoice"), estimateId: at("HCP Id"), createdAt: at("Created At"), scheduledStart: at("Date"), scheduledEnd: at("End Time"),
    customerName: at("Customer"), firstName: at("First Name"), lastName: at("Last Name"), email: at("Email"), phone: at("Mobile Phone"),
    homePhone: at("Home Phone"), customerTags: at("Customer Tag"), street: at("Street"), street2: at("Street Line 2"), city: at("City"),
    state: at("State"), postalCode: at("Zip"),
  };
  const n = HCP_ESTIMATES_HEADER.length;
  return extra ? { ...base, status: n, amount: n + 1, tax: n + 2 } : base;
}
