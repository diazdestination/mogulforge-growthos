export const ADAPTER_VERSION: "growthos-website-adapter-v1";
export class WebsiteAdapterError extends Error { code: string; status: number; constructor(code: string, status?: number); }
export interface WebsiteIntake {
  schemaVersion: 1; requestId: string;
  contact: { name: string; email?: string; phone?: string };
  project: { serviceCode: string; postalCode?: string; address?: string; city?: string; state?: string; summary?: string; timing?: "urgent" | "soon" | "planning" | "unsure" };
  consent: { contact: true; policyVersion: string; channels: ("phone" | "email" | "sms")[]; analytics: false };
}
export interface AdapterConfig {
  apiOrigin: string; siteId: string; siteSecret: string; encryptionKey: string; journalPath: string;
  allowedApiOrigins?: string[]; allowLocal?: boolean; capacity?: number;
}
export type DeliveryResult = { status: "saved"; requestId: string; leadId: string; receiptId: string; notification: "staff-inbox"; appointmentStatus: "pending_office_approval" } |
  { status: "queued" | "needs-review"; requestId: string; retained: boolean; reason: string; appointmentStatus: "pending_office_approval" };
export interface JournalHealth {
  contract: string; counts: { queued: number; processing: number; saved: number; "needs-review": number; expired: number };
  review: { requestId: string; state: string; reason: string; attempts: number; receivedAt: number }[];
  capacity: number; totalRecords: number;
}
export interface WebsiteAdapter {
  checkConnection(): Promise<{ status: "credential_verified"; siteId: string; profile: string; credentialVersion: number; captureEnabled: boolean; checkedAt: string; createsLead: false; publicWebsiteVerified: false }>;
  submit(raw: unknown): Promise<DeliveryResult>;
  drain(options?: { retryRequestId?: string }): Promise<JournalHealth>;
  lookup(requestId: string): DeliveryResult;
  inspect(): JournalHealth;
  close(): void;
}
export function normalizeWebsiteIntake(raw: unknown): WebsiteIntake;
export function validateAdapterConfig(config: AdapterConfig): AdapterConfig;
export function createWebsiteAdapter(config: AdapterConfig, dependencies?: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): WebsiteAdapter;
