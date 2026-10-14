import { Temporal } from '@js-temporal/polyfill';
import { isoSchema, localDateTimeSchema, timeZoneSchema, wallTimeEvidenceSchema, type ISO, type WallTimeEvidence } from './models';

function localTime(value: string): Temporal.PlainDateTime {
  localDateTimeSchema.parse(value);
  return Temporal.PlainDateTime.from(value, { overflow: 'reject' });
}
export function resolveWallTime(localDateTime: string, timeZone: string): { kind: 'unique' | 'ambiguous' | 'nonexistent'; choices: { instant: ISO; offset: string }[] } {
  const local = localTime(localDateTime);
  timeZoneSchema.parse(timeZone);
  const instants = new Map<string, { instant: ISO; offset: string }>();
  for (const disambiguation of ['earlier', 'later'] as const) {
    const zoned = local.toZonedDateTime(timeZone, { disambiguation });
    if (!zoned.toPlainDateTime().equals(local)) continue;
    const instant = zoned.toInstant().toString({ fractionalSecondDigits: 3 });
    instants.set(instant, { instant, offset: zoned.offset });
  }
  const choices = [...instants.values()].sort((a, b) => Temporal.Instant.compare(a.instant, b.instant));
  return { kind: choices.length === 0 ? 'nonexistent' : choices.length === 1 ? 'unique' : 'ambiguous', choices };
}
export function validateWallTime(instant: ISO, evidence: WallTimeEvidence): void {
  isoSchema.parse(instant);
  wallTimeEvidenceSchema.parse(evidence);
  const resolved = resolveWallTime(evidence.localDateTime, evidence.timeZone);
  if (!resolved.choices.some(choice => choice.offset === evidence.offset && Temporal.Instant.compare(choice.instant, instant) === 0)) throw new RangeError('Wall time occurrence or offset does not match instant');
}
export function companyDayBounds(date: string, timeZone: string): { from: ISO; to: ISO } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('Calendar date required');
  timeZoneSchema.parse(timeZone);
  const day = Temporal.PlainDate.from(date, { overflow: 'reject' });
  const start = day.toZonedDateTime(timeZone);
  if (!start.toPlainDate().equals(day)) throw new RangeError('Company date does not exist');
  return {
    from: start.toInstant().toString({ fractionalSecondDigits: 3 }),
    to: day.add({ days: 1 }).toZonedDateTime(timeZone).toInstant().toString({ fractionalSecondDigits: 3 }),
  };
}
export function addElapsedMinutes(start: ISO, minutes: number): ISO {
  isoSchema.parse(start);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new RangeError('Elapsed minutes must be an integer from 1 to 1440');
  return Temporal.Instant.from(start).add({ minutes }).toString({ fractionalSecondDigits: 3 });
}

/** Build a shifted draft from an existing range without applying preset limits. */
export function shiftElapsedInterval(existingStart: ISO, existingEnd: ISO, newStart: ISO): { startAt: ISO; endAt: ISO } {
  isoSchema.parse(existingStart);
  isoSchema.parse(existingEnd);
  isoSchema.parse(newStart);
  const start = Temporal.Instant.from(existingStart);
  const end = Temporal.Instant.from(existingEnd);
  const shiftedStart = Temporal.Instant.from(newStart);
  const elapsedMilliseconds = end.epochMilliseconds - start.epochMilliseconds;
  if (!Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds <= 0) throw new RangeError('Existing interval must have positive safe elapsed milliseconds');
  if (Temporal.Instant.compare(start, shiftedStart) === 0) return { startAt: existingStart, endAt: existingEnd };
  const endAt = shiftedStart.add({ milliseconds: elapsedMilliseconds }).toString({ fractionalSecondDigits: 3 });
  isoSchema.parse(endAt);
  return { startAt: newStart, endAt };
}

/** Describe an actual instant in the supplied company zone, including its occurrence. */
export function formatSchedulingWallTime(instant: ISO, companyTimeZone: string): WallTimeEvidence {
  isoSchema.parse(instant);
  timeZoneSchema.parse(companyTimeZone);
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(companyTimeZone);
  return wallTimeEvidenceSchema.parse({
    localDateTime: zoned.toPlainDateTime().toString({ fractionalSecondDigits: 3 }),
    offset: zoned.offset,
    timeZone: companyTimeZone,
  });
}
