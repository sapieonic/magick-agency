/**
 * The range reads' query (`activity`, `trends`, `health`): what a request may ask for, what it is
 * served, and how a range names itself in the cache. Pure. Part of `src/agency/insights/`
 * (docs/insights.md "API (range reads)").
 *
 * ── What is accepted ─────────────────────────────────────────────────────────
 *  - `from`, `to`: ISO-8601 instants WITH a zone (`Z` or `±HH:MM`), half-open `[from, to)`. A
 *    bare date or a wall-clock time has no instant until a zone is chosen, and the server will not
 *    guess one, so they are refused. Both absent: the lifetime. One alone: the other keeps its
 *    default (`from` the campaign's `created_at`, `to` now).
 *  - `bucket` (trends only): one of `AGENCY_INSIGHTS_BUCKETS`; absent, `hour` for a range of up
 *    to {@link HOURLY_DEFAULT_MAX_HOURS} hours and `day` beyond (the console's own default).
 *  - Nothing else. An unknown key, a repeated key, a `bucket` on a read that takes none, an
 *    inverted range, a range that starts in the future, a range wider than
 *    `AGENCY_INSIGHTS_MAX_RANGE_DAYS` calendar days, or a series of more than
 *    {@link INSIGHTS_MAX_TREND_BUCKETS} buckets is refused with a message saying which.
 *
 * ── What is served ───────────────────────────────────────────────────────────
 * The rollup is kept in 15-minute buckets (`INSIGHTS_BUCKET_MINUTES`) and cannot cut inside one,
 * so the range is widened to whole buckets: `from` rounded DOWN, `to` rounded UP (the bucket a
 * mid-bucket `to` falls in is in the range, as the rollup reads would count it anyway), and `to`
 * never past the bucket now falls in (the future holds no dials, and a row of future zeros reads
 * as a campaign that stopped). The response echoes this range, so the page states what it shows.
 * Every zone's offset is a multiple of 15 minutes, so a local midnight is already a boundary and a
 * day range from the console is served exactly as asked.
 *
 * The width limit is checked on the range as ASKED: 92 calendar days in a zone that changes its
 * clocks in them are 92 × 24 h plus or minus an hour, so the limit allows that hour
 * ({@link RANGE_LIMIT_MS}). The lifetime is never refused for its length: it is the page's
 * default, and a campaign older than 92 days still has one. Its cost is the rollup's (a sum of
 * buckets) plus the reads that are not the rollup, which scale with what happened in it.
 */
import {
  AGENCY_INSIGHTS_BUCKETS,
  AGENCY_INSIGHTS_MAX_RANGE_DAYS,
  type AgencyInsightsBucket,
  type AgencyInsightsRange,
} from '@magick-agency/contracts/api/agency/insights';
import { INSIGHTS_BUCKET_MINUTES } from '../../db/repositories/agency/insights-rollup-sql.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const INSIGHTS_BUCKET_MS = INSIGHTS_BUCKET_MINUTES * MINUTE_MS;

/** The widest range asked for: the contract's days, plus the hour a clock change can add to them. */
export const RANGE_LIMIT_MS = AGENCY_INSIGHTS_MAX_RANGE_DAYS * DAY_MS + HOUR_MS;

/** The longest trend series: the widest range in the narrowest bucket (92 days of quarter hours). */
export const INSIGHTS_MAX_TREND_BUCKETS = AGENCY_INSIGHTS_MAX_RANGE_DAYS * (DAY_MS / INSIGHTS_BUCKET_MS);

/** Up to this many hours the default bucket is `hour`; beyond, `day`. */
export const HOURLY_DEFAULT_MAX_HOURS = 48;

const BUCKET_MS: Record<AgencyInsightsBucket, number> = { quarter_hour: INSIGHTS_BUCKET_MS, hour: HOUR_MS, day: DAY_MS };

/** The range a read is served. */
export interface ServedInsightsRange {
  /** Inclusive, on a bucket boundary. */
  from: Date;
  /** Exclusive, on a bucket boundary. */
  to: Date;
  /** Neither bound was given. */
  lifetime: boolean;
  /** The trend bucket (`trends` only; null for the other reads). */
  bucket: AgencyInsightsBucket | null;
}

export type InsightsRangeParse = { ok: true; range: ServedInsightsRange } | { ok: false; message: string };

/** `YYYY-MM-DDTHH:MM[:SS[.fff…]](Z|±HH:MM)`. */
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * An ISO-8601 instant, or null. `Date.parse` alone is not enough: it rolls `2026-02-30` over to
 * 2 March, so the wall-clock fields are checked to survive the round trip.
 */
