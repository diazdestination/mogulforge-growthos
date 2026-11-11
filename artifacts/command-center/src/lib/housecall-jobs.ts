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
  return suggestMapping(header, JOB_FIELD_ALIASES);
}

/** Suggest a column for each field from its aliases; each column is used at most once. */
export function suggestMapping<F extends string>(header: string[], aliases: Record<F, string[]>): Partial<Record<F, number>> {
  const result: Partial<Record<F, number>> = {};
  const used = new Set<number>();
  const names = header.map(norm);
  for (const field of Object.keys(aliases) as F[]) {
    for (const alias of aliases[field]) {
      const index = names.findIndex((name, i) => !used.has(i) && name === norm(alias));
      if (index >= 0) { result[field] = index; used.add(index); break; }
    }
  }
  return result;
}

/** Fields of a Housecall Pro estimates report the server accepts (mirrors ESTIMATE_FIELDS). */
export type EstimateImportField =
  | "estimateId" | "estimateNumber" | "createdAt" | "scheduledStart" | "scheduledEnd"
  | "customerName" | "firstName" | "lastName" | "email" | "phone" | "homePhone"
  | "street" | "street2" | "city" | "state" | "postalCode" | "customerTags"
  | "status" | "amount" | "tax" | "description" | "employees";

/**
 * The first name in each list is the published estimates report header
 * (Open Estimates > See all estimates > all table columns, with the
 * "Estimate" column switched to "Invoice"). Status, amount, tax, description
 * and employee names are not in that published layout and are assumed.
 */
export const ESTIMATE_FIELD_ALIASES: Record<EstimateImportField, string[]> = {
  estimateId: ["HCP Id", "HCP ID", "Estimate ID", "Estimate Id"],
  estimateNumber: ["Invoice", "Estimate", "Estimate Number", "Estimate #"],
  createdAt: ["Created At", "Created", "Created Date"],
  scheduledStart: ["Date", "Scheduled Start", "Scheduled Date", "Start"],
  scheduledEnd: ["End Time", "Scheduled End", "End"],
  customerName: ["Customer", "Customer Name"],
  firstName: ["First Name"],
  lastName: ["Last Name"],
  email: ["Email", "Customer Email"],
  phone: ["Mobile Phone", "Mobile Number", "Phone", "Cell Phone"],
  homePhone: ["Home Phone", "Work Phone", "Work Number"],
  street: ["Street", "Street Line 1", "Address Line 1", "Service Street"],
  street2: ["Street Line 2", "Address Line 2"],
  city: ["City"],
  state: ["State"],
  postalCode: ["Zip", "Zip Code", "Postal Code"],
  customerTags: ["Customer Tag", "Customer Tags"],
  status: ["Estimate Status", "Status", "Option Status", "Approval Status"],
  amount: ["Amount", "Total", "Estimate Total", "Option Total"],
  tax: ["Tax", "Tax Amount"],
  description: ["Description", "Estimate Description"],
  employees: ["Employee", "Employees", "Assigned Employees", "Assigned To"],
};
