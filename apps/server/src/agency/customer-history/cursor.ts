/**
 * The customer-history timeline's keyset cursor (`docs/customer-history.md` §4 "Paging").
 *
 * A LEAF: no I/O. `next_cursor` is an opaque base64url of `{ at, key }`: `at` is the last entry's
 * ordering instant at MICROSECOND precision (as `keysetAtSql` renders it, so the cursor never
 * floors a timestamp and skips rows inside the cut millisecond), `key` its `<kind>:<id>`. The
 * page after it is every entry strictly after it in the order `at DESC, key DESC`, read in SQL
 * per source (`sourceBound` in `./assemble.ts`).
 *
 * `decodeTimelineCursor` answers null for anything this server did not mint; the route answers
 * `400 invalid_cursor` on null, never "page one again" (that would read as duplicate rows).
 */
import { CUSTOMER_TIMELINE_KINDS } from '@magick-agency/contracts/api/agency/customer-history';
import { isRealCalendarInstant } from '@magick-agency/domain/keyset-cursor';
import { UUID_RE } from '../../utils/uuid.js';

export interface TimelinePosition {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ` (microseconds, UTC). */
  at: string;
  /** `<kind>:<uuid>`. */
  key: string;
}

const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** `<kind>:<uuid>`, the UUID lower-case as minted (`UUID_RE`'s pattern without its `i` flag). */
const KEY_RE = new RegExp(`^(${CUSTOMER_TIMELINE_KINDS.join('|')}):${UUID_RE.source.slice(1, -1)}$`);
/** Longer than any cursor this server mints; a guard on what is decoded. */
const MAX_CURSOR_LENGTH = 512;

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
  if (typeof at !== 'string' || !AT_RE.test(at) || !isRealCalendarInstant(at)) return null;
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

/** A microsecond `at` as the wire's millisecond ISO string. */
export function toWireInstant(at: string): string {
  return `${at.slice(0, 23)}Z`;
}
