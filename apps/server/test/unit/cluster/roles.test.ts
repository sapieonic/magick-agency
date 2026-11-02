import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { processIdentityFromEnv, slotFor } from '../../../src/cluster/roles.js';

describe('processIdentityFromEnv', () => {
  it('is the main process when no role is set', () => {
    expect(processIdentityFromEnv({})).toEqual({ kind: 'main' });
    expect(processIdentityFromEnv({ MA_PROCESS_ROLE: '' })).toEqual({ kind: 'main' });
  });

  it('reads a child role and slot', () => {
    expect(processIdentityFromEnv({ MA_PROCESS_ROLE: 'analysis', MA_WORKER_SLOT: '0' }))
      .toEqual({ kind: 'child', role: 'analysis', slot: 0 });
    expect(processIdentityFromEnv({ MA_PROCESS_ROLE: 'media', MA_WORKER_SLOT: '3' }))
      .toEqual({ kind: 'child', role: 'media', slot: 3 });
  });

  it('refuses a role it does not know, or a child without a valid slot', () => {
    expect(() => processIdentityFromEnv({ MA_PROCESS_ROLE: 'pacing', MA_WORKER_SLOT: '0' })).toThrow(/MA_PROCESS_ROLE/);
    expect(() => processIdentityFromEnv({ MA_PROCESS_ROLE: 'analysis' })).toThrow(/MA_WORKER_SLOT/);
    for (const bad of ['-1', '1.5', 'x', '', '99999']) {
      expect(() => processIdentityFromEnv({ MA_PROCESS_ROLE: 'analysis', MA_WORKER_SLOT: bad })).toThrow(/MA_WORKER_SLOT/);
    }
  });
});

describe('slotFor', () => {
  it('is deterministic and in range', () => {
    const id = randomUUID();
    for (const n of [1, 2, 3, 7]) {
      const s = slotFor(id, n);
      expect(s).toBe(slotFor(id, n));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(n);
    }
    expect(slotFor(id, 1)).toBe(0);
  });

  it('spreads session ids evenly: every slot within ±10% of its share over 10 000 ids', () => {
    for (const n of [2, 3, 4]) {
      const counts = new Array<number>(n).fill(0);
      for (let i = 0; i < 10_000; i++) counts[slotFor(randomUUID(), n)]!++;
      const share = 10_000 / n;
      for (const c of counts) expect(Math.abs(c - share) / share).toBeLessThan(0.1);
    }
  });

  it('refuses a slot count that is not a positive integer', () => {
    expect(() => slotFor('x', 0)).toThrow(RangeError);
    expect(() => slotFor('x', 1.5)).toThrow(RangeError);
  });

  it('pins the hash, so the owner of a session never moves between releases', () => {
    // FNV-1a 32-bit of fixed strings: changing the function would move every live agent.
    expect(slotFor('', 1_000_003)).toBe(0x811c9dc5 % 1_000_003);
    expect(slotFor('a', 4_294_967_291)).toBe(0xe40c292c % 4_294_967_291);
  });
});
