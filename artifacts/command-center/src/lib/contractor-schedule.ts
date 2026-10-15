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

// Scheduling uses explicit current company authority; the browser-local helpers
// above retain their existing nonscheduling callers and semantics.
import { addElapsedMinutes, durationPresetSchema, formatSchedulingWallTime, isoSchema, resolveWallTime, shiftElapsedInterval, type DurationPreset, type WallTimeEvidence } from '@workspace/scheduling-core';
import type { SchedulingDraft } from './scheduling-ui-contract';

export function companySchedulingWallTime(instant: string, companyTimeZone: string): WallTimeEvidence {
  return formatSchedulingWallTime(instant, companyTimeZone);
}
export function resolveCompanySchedulingInput(local: string, companyTimeZone: string | null, offset?: string, originalInstant?: string | null): string | null {
  try {
    if (!companyTimeZone) return null;
    const resolved = resolveWallTime(local, companyTimeZone);
    const choice = offset ? resolved.choices.find(c => c.offset === offset) : resolved.kind === 'unique' ? resolved.choices[0] : undefined;
    if (!choice) return null;
    if (originalInstant && isoSchema.safeParse(originalInstant).success && Date.parse(originalInstant) === Date.parse(choice.instant)) return originalInstant;
    return choice.instant;
  } catch { return null; }
}
export function schedulingPresetEnd(startAt: string, preset: DurationPreset): string {
  return addElapsedMinutes(startAt, durationPresetSchema.parse(preset).elapsedMinutes);
}
export function schedulingStartOnlyDraft(kind: 'appointment' | 'project', original: SchedulingDraft, newStartAt: string): SchedulingDraft | null {
  try {
    isoSchema.parse(newStartAt);
    if (original.startAt !== null) isoSchema.parse(original.startAt);
    if (original.endAt !== null) isoSchema.parse(original.endAt);
    if (original.startAt && Date.parse(original.startAt) === Date.parse(newStartAt)) return { ...original, resourceUserIds: [...original.resourceUserIds] };
    if (kind === 'project') {
      if (original.endAt && Date.parse(original.endAt) <= Date.parse(newStartAt)) return null;
      return { ...original, startAt: newStartAt, resourceUserIds: [...original.resourceUserIds] };
    }
    if (kind !== 'appointment' || !original.startAt || !original.endAt) return null;
    return { ...shiftElapsedInterval(original.startAt, original.endAt, newStartAt), resourceUserIds: [...original.resourceUserIds] };
  } catch { return null; }
}
