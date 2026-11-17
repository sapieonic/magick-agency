import { describe, expect, it } from 'vitest';
import { countLeg, type LegCounts } from '../../../helpers/listen-client.js';

/** The integration suites' listener counts each leg by its tag byte (`test/helpers/listen-client.ts`). */
describe('countLeg', () => {
  it('counts a 161-byte message by its tag; any other length or tag is odd', () => {
    const legs: LegCounts = { customer: 0, agent: 0, odd: 0 };
    const msg = (tag: number, len = 161) => { const b = Buffer.alloc(len); b[0] = tag; return b; };
    expect(countLeg(legs, msg(1))).toBe('customer');
    expect(countLeg(legs, msg(2))).toBe('agent');
    expect(countLeg(legs, msg(3))).toBe('odd');
    expect(countLeg(legs, msg(1, 160))).toBe('odd');
    expect(legs).toEqual({ customer: 1, agent: 1, odd: 2 });
  });
});
