import type { UserRole } from '@workspace/api-client-react';

export const RoleHierarchy: Record<UserRole, number> = {
  owner: 100,
  admin: 90,
  sales_manager: 80,
  sales_rep: 70,
  inspector: 60,
  production: 50,
  office: 40,
  viewer: 10,
};

export function canWrite(role?: UserRole | null): boolean {
  if (!role) return false;
  return role !== 'viewer';
}

export function canDelete(role?: UserRole | null): boolean {
  if (!role) return false;
  return RoleHierarchy[role] >= RoleHierarchy.sales_manager;
}

export function canViewAuditLog(role?: UserRole | null): boolean {
  if (!role) return false;
  return RoleHierarchy[role] >= RoleHierarchy.admin;
}

export function canManageSettings(role?: UserRole | null): boolean {
  if (!role) return false;
  return RoleHierarchy[role] >= RoleHierarchy.admin;
}

export function canReadInvoices(role?: UserRole | null): boolean {
  return !!role && ['owner', 'admin', 'office', 'sales_manager'].includes(role);
}

export function canManageInvoices(role?: UserRole | null): boolean {
  return !!role && ['owner', 'admin', 'office'].includes(role);
}

/** Field collection on the member's own assigned jobs (server: payments.collect). */
export function canCollectPayments(role?: UserRole | null): boolean {
  return !!role && ['owner', 'admin', 'office', 'sales_rep', 'inspector', 'production'].includes(role);
}

/** Roles that go out to jobs and get the phone-first "My day" screen. Office staff and viewers do not. */
export function isFieldRole(role?: UserRole | null): boolean {
  return !!role && ['owner', 'admin', 'sales_manager', 'sales_rep', 'inspector', 'production'].includes(role);
}
