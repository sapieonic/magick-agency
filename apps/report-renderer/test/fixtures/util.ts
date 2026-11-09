/**
 * Helpers the fixture builders share: a seeded random source (so every run draws the same
 * figures), integer splitting that keeps sums exact, local-time arithmetic for fixed-offset
 * zones, and the gzipped NDJSON writer the detail files use.
 */
import { gzipSync } from 'node:zlib';

/** mulberry32: a small seeded PRNG, so fixtures are identical on every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in `[min, max]`. */
export function between(rnd: () => number, min: number, max: number): number {
  return Math.floor(min + rnd() * (max - min + 1));
}

/** Pick by weight. */
export function weighted<T>(rnd: () => number, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r < 0) return item;
  }
  return items[items.length - 1]![0];
}

/** Split `total` into integer parts by weight (largest remainder), so the parts sum exactly. */
export function splitInt(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/** The local calendar days from `from` for `days` days, as `YYYY-MM-DD`. */
export function localDays(from: string, days: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/** ISO weekday of a `YYYY-MM-DD`, Monday 1 … Sunday 7. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The instant of `hours` (fractional) after local midnight of `date`, in a fixed-offset zone. */
export function localInstant(date: string, hours: number, offsetMinutes: number): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) + hours * 3_600_000 - offsetMinutes * 60_000);
}

export function iso(d: Date | number): string {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const KOLKATA_OFFSET = 330;
export const DUBAI_OFFSET = 240;

/** A gzipped NDJSON detail file: one JSON array per line. */
export function ndjsonGz(rows: ReadonlyArray<readonly unknown[]>): Buffer {
  return gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8'));
}

/** A phone number shown in full (supervisor) or masked to its last four digits (self, RP7). */
export function phone(rnd: () => number, masked: boolean): string {
  const digits = `9${between(rnd, 100000000, 999999999)}`;
  return masked ? `••••••${digits.slice(-4)}` : `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/** Percentile with linear interpolation, null on an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Number((s[lo]! + (s[hi]! - s[lo]!) * (idx - lo)).toFixed(2));
}

export function round1(v: number): number {
  return Number(v.toFixed(1));
}
