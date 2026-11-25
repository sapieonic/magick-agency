import { describe, it, expect } from 'vitest';
import { XlsxStartCap, XLSX_STARTS_PER_USER, XLSX_STARTS_WINDOW_MS } from '../../../src/agency/agency-xlsx-start-cap.js';

/*
 * The per-user cap on Excel conversions (IM8, `agency-xlsx-start-cap.ts`): ten starts per
 * user in any fifteen minutes, sliding, so one supervisor cannot keep the one conversion slot.
 * The route's use of it (the 429 before the body is read) is in
 * `proxy-agency-campaigns.upload-xlsx-limits.test.ts`.
 */

function capAt(start = 1_000_000): { cap: XlsxStartCap; advance: (ms: number) => void } {
  let now = start;
  return { cap: new XlsxStartCap(XLSX_STARTS_PER_USER, XLSX_STARTS_WINDOW_MS, () => now), advance: (ms) => { now += ms; } };
}

describe('XlsxStartCap', () => {
  it('is ten starts per user in fifteen minutes', () => {
    expect(XLSX_STARTS_PER_USER).toBe(10);
    expect(XLSX_STARTS_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('lets a user start ten, then says when the oldest leaves the window', () => {
    const { cap, advance } = capAt();
    for (let i = 0; i < 10; i++) {
      expect(cap.retryAfterSeconds('u1')).toBe(0);
      cap.record('u1');
      advance(60_000);
    }
    // Ten minutes on: the first start leaves the window five minutes from now.
    expect(cap.retryAfterSeconds('u1')).toBe(5 * 60);
    advance(5 * 60 * 1000 - 1_500);
    expect(cap.retryAfterSeconds('u1')).toBe(2);
    advance(1_500);
    expect(cap.retryAfterSeconds('u1')).toBe(0);
    cap.record('u1');
    // The second start (a minute after the first) leaves next.
    expect(cap.retryAfterSeconds('u1')).toBe(60);
  });

  it('counts each user on their own', () => {
    const { cap } = capAt();
    for (let i = 0; i < 10; i++) cap.record('u1');
    expect(cap.retryAfterSeconds('u1')).toBeGreaterThan(0);
    expect(cap.retryAfterSeconds('u2')).toBe(0);
  });

  it('forgets users whose starts have all left the window', () => {
    const { cap, advance } = capAt();
    cap.record('u1');
    cap.record('u2');
    advance(XLSX_STARTS_WINDOW_MS);
    cap.record('u3');
    expect(cap.size).toBe(1);
  });
});
