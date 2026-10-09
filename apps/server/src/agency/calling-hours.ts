import type { AgencyCampaignRecord, AgencyContactRecord } from '../db/models/agency.model.js';

/**
 * ─── AGENCY DIALER — CALLING HOURS, IN THE CUSTOMER'S TIMEZONE ────
 *
 * **The window is evaluated in the CONTACT's timezone, not the campaign's and not
 * the server's.** A campaign configured 09:00–20:00 running from an ap-south-1
 * replica against a roster of US numbers would otherwise dial at 03:30 local, and
 * the config would look correct on every screen.
 *
 * The contact's zone comes from a **mapped CSV column only** and is never
 * inferred from the area code (NANP prefixes cross zone boundaries and number
 * portability decoupled prefix from location); absent or unusable, the campaign
 * default applies. That fallback is an honest default, not an inference.
 *
 * Pure and total. `now` is a parameter rather than an ambient `new Date()` because
 * a clock-derived instant cannot be asserted with an exact value otherwise,
 * and **nothing here throws** — a bad timezone string arrives from a customer CSV,
 * and a `RangeError` escaping into the pacing tick would take the whole campaign
 * down rather than the one contact. Unusable input is reported as `unresolvable`,
 * which the gate turns into "do not dial", never into "dial".
 *
 * ── `calling_days` is ISO-8601: 1=Mon … 7=Sun. `0` is REJECTED ───────────────
 *
 * The column's default `'{1,2,3,4,5}'` is Mon–Fri under **both** Postgres `dow`
 * (0=Sun…6=Sat) and `isodow` (1=Mon…7=Sun), so the ambiguity is undetectable by
 * testing the default and would surface as an off-by-one on Sundays months later.
 * It is fixed here as ISO-8601, and `0` is rejected rather than read as Sunday:
 * a caller sending `0` believes `dow`, so accepting it means we and they disagree
 * about which days the campaign runs. The campaign-config validator and the
 * console's day picker follow this one definition.
 */

/** Everything the window predicate needs, resolved. */
export interface CallingWindow {
  /** `HH:MM` or `HH:MM:SS` — Postgres renders a `TIME` column as the latter. */
  start: string;
  end: string;
  /** ISO-8601 day numbers, 1=Mon…7=Sun. */
  days: number[];
  /** IANA zone the window is evaluated in. */
  timezone: string;
}

/**
 * `unresolvable` is deliberately NOT folded into `closed`.
 *
 * Both stop this dial, but they mean different things and the caller treats them
 * differently: `closed` has a computable next-open instant to defer the contact
 * to, while `unresolvable` has none — there is no answer to "when does a campaign
 * with an unparseable timezone next open". Collapsing them would have the gate
 * invent a next-open instant from a window it could not read.
 */
export type CallingWindowState = 'open' | 'closed' | 'unresolvable';

export type TimezoneSource = 'contact' | 'campaign_default';

/** Which zone applies to this contact, and where it came from. */
export interface ResolvedCallingWindow extends CallingWindow {
  timezoneSource: TimezoneSource;
  /**
   * True when the contact carried a timezone we could not use and the campaign
   * default was substituted. Worth logging: it means an ingest mapping is
   * producing junk, and the symptom otherwise is calls at the wrong local time
   * for one slice of a roster.
   */
  contactTimezoneRejected: boolean;
}

/**
 * `Intl.DateTimeFormat` construction is not free and the tick asks per contact,
 * so formatters are cached per zone — including the **negative** result, so a
 * roster with a thousand rows carrying the same junk zone pays one `RangeError`
 * rather than a thousand.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  if (FORMATTERS.has(timezone)) return FORMATTERS.get(timezone) ?? null;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      // `hourCycle` rather than `hour12: false`, which yields hour '24' at
      // midnight in some ICU builds and would put midnight on the wrong day.
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    fmt = null;
  }
  FORMATTERS.set(timezone, fmt);
  return fmt;
}

/**
 * Is this string a zone we are willing to evaluate a calling window in?
 *
 * **Stricter than `Intl` accepts, and the extra rule is load-bearing.** ICU
 * resolves bare abbreviations to fixed-offset zones, measured on this runtime:
 * `'EST'` → **America/Panama**, which is EST all year and observes no DST, so a
 * CSV column saying `EST` would place every call an hour off for half the year —
 * on the daylight side, i.e. an hour earlier in the customer's morning than the
 * operator configured. `'IST'` → Asia/Calcutta (harmlessly right) and `'GMT'` →
 * UTC (right by luck); the rule cannot tell those from the dangerous one, and the
 * timezone rule above already settled which way to fail: *"an inferred timezone that puts a call
 * outside legal hours is worse than an honest default."*
 *
 * So we require the `Area/Location` form, or exactly `UTC`. Everything else falls
 * back to the campaign default and is flagged. A handful of legitimate legacy
 * IANA links (`Japan`, `Cuba`, `EST5EDT`) are refused by this rule too; they fall
 * back to an honest default rather than a wrong offset, which is the trade.
 */
