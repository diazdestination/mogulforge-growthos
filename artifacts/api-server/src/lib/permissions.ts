import type { UserRole } from "@workspace/db";

export type Permission =
  | "crm.read"
  | "crm.write"
  | "crm.delete"
  | "invoices.read"
  | "invoices.manage"
  | "payments.collect"
  | "audit.read"
  | "users.read"
  | "users.manage"
  | "settings.manage";

const ALL_ROLES: UserRole[] = [
  "owner",
  "admin",
  "sales_manager",
  "sales_rep",
  "inspector",
  "production",
  "office",
  "viewer",
];

const WRITE_ROLES: UserRole[] = [
  "owner",
  "admin",
  "sales_manager",
  "sales_rep",
  "inspector",
  "production",
  "office",
];

const ADMIN_ROLES: UserRole[] = ["owner", "admin"];

const PERMISSION_MATRIX: Record<Permission, UserRole[]> = {
  "crm.read": ALL_ROLES,
  "crm.write": WRITE_ROLES,
  "crm.delete": ["owner", "admin", "sales_manager"],
  "invoices.read": ["owner", "admin", "office", "sales_manager"],
  "invoices.manage": ["owner", "admin", "office"],
  // Narrow field collection: only invoices linked to the member's own assigned
  // appointment (enforced in services/field-collect.ts), never invoice lists or edits.
  "payments.collect": ["owner", "admin", "office", "sales_rep", "inspector", "production"],
  "audit.read": ADMIN_ROLES,
  "users.read": ALL_ROLES,
  "users.manage": ADMIN_ROLES,
  "settings.manage": ADMIN_ROLES,
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return PERMISSION_MATRIX[permission].includes(role);
}
