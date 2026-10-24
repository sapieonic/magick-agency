/**
 * Knobs shared by the load, soak and scenario suites.
 *
 * Every load test runs at a modest default size so the ordinary `pnpm test` and
 * `pnpm test:integration` runs stay fast and deterministic. `LOAD_SCALE` multiplies
 * those sizes for a deliberate soak on a quiet machine:
 *
 *   LOAD_SCALE=10 pnpm vitest run test/unit/load
 *
 * `LOAD_SEED` pins the PRNG so a red run is reproducible from the seed the test
 * printed; unset, the seed is fixed (not time-based), so CI runs are identical.
 */

function readScale(): number {
  const raw = process.env['LOAD_SCALE'];
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`LOAD_SCALE must be a positive number, got "${raw}"`);
  return n;
}

export const LOAD_SCALE = readScale();

/** `base` scaled by `LOAD_SCALE`, rounded, never below 1. */
export function scaled(base: number): number {
  return Math.max(1, Math.round(base * LOAD_SCALE));
}

export const LOAD_SEED = Number(process.env['LOAD_SEED'] ?? 0x5eed);

/** A seeded PRNG (mulberry32): `next()` is uniform in [0, 1). */
export interface Rng {
  readonly seed: number;
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A Fisher-Yates shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number = LOAD_SEED): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    seed,
    next,
    int,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick from an empty list');
      return items[int(0, items.length - 1)]!;
    },
    chance: (p) => next() < p,
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