export function isUsableTimezone(timezone: string | null | undefined): boolean {
  if (typeof timezone !== 'string') return false;
  const trimmed = timezone.trim();
  if (trimmed === '') return false;
  if (!trimmed.includes('/') && trimmed.toUpperCase() !== 'UTC') return false;
  return formatterFor(trimmed) !== null;
}

interface LocalParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  /** ISO-8601: 1=Mon…7=Sun. */
  isoDow: number;
}

/** The wall clock in `timezone` at `instant`, or null when the zone is unusable. */
function localParts(timezone: string, instant: Date): LocalParts | null {
  const fmt = formatterFor(timezone);
  if (!fmt || !Number.isFinite(instant.getTime())) return null;
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type === 'literal') continue;
    const n = Number(part.value);
    if (!Number.isFinite(n)) return null;
    out[part.type] = n;
  }
  const { year, month, day, hour, minute, second } = out;
  if ([year, month, day, hour, minute, second].some((v) => v === undefined)) return null;
  return {
    year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second!,
    isoDow: isoDowOf(year!, month!, day!),
  };
}

/**
 * Day of week for a calendar date, from UTC arithmetic rather than from a
 * localized weekday string — `formatToParts` weekday names are locale data and
 * comparing them would make the predicate depend on the ICU bundle.
 */
function isoDowOf(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

/**
 * `HH:MM[:SS]` → seconds since local midnight, or null.
 *
 * **`24:00:00` is accepted and means end-of-day (86400).** Postgres' own `TIME`
 * type permits it, and it is the only way to express a window that is open all
 * day: `23:59:59` leaves a one-second hole at the end of every day, which as a
 * campaign configuration is a rounding error and as a test fixture is a flake that
 * fires once per day and looks like anything but a clock.
 */
function parseTimeOfDay(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] === undefined ? 0 : Number(m[3]);
  if (h === 24) return mi === 0 && s === 0 ? 86_400 : null;
  if (h > 23 || mi > 59 || s > 59) return null;
  return h * 3600 + mi * 60 + s;
}

/**
 * Validate `calling_days` as ISO-8601 day numbers. Null ⇒ the array is not
 * something we can honour, which is `unresolvable` rather than "every day".
 *
 * An empty array is VALID and means no day is dialable. It is not silently
 * widened to "all days": an operator who cleared the picker has said not to dial,
 * and reading that as seven days would dial a whole roster on a misconfiguration.
 */
function normalizeDays(days: unknown): number[] | null {
  if (!Array.isArray(days)) return null;
  const out = new Set<number>();
  for (const d of days) {
    const n = Number(d);
    // 0 is rejected on purpose: a caller sending 0 believes Postgres `dow`.
    if (!Number.isInteger(n) || n < 1 || n > 7) return null;
    out.add(n);
  }
  return [...out];
}

interface ValidWindow {
  start: number;
  end: number;
  days: number[];
  timezone: string;
}

function validate(window: CallingWindow): ValidWindow | null {
  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end);
  const days = normalizeDays(window.days);
  if (start === null || end === null || days === null) return null;
  if (!isUsableTimezone(window.timezone)) return null;
  return { start, end, days, timezone: window.timezone };
}

/**
 * Which zone this contact's window is evaluated in.
 *
 * The contact column wins when it names a zone this runtime can evaluate;
 * otherwise the campaign default, flagged so the substitution is visible.
 */
export function resolveCallingWindow(
  campaign: Pick<AgencyCampaignRecord,
    'calling_window_start' | 'calling_window_end' | 'calling_days' | 'default_timezone'>,
  contact: Pick<AgencyContactRecord, 'timezone'>,
): ResolvedCallingWindow {
  const mapped = contact.timezone;
  const usable = isUsableTimezone(mapped);
  return {
    start: campaign.calling_window_start,
    end: campaign.calling_window_end,
    days: campaign.calling_days,
    // Trimmed, because `isUsableTimezone` trims before deciding and ICU does not
    // — so an accepted-but-untrimmed value would come back `unresolvable` later,
    // which is safe but would make the two answers disagree.
    timezone: usable ? mapped!.trim() : campaign.default_timezone,
    timezoneSource: usable ? 'contact' : 'campaign_default',
    // Absent is the ordinary case (no mapped column) and is not a rejection.
    contactTimezoneRejected: mapped !== null && mapped !== undefined && mapped.trim() !== '' && !usable,
  };
}

/**
 * Is the window open at `now`?
 *
 * **An overnight window (`start > end`) is supported**, because the columns permit
 * it and a 20:00–02:00 campaign is a real configuration. `calling_days` gates the
 * day the window **opens**, and a window that opened on an allowed day stays open
 * across midnight regardless of whether the following day is allowed — the only
 * reading that does not chop a night in half or let a Friday-night window run into
 * a Saturday nobody enabled.
 *
 * `start == end` is an EMPTY window, not a 24-hour one. Both readings are
 * defensible from the schema; only one of them declines to dial at 03:00 because
 * of a config typo.
 */
