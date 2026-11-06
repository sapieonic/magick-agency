/**
 * The customer-history timeline's keyset cursor (`docs/customer-history.md` §4 "Paging").
 *
 * A LEAF: no I/O. `next_cursor` is an opaque base64url of `{ at, key }`: `at` is the last entry's
 * ordering instant at MICROSECOND precision (as `keysetAtSql` renders it, so the cursor never
 * floors a timestamp and skips rows inside the cut millisecond), `key` its `<kind>:<id>`. The
 * page after it is every entry strictly after it in the order `at DESC, key DESC`.
 *
 * `decodeTimelineCursor` answers null for anything this server did not mint; the route answers
 * `400 invalid_cursor` on null, never "page one again" (that would read as duplicate rows).
 */
import { CUSTOMER_TIMELINE_KINDS } from '@magick-agency/contracts/api/agency/customer-history';

export interface TimelinePosition {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ` (microseconds, UTC). */
  at: string;
  /** `<kind>:<uuid>`. */
  key: string;
}

const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const KEY_RE = new RegExp(
  `^(${CUSTOMER_TIMELINE_KINDS.join('|')}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);
/** Longer than any cursor this server mints; a guard on what is decoded. */
const MAX_CURSOR_LENGTH = 512;

/** A real calendar instant (`2026-02-30` rolls over in JS and is refused by the comparison). */
function isRealInstant(at: string): boolean {
  const seconds = `${at.slice(0, 19)}Z`;
  const parsed = new Date(seconds);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 1) return false;
  return parsed.toISOString().slice(0, 19) === at.slice(0, 19);
}

export function encodeTimelineCursor(position: TimelinePosition): string {
  return Buffer.from(JSON.stringify({ at: position.at, key: position.key }), 'utf8').toString('base64url');
}

export function decodeTimelineCursor(raw: unknown): TimelinePosition | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { at, key } = parsed as Record<string, unknown>;
  if (typeof at !== 'string' || !AT_RE.test(at) || !isRealInstant(at)) return null;
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  return { at, key };
}

/**
 * The order: `at DESC, key DESC`. Both are compared as strings by code unit: `at` is fixed-width
 * (so string order is time order) and `key` is ASCII.
 */
export function compareTimeline(a: TimelinePosition, b: TimelinePosition): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.key !== b.key) return a.key < b.key ? 1 : -1;
  return 0;
}

/** Whether `entry` comes strictly after `cursor` in the timeline order. */
export function isAfter(entry: TimelinePosition, cursor: TimelinePosition): boolean {
  return compareTimeline(entry, cursor) > 0;
}

/** An ISO instant (millisecond or coarser) as the microsecond form `at` is compared in. */
export function toMicroInstant(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 23)}000Z`;
}

/** A microsecond `at` as the wire's millisecond ISO string. */
export function toWireInstant(at: string): string {
  return `${at.slice(0, 23)}Z`;
}
