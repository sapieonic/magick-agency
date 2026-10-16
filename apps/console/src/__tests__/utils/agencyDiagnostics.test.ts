import { describe, it, expect } from 'vitest';
import { DiagnosticsLog, DIAGNOSTIC_LIMIT, type DiagnosticEntry } from '../../utils/agencyDiagnostics';

const entry = (n: number): DiagnosticEntry => ({ at: n, attemptId: null, event: `e${n}`, detail: '' });

describe('DiagnosticsLog — a bounded buffer that costs no render', () => {
  it('appends in order, oldest first', () => {
    const log = new DiagnosticsLog();
    log.push(entry(1));
    log.push(entry(2));
    expect(log.entries.map((e) => e.event)).toEqual(['e1', 'e2']);
  });

  it('keeps ONE array for its whole life, so a reader holding it reads the present', () => {
    // The station hands `entries` out once; a consumer that kept the array from an
    // earlier render must still see entries appended after it.
    const log = new DiagnosticsLog();
    const held = log.entries;
    for (let i = 1; i <= DIAGNOSTIC_LIMIT + 5; i += 1) log.push(entry(i));
    expect(log.entries).toBe(held);
    expect(held.at(-1)?.event).toBe(`e${DIAGNOSTIC_LIMIT + 5}`);
  });

  it('drops the oldest past the limit, and never grows beyond it', () => {
    const log = new DiagnosticsLog(3);
    for (let i = 1; i <= 5; i += 1) log.push(entry(i));
    expect(log.entries.map((e) => e.event)).toEqual(['e3', 'e4', 'e5']);
  });

  it('is bounded at 200 by default — an eight-hour shift cannot grow it', () => {
    const log = new DiagnosticsLog();
    for (let i = 0; i < DIAGNOSTIC_LIMIT * 3; i += 1) log.push(entry(i));
    expect(DIAGNOSTIC_LIMIT).toBe(200);
    expect(log.entries).toHaveLength(DIAGNOSTIC_LIMIT);
    expect(log.entries[0]?.at).toBe(DIAGNOSTIC_LIMIT * 2);
  });
});
