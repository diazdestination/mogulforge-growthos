import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { addElapsedMinutes, companyDayBounds, formatSchedulingWallTime, resolveWallTime, shiftElapsedInterval, validateWallTime } from './index';

describe('wall-time conversion', () => {
  // A compatible/default DST conversion would silently move the gap or pick a fold.
  it('rejects DST gap and preserves explicit fold choices', () => {
    expect(resolveWallTime('2026-03-08T02:30:00', 'America/New_York')).toEqual({ kind: 'nonexistent', choices: [] });
    expect(resolveWallTime('2026-11-01T01:30:00', 'America/New_York')).toEqual({ kind: 'ambiguous', choices: [
      { instant: '2026-11-01T05:30:00.000Z', offset: '-04:00' },
      { instant: '2026-11-01T06:30:00.000Z', offset: '-05:00' },
    ] });
  });
  it('retains the half-hour Lord Howe fold', () => {
    expect(resolveWallTime('2026-04-05T01:45:00', 'Australia/Lord_Howe')).toEqual({ kind: 'ambiguous', choices: [
      { instant: '2026-04-04T14:45:00.000Z', offset: '+11:00' },
      { instant: '2026-04-04T15:15:00.000Z', offset: '+10:30' },
    ] });
  });
  it('resolves a non-hour zone without rounding its offset', () => {
    expect(resolveWallTime('2026-10-13T09:00', 'Asia/Kolkata')).toEqual({ kind: 'unique', choices: [
      { instant: '2026-10-13T03:30:00.000Z', offset: '+05:30' },
    ] });
  });
  it.each(['2026-02-30T09:00', '2026-10-13', '2026-10-13T09:00Z', '2026-10-13T09:00+05:30', '2026-10-13T09:00:60'])('rejects invalid or nonlocal input %s', (local) => {
    expect(() => resolveWallTime(local, 'America/New_York')).toThrow();
  });
  it('rejects an invalid time zone', () => {
    expect(() => resolveWallTime('2026-10-13T09:00', 'America/Imaginary')).toThrow();
  });
  it('validates each explicit fold occurrence and rejects mismatched or missing offsets', () => {
    const evidence = { localDateTime: '2026-11-01T01:30:00', timeZone: 'America/New_York', offset: '-05:00' };
    expect(() => validateWallTime('2026-11-01T06:30:00.000Z', evidence)).not.toThrow();
    expect(() => validateWallTime('2026-11-01T05:30:00.000Z', { ...evidence, offset: '-04:00' })).not.toThrow();
    expect(() => validateWallTime('2026-11-01T05:30:00.000Z', evidence)).toThrow();
    expect(() => validateWallTime('2026-11-01T06:30:00.000Z', { ...evidence, offset: '' })).toThrow();
    expect(() => validateWallTime('2026-03-08T07:30:00.000Z', { ...evidence, localDateTime: '2026-03-08T02:30:00', offset: '-04:00' })).toThrow();
  });
});

