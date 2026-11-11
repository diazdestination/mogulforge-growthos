/** Fields of a Housecall Pro jobs report the server accepts (mirrors JOB_FIELDS). */
export type JobImportField =
  | "jobId" | "jobNumber" | "createdAt" | "scheduledStart" | "scheduledEnd" | "completedAt"
  | "customerName" | "firstName" | "lastName" | "email" | "phone" | "homePhone" | "customerId"
  | "street" | "street2" | "city" | "state" | "postalCode"
  | "description" | "lineItems" | "amount" | "tax" | "paidAmount" | "due" | "paymentHistory"
  | "employees" | "status" | "invoiceSentAt" | "jobTags" | "customerTags" | "leadSource";

/**
 * Header aliases. The first name in each list is the header of the published
 * Housecall Pro jobs report (dashboard > See all jobs > all table columns >
 * export); the rest are assumed variants. Staff confirm every suggestion.
 */
export const JOB_FIELD_ALIASES: Record<JobImportField, string[]> = {
  jobId: ["HCP Id", "HCP ID", "Job ID", "Job Id"],
  jobNumber: ["Invoice", "Invoice Number", "Invoice #", "Job Number", "Job #"],
  createdAt: ["Created At", "Created", "Created Date"],
  scheduledStart: ["Date", "Scheduled Start", "Scheduled Date", "Start"],
  scheduledEnd: ["End Time", "Scheduled End", "End"],
  completedAt: ["Finished", "Completed At", "Completed", "Finished At"],
  customerName: ["Customer", "Customer Name"],
  firstName: ["First Name"],
  lastName: ["Last Name"],
  email: ["Email", "Customer Email"],
  phone: ["Mobile Phone", "Mobile Number", "Phone", "Cell Phone"],
  homePhone: ["Home Phone", "Work Phone", "Work Number"],
  customerId: ["Customer ID", "Customer Id", "Customer HCP Id"],
  street: ["Street", "Street Line 1", "Address Line 1", "Service Street"],
  street2: ["Street Line 2", "Address Line 2"],
  city: ["City"],
  state: ["State"],
  postalCode: ["Zip", "Zip Code", "Postal Code"],
  description: ["Description", "Job Description"],
  lineItems: ["Line Items"],
  amount: ["Amount", "Total", "Job Total", "Invoice Total"],
  tax: ["Tax", "Tax Amount"],
  paidAmount: ["Paid Amount", "Paid", "Amount Paid"],
  due: ["Due", "Balance", "Balance Due", "Amount Due"],
  paymentHistory: ["Payment History", "Payments"],
  employees: ["Employee", "Employees", "Assigned Employees", "Assigned To", "Technician"],
  status: ["Job Status", "Status"],
  invoiceSentAt: ["Invoice Sent", "Invoice Sent At"],
  jobTags: ["Job Tags"],
  customerTags: ["Customer Tags", "Customer Tag"],
  leadSource: ["Online Booking Source", "Lead Source", "Source"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9#]/g, "");

export function suggestJobsMapping(header: string[]): Partial<Record<JobImportField, number>> {
  const result: Partial<Record<JobImportField, number>> = {};
  const used = new Set<number>();
  const names = header.map(norm);
  for (const field of Object.keys(JOB_FIELD_ALIASES) as JobImportField[]) {
    for (const alias of JOB_FIELD_ALIASES[field]) {
      const index = names.findIndex((name, i) => !used.has(i) && name === norm(alias));
      if (index >= 0) { result[field] = index; used.add(index); break; }
    }
  }
  return result;
}
