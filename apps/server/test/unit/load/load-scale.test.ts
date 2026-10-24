import { describe, expect, it } from 'vitest';
import { createRng, scaled } from '../../helpers/load-scale.js';

describe('load-scale helpers', () => {
  it('the PRNG is deterministic for a seed and differs across seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    const seqC = Array.from({ length: 50 }, () => c.next());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('int stays inclusive within bounds and shuffle is a permutation', () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const n = rng.int(3, 6);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(rng.shuffle(items).sort((x, y) => x - y)).toEqual(items);
  });

  it('scaled never drops below 1', () => {
    expect(scaled(0)).toBe(1);
    expect(scaled(10)).toBeGreaterThanOrEqual(1);
  });
});
