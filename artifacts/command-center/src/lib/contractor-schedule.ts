export function localDateTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function canAssignWork(user: { id: string; isActive?: boolean; role: string; operationallyEligible?: boolean }) {
  return user.operationallyEligible ?? (user.isActive !== false && !user.id.startsWith('invite:') && user.role !== 'viewer');
}

export const scheduleTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