export function callingWindowState(window: CallingWindow, now: Date): CallingWindowState {
  const w = validate(window);
  if (!w) return 'unresolvable';
  if (w.days.length === 0 || w.start === w.end) return 'closed';
  const p = localParts(w.timezone, now);
  if (!p) return 'unresolvable';

  const t = p.hour * 3600 + p.minute * 60 + p.second;
  if (w.start < w.end) {
    return w.days.includes(p.isoDow) && t >= w.start && t < w.end ? 'open' : 'closed';
  }
  // Overnight. Two arms: the evening of an allowed day, or the small hours
  // belonging to an allowed day that has already ended.
  if (w.days.includes(p.isoDow) && t >= w.start) return 'open';
  const yesterday = p.isoDow === 1 ? 7 : p.isoDow - 1;
  if (w.days.includes(yesterday) && t < w.end) return 'open';
  return 'closed';
}

/** UTC offset of `timezone` at `instant`, in ms. Positive east of UTC. */
function zoneOffsetMs(timezone: string, instant: Date): number | null {
  const p = localParts(timezone, instant);
  if (!p) return null;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/**
 * The instant at which a given local wall clock occurs, or null.
 *
 * Two passes, because the offset depends on the answer: the first pass converts
 * using the offset near the guess, the second using the offset at the result.
 * That converges everywhere except across a DST transition, which is why every
 * caller **verifies the result against the predicate** rather than trusting it —
 * see `nextWindowOpen`.
 */
function instantForLocalTime(
  timezone: string, year: number, month: number, day: number, secondsOfDay: number,
): Date | null {
  const wall = Date.UTC(year, month - 1, day) + secondsOfDay * 1000;
  const first = zoneOffsetMs(timezone, new Date(wall));
  if (first === null) return null;
  const second = zoneOffsetMs(timezone, new Date(wall - first));
  if (second === null) return null;
  return new Date(wall - second);
}

/** How far past a computed opening we will hunt for the real one across a DST gap. */
const GAP_SCAN_LIMIT_MS = 4 * 60 * 60 * 1000;
const GAP_SCAN_STEP_MS = 5 * 60 * 1000;

/**
 * The next instant at or after `now` at which the window is open, or null when
 * there is none.
 *
 * This is what an out-of-hours unclaim writes to `next_attempt_at`, which
 * is why it must be the **exact** next opening and strictly in the future: with
 * `now()` the contact is re-claimed on the very next tick and a campaign whose
 * roster is all out of hours spins at 4 claims/second all night, burning agent
 * reservations on calls it will never place. Getting it right also means the
 * contact wakes at the right local time with no scheduler anywhere.
 *
 * **Null means "no opening exists"** — an empty `calling_days`, `start == end`, or
 * a window we cannot read. The caller must not treat null as "now"; it parks the
 * contact instead.
 *
 * ── Why the answer is verified rather than computed ─────────────────────────
 *
 * Across a spring-forward gap the algebra is not merely imprecise, it errs in the
 * dangerous direction. For a window opening 02:30 on a day when 02:00→03:00 is
 * skipped, the two-pass conversion lands on 01:30 local — **before** the window
 * opens — and a gate trusting it would dial an hour early, in the customer's
 * night, once a year, in a subset of zones. So every candidate is checked with
 * `callingWindowState` and stepped forward until it is genuinely open.
 *
 * A fall-back (repeated hour) needs no such care: both occurrences of the local
 * time are inside the window, so either instant is a lawful opening and picking
 * the later one merely starts up to an hour late.
 */
export function nextWindowOpen(window: CallingWindow, now: Date): Date | null {
  const w = validate(window);
  if (!w) return null;
  if (w.days.length === 0 || w.start === w.end) return null;
  const p = localParts(w.timezone, now);
  if (!p) return null;

  // 8 local days, not 7: the day the search starts is usually already spent, so a
  // window that runs on exactly one weekday needs the eighth day to be reachable.
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!w.days.includes(isoDowOf(year, month, day))) continue;

    const candidate = instantForLocalTime(w.timezone, year, month, day, w.start);
    if (!candidate) continue;
    const opened = snapForwardToOpen(window, candidate);
    if (opened && opened.getTime() > now.getTime()) return opened;
  }
  return null;
}

/**
 * Walk a candidate forward until the window is genuinely open, or give up.
 *
 * Only the DST-gap case walks at all — in the ordinary case the candidate is the
 * opening instant and the first check returns it. The step is 5 minutes because
 * not every transition is a whole hour (Lord Howe shifts 30 minutes).
 */
function snapForwardToOpen(window: CallingWindow, candidate: Date): Date | null {
  if (callingWindowState(window, candidate) === 'open') return candidate;
  for (let delta = GAP_SCAN_STEP_MS; delta <= GAP_SCAN_LIMIT_MS; delta += GAP_SCAN_STEP_MS) {
    const stepped = new Date(candidate.getTime() + delta);
    if (callingWindowState(window, stepped) === 'open') return stepped;
  }
  return null;
}