describe('elapsed intervals and company days', () => {
  it('adds 180 elapsed minutes across the spring transition', () => {
    expect(addElapsedMinutes('2026-03-08T06:30:00.000Z', 180)).toBe('2026-03-08T09:30:00.000Z');
  });
  it.each([0, 1.5, NaN, Infinity, 1441])('refuses an invalid preset duration %s', (minutes) => {
    expect(() => addElapsedMinutes('2026-03-08T06:30:00.000Z', minutes)).toThrow();
  });
  it('uses the 23-hour spring company day', () => {
    expect(companyDayBounds('2026-03-08', 'America/New_York')).toEqual({ from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' });
  });
  it('uses the 25-hour autumn company day', () => {
    expect(companyDayBounds('2026-11-01', 'America/New_York')).toEqual({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' });
  });
  it('rejects invalid company dates instead of rolling into the next month', () => {
    expect(() => companyDayBounds('2026-02-30', 'America/New_York')).toThrow();
  });
});

describe('existing elapsed interval shifts', () => {
  it('exports the interval seam through the package entry point', () => {
    expect(typeof shiftElapsedInterval).toBe('function');
  });
  it.each([
    {
      transition: 'spring',
      originalStart: '2026-03-07T12:00:00.125-08:00',
      originalEnd: '2026-03-09T12:00:00.375-07:00',
      newStart: '2026-03-06T12:00:00.125-08:00',
      shiftedEnd: '2026-03-08T19:00:00.375Z',
    },
    {
      transition: 'autumn',
      originalStart: '2026-10-31T12:00:00.125-07:00',
      originalEnd: '2026-11-02T12:00:00.375-08:00',
      newStart: '2026-10-30T12:00:00.125-07:00',
      shiftedEnd: '2026-11-01T20:00:00.375Z',
    },
  ])('preserves the exact multi-day elapsed interval across $transition DST', ({ originalStart, originalEnd, newStart, shiftedEnd }) => {
    expect(shiftElapsedInterval(originalStart, originalEnd, newStart)).toEqual({ startAt: newStart, endAt: shiftedEnd });
  });
  it.each([
    { start: '2026-10-13T12:00:00-07:00', end: '2026-10-16T12:00:00.12-07:00', newStart: '2026-10-13T19:00:00.000Z' },
    { start: '2026-10-13T19:00:00.0+00:00', end: '2026-10-16T19:00:00Z', newStart: '2026-10-13T12:00:00-07:00' },
  ])('retains original wire spellings when the start instant is unchanged: $start', ({ start, end, newStart }) => {
    expect(shiftElapsedInterval(start, end, newStart)).toEqual({ startAt: start, endAt: end });
  });
  it('retains the exact submitted shifted start and a subsecond elapsed interval', () => {
    expect(shiftElapsedInterval('2026-10-13T19:00:00.1Z', '2026-10-13T19:00:00.101Z', '2026-10-14T12:00:00.12-07:00')).toEqual({
      startAt: '2026-10-14T12:00:00.12-07:00', endAt: '2026-10-14T19:00:00.121Z',
    });
  });
  it.each([
    { start: '2026-02-30T12:00:00Z', end: '2026-03-03T12:00:00Z', newStart: '2026-03-04T12:00:00Z', errorType: ZodError },
    { start: '2026-10-13T12:00:00Z', end: '2026-10-15T12:00:00', newStart: '2026-10-14T12:00:00Z', errorType: ZodError },
    { start: '2026-10-13T12:00:00Z', end: '2026-10-15T12:00:00Z', newStart: '2026-10-14T12:00', errorType: ZodError },
    { start: '2026-10-13T12:00:00Z', end: '2026-10-13T12:00:00Z', newStart: '2026-10-13T12:00:00Z', errorType: RangeError },
    { start: '2026-10-13T12:00:00Z', end: '2026-10-13T11:59:59.999Z', newStart: '2026-10-14T12:00:00Z', errorType: RangeError },
    { start: '2026-10-13T12:00:00Z', end: '2026-10-14T12:00:00Z', newStart: '9999-12-31T12:00:00Z', errorType: ZodError },
  ])('rejects unusable or overflowing intervals: $start / $end / $newStart', ({ start, end, newStart, errorType }) => {
    expect(() => shiftElapsedInterval(start, end, newStart)).toThrow(errorType);
  });
  it.each([
    { start: null, end: '2026-10-14T12:00:00Z', newStart: '2026-10-15T12:00:00Z' },
    { start: '2026-10-13T12:00:00Z', end: null, newStart: '2026-10-15T12:00:00Z' },
    { start: '2026-10-13T12:00:00Z', end: '2026-10-14T12:00:00Z', newStart: null },
  ])('does not invent an endpoint from null runtime input: $start / $end / $newStart', ({ start, end, newStart }) => {
    expect(() => shiftElapsedInterval(start!, end!, newStart!)).toThrow(ZodError);
  });
});

describe('scheduling instant wall-time evidence', () => {
  it('exports the formatting seam through the package entry point', () => {
    expect(typeof formatSchedulingWallTime).toBe('function');
  });
  it.each([
    { instant: '2026-07-13T19:45:23.123Z', timeZone: 'America/Los_Angeles', localDateTime: '2026-07-13T12:45:23.123', offset: '-07:00' },
    { instant: '2026-01-13T20:45:23Z', timeZone: 'America/Los_Angeles', localDateTime: '2026-01-13T12:45:23.000', offset: '-08:00' },
    { instant: '2026-07-13T19:45:23.1+00:00', timeZone: 'Europe/London', localDateTime: '2026-07-13T20:45:23.100', offset: '+01:00' },
    { instant: '2026-01-13T20:45:23.123Z', timeZone: 'Europe/London', localDateTime: '2026-01-13T20:45:23.123', offset: '+00:00' },
    { instant: '2026-07-13T19:45:23.123Z', timeZone: 'US/Pacific', localDateTime: '2026-07-13T12:45:23.123', offset: '-07:00' },
    { instant: '1900-01-01T00:00:00.123Z', timeZone: 'Europe/Paris', localDateTime: '1900-01-01T00:09:21.123', offset: '+00:09:21' },
  ])('formats actual company wall time and offset in $timeZone for $instant', ({ instant, timeZone, localDateTime, offset }) => {
    const evidence = formatSchedulingWallTime(instant, timeZone);
    expect(evidence).toEqual({ localDateTime, offset, timeZone });
    expect(() => validateWallTime(instant, evidence)).not.toThrow();
  });
  it.each([
    { timeZone: 'America/Los_Angeles', localDateTime: '2026-11-01T01:30:00.123', earlier: '2026-11-01T08:30:00.123Z', earlierOffset: '-07:00', later: '2026-11-01T09:30:00.123Z', laterOffset: '-08:00' },
    { timeZone: 'Europe/London', localDateTime: '2026-10-25T01:30:00.123', earlier: '2026-10-25T00:30:00.123Z', earlierOffset: '+01:00', later: '2026-10-25T01:30:00.123Z', laterOffset: '+00:00' },
  ])('retains and roundtrips both DST overlap occurrences in $timeZone', ({ timeZone, localDateTime, earlier, earlierOffset, later, laterOffset }) => {
    const first = formatSchedulingWallTime(earlier, timeZone);
    const second = formatSchedulingWallTime(later, timeZone);
    expect(first).toEqual({ localDateTime, offset: earlierOffset, timeZone });
    expect(second).toEqual({ localDateTime, offset: laterOffset, timeZone });
    expect(resolveWallTime(first.localDateTime, first.timeZone)).toEqual({ kind: 'ambiguous', choices: [
      { instant: earlier, offset: earlierOffset }, { instant: later, offset: laterOffset },
    ] });
    expect(() => validateWallTime(earlier, first)).not.toThrow();
    expect(() => validateWallTime(later, second)).not.toThrow();
    expect(() => validateWallTime(earlier, second)).toThrow();
  });
  it.each([
    { instant: '2026-03-08T09:30:00.000Z', timeZone: 'America/Los_Angeles', localDateTime: '2026-03-08T01:30:00.000', offset: '-08:00' },
    { instant: '2026-03-08T10:30:00.000Z', timeZone: 'America/Los_Angeles', localDateTime: '2026-03-08T03:30:00.000', offset: '-07:00' },
    { instant: '2026-03-29T00:30:00.000Z', timeZone: 'Europe/London', localDateTime: '2026-03-29T00:30:00.000', offset: '+00:00' },
    { instant: '2026-03-29T01:30:00.000Z', timeZone: 'Europe/London', localDateTime: '2026-03-29T02:30:00.000', offset: '+01:00' },
  ])('never emits a local spring gap from an actual instant in $timeZone: $instant', ({ instant, timeZone, localDateTime, offset }) => {
    const evidence = formatSchedulingWallTime(instant, timeZone);
    expect(evidence).toEqual({ localDateTime, offset, timeZone });
    expect(resolveWallTime(evidence.localDateTime, evidence.timeZone)).toEqual({ kind: 'unique', choices: [{ instant, offset }] });
  });
  it.each([
    { instant: '2026-02-30T12:00:00Z', timeZone: 'Europe/London' },
    { instant: '2026-10-13T12:00:00', timeZone: 'Europe/London' },
    { instant: '2026-10-13T12:00:00Z', timeZone: 'America/Imaginary' },
    { instant: '2026-10-13T12:00:00Z', timeZone: '+01:00' },
    { instant: '9999-12-31T23:59:59.999Z', timeZone: 'Asia/Tokyo' },
  ])('refuses invalid instant, zone or wall-range overflow: $instant / $timeZone', ({ instant, timeZone }) => {
    expect(() => formatSchedulingWallTime(instant, timeZone)).toThrow(ZodError);
  });
});
