import { describe, expect, it } from 'vitest';
import { addElapsedMinutes, companyDayBounds, resolveWallTime, validateWallTime } from './index';

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