export function parseInstant(text: string): Date | null {
  const m = INSTANT_RE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, , zone] = m;
  const fields = [Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s ?? '0')] as const;
  const wall = new Date(Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]));
  if (wall.getUTCFullYear() !== fields[0] || wall.getUTCMonth() !== fields[1] - 1 || wall.getUTCDate() !== fields[2]
    || wall.getUTCHours() !== fields[3] || wall.getUTCMinutes() !== fields[4] || wall.getUTCSeconds() !== fields[5]) {
    return null;
  }
  if (zone !== 'Z') {
    const [zh, zm] = zone!.slice(1).split(':').map(Number) as [number, number];
    if (zh > 23 || zm > 59) return null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Down to the bucket `at` falls in. Buckets are counted from the epoch, as `date_bin` from 2000-01-01 counts them. */
export function floorToBucket(at: Date): Date {
  const ms = at.getTime();
  return new Date(ms - (((ms % INSIGHTS_BUCKET_MS) + INSIGHTS_BUCKET_MS) % INSIGHTS_BUCKET_MS));
}

/** Up to the next boundary (an instant on one stays). */
export function ceilToBucket(at: Date): Date {
  const floor = floorToBucket(at);
  return floor.getTime() === at.getTime() ? floor : new Date(floor.getTime() + INSIGHTS_BUCKET_MS);
}

/** The default bucket for a span (the console's `defaultBucket`). */
export function defaultBucketFor(spanMs: number): AgencyInsightsBucket {
  return spanMs <= HOURLY_DEFAULT_MAX_HOURS * HOUR_MS ? 'hour' : 'day';
}

/** How many buckets of `bucket` a span cuts into (a day bucket is counted as 24 h: within one of the local count). */
export function trendBucketCount(spanMs: number, bucket: AgencyInsightsBucket): number {
  return Math.ceil(spanMs / BUCKET_MS[bucket]) + (bucket === 'quarter_hour' ? 0 : 1);
}

/**
 * The served range for a request's query, or the reason it is refused.
 *
 * @param query    Fastify's parsed query (`request.query`).
 * @param opts.createdAt the campaign's `created_at`: the lifetime's start.
 * @param opts.now   the request's clock.
 * @param opts.bucket whether this read takes `bucket` (trends).
 */
export function parseInsightsRange(
  query: unknown,
  opts: { createdAt: Date; now: Date; bucket: boolean },
): InsightsRangeParse {
  const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  const allowed = opts.bucket ? ['from', 'to', 'bucket'] : ['from', 'to'];
  for (const key of Object.keys(q)) {
    if (!allowed.includes(key)) {
      return { ok: false, message: key === 'bucket' ? 'This read takes no bucket.' : `Unknown parameter: ${key}.` };
    }
    if (typeof q[key] !== 'string') return { ok: false, message: `${key} must be given once.` };
  }
  const fromText = q['from'] as string | undefined;
  const toText = q['to'] as string | undefined;
  const from = fromText === undefined ? null : parseInstant(fromText);
  const to = toText === undefined ? null : parseInstant(toText);
  if (fromText !== undefined && !from) return { ok: false, message: 'from must be an ISO-8601 instant with a zone, e.g. 2026-11-03T18:30:00Z.' };
  if (toText !== undefined && !to) return { ok: false, message: 'to must be an ISO-8601 instant with a zone, e.g. 2026-11-04T18:30:00Z.' };

  const lifetime = from === null && to === null;
  const nowBucketEnd = ceilToBucket(opts.now);
  const askedFrom = from ?? opts.createdAt;
  const askedTo = to ?? opts.now;
  if (!lifetime) {
    if (askedFrom.getTime() >= askedTo.getTime()) return { ok: false, message: 'from must be before to.' };
    if (askedFrom.getTime() >= opts.now.getTime()) return { ok: false, message: 'The range starts in the future.' };
    if (askedTo.getTime() - askedFrom.getTime() > RANGE_LIMIT_MS) {
      return { ok: false, message: `A range can cover at most ${AGENCY_INSIGHTS_MAX_RANGE_DAYS} days.` };
    }
  }

  const servedFrom = floorToBucket(askedFrom);
  const ceiled = ceilToBucket(askedTo);
  // At least one bucket: a lifetime read the instant a campaign is created still has one.
  const servedTo = new Date(Math.max(
    Math.min(ceiled.getTime(), nowBucketEnd.getTime()),
    servedFrom.getTime() + INSIGHTS_BUCKET_MS,
  ));
  const span = servedTo.getTime() - servedFrom.getTime();

  let bucket: AgencyInsightsBucket | null = null;
  if (opts.bucket) {
    const asked = q['bucket'] as string | undefined;
    if (asked !== undefined && !(AGENCY_INSIGHTS_BUCKETS as readonly string[]).includes(asked)) {
      return { ok: false, message: `bucket must be one of ${AGENCY_INSIGHTS_BUCKETS.join(', ')}.` };
    }
    bucket = (asked as AgencyInsightsBucket | undefined) ?? defaultBucketFor(span);
    if (trendBucketCount(span, bucket) > INSIGHTS_MAX_TREND_BUCKETS) {
      return { ok: false, message: `That range has more than ${INSIGHTS_MAX_TREND_BUCKETS} ${bucket.replace('_', ' ')} buckets: choose a wider bucket.` };
    }
  }
  return { ok: true, range: { from: servedFrom, to: servedTo, lifetime, bucket } };
}

/** The cache key suffix that names a served range (and bucket). */
export function rangeCacheSuffix(range: ServedInsightsRange): string {
  return `${range.from.toISOString()}:${range.to.toISOString()}:${range.bucket ?? '-'}`;
}

/**
 * The campaign's zone for the page: its own name when the runtime knows it, else UTC (a name is
 * validated at write; this is the read-side fallback the rollup reads' SQL also takes).
 */
export function campaignZone(zone: string | null | undefined): string {
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/** The wire's `range`. */
export function rangeWire(range: ServedInsightsRange, timezone: string): AgencyInsightsRange {
  return { from: range.from.toISOString(), to: range.to.toISOString(), lifetime: range.lifetime, timezone };
}
