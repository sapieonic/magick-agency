import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '../../types/agency-stats';
import type { AgencyGroupPage, AgencyGroupRow } from '../../types/agency-stats';

/**
 * Best-hours fixtures — the grouped read cut by weekday and hour, as master serves
 * it.
 *
 * ── COMPLETE, and every DERIVED field is derived ──────────────────────────
 * Same rule as `roster.ts` and `contribution.ts`: every field the contract declares
 * required is present, because a payload missing one is a contract violation rather
 * than an input the console has to survive.
 *
 * This file goes one step further than its two siblings, and deliberately. Those
 * hardcode the served rates and derive only the reportability flags; here BOTH the
 * rates and the flags are computed from the cell's own counts, with an explicit
 * override still winning. The reason is the shape this surface is about: a cell is
 * three small numbers, and a hand-written fixture reading
 * `attempts: 2, connected: 1, connect_rate_pct: 4` is a payload core cannot emit —
 * on which a test asserting "the thin cell is not the brightest square" would pass
 * for the wrong reason and keep passing after the bug came back. The boundary cases
 * pass the flags by hand precisely so they assert the console's use of the SERVER's
 * answer rather than this file's arithmetic.
 *
 * ── The trap specific to this payload is the THIN cell ────────────────────
 * `rates_reportable` defaults derived, so the default cell is fat and rated and
 * thinness is opted into via {@link thinHourCell}. A fixture that defaulted the flag
 * to `false` — or left it undefined, which is falsy on the wire but PERMISSIVE
 * through the console's guard — would make "a thin cell is never coloured" pass
 * vacuously, which is exactly the MAG-106 pattern the phase-01 contract names.
 *
 * ── The window is a REAL seven days in a REAL zone ────────────────────────
 * `WEEK_FROM`/`WEEK_TO` are the UTC instants of midnight-to-midnight over seven
 * days in `Asia/Kolkata`, so every weekday is fully covered and a coverage assertion
 * cannot pass because the walk happened to mark everything. {@link SHORT_FROM} /
 * {@link SHORT_TO} are one part-day in the same zone, which is the shape the
 * out-of-window ruling exists for — and the zone's `+05:30` offset is what makes a
 * reader's-zone implementation visibly wrong rather than accidentally right.
 */

/** The zone every fixture is cut in. Deliberately offset by a half hour from UTC. */
export const FIXTURE_ZONE = 'Asia/Kolkata';

/** 2026-08-17T00:00 IST (a Monday) → 2026-08-24T00:00 IST. All seven weekdays, fully. */
export const WEEK_FROM = '2026-08-16T18:30:00.000Z';
export const WEEK_TO = '2026-08-23T18:30:00.000Z';

/**
 * 2026-08-26T00:00 IST (a Wednesday) → 09:00 IST the same day.
 *
 * One weekday (`3`), hours 00–08, and six weekdays that were never asked about. The
 * shape a Monday-morning "today" window has, and the shape that makes an
 * out-of-window row read as "stop staffing Tuesdays" if it is rendered as a zero.
 */
export const SHORT_FROM = '2026-08-25T18:30:00.000Z';
export const SHORT_TO = '2026-08-26T03:30:00.000Z';
/** The weekday `SHORT_FROM`/`SHORT_TO` covers: Wednesday. */
export const SHORT_DAY = 3;
/** The last hour of that weekday inside the short window — 09:00 is exclusive. */
export const SHORT_LAST_HOUR = 8;

export interface HourCellInput {
  /** 0 = Sunday … 6 = Saturday. */
  day: number;
  /** 0–23 in {@link FIXTURE_ZONE}. */
  hour: number;
  /** At least 1 on every served row: the read is attempts-driven. */
  attempts: number;
  connected?: number;
  successes?: number;
  talk_seconds?: number;
  wrapup_seconds?: number;
  /** Explicit values win, so a boundary case can assert the console's use of the flag. */
  connect_rate_pct?: number | null;
  success_rate_pct?: number | null;
  aht_seconds?: number | null;
  rates_reportable?: boolean;
  success_rate_reportable?: boolean;
}

/** The server's own division, so a fixture's rate cannot disagree with its counts. */
function rate(part: number, whole: number): number | null {
  return whole <= 0 ? null : (part / whole) * 100;
}

/**
 * One weekday-hour cell.
 *
 * `connected` defaults to a third of the dials and `successes` to a fifth of the
 * connects, which is roughly a real telecaller campaign and — more usefully — is
 * never a round number that another cell could also produce by coincidence.
 */
export function hourCell(input: HourCellInput): AgencyGroupRow {
  const attempts = input.attempts;
  const connected = input.connected ?? Math.floor(attempts / 3);
  const successes = input.successes ?? Math.floor(connected / 5);
  const talk = input.talk_seconds ?? connected * 60;
  const wrapup = input.wrapup_seconds ?? connected * 15;

  /*
    Both flags DERIVED as core derives them — `attempts >= 20` for the dial-based
    one, and that AND `connected >= 20` for the connects-based one. A fixture that
    hardcoded the second could produce a row core cannot emit (`rates_reportable:
    false` beside a quotable conversion rate) and a test would then pin behaviour on
    a payload that does not exist.
  */
  const ratesReportable =
    input.rates_reportable ?? attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR;
  const successReportable =
    input.success_rate_reportable ??
    (ratesReportable && connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR);

  return {
    key: { day_of_week: input.day, hour_of_day: input.hour },
    attempts,
    connected,
    successes,
    talk_seconds: talk,
    wrapup_seconds: wrapup,
    connect_rate_pct:
      input.connect_rate_pct !== undefined ? input.connect_rate_pct : rate(connected, attempts),
    success_rate_pct:
      input.success_rate_pct !== undefined ? input.success_rate_pct : rate(successes, connected),
    aht_seconds:
      input.aht_seconds !== undefined
        ? input.aht_seconds
        : connected <= 0
          ? null
          : (talk + wrapup) / connected,
    rates_reportable: ratesReportable,
    success_rate_reportable: successReportable,
  };
}

/**
 * The cell this whole surface exists to refuse to colour: **2 dials, 1 connect**.
 *
 * Its connect rate is a served `50%`, which on a ramp topping out near a 30% floor
 * median would be the brightest square on the map — and a supervisor moves staffing
 * to Sunday night on the strength of one answered call. Both flags are derived
 * `false` from 2 dials, so the console's refusal is a use of the server's answer
 * rather than a client-side threshold.
 *
 * `50%` and `100%` appear on no other default fixture cell, so an assertion that
 * they are ABSENT from the DOM cannot pass by coincidence.
 */
export function thinHourCell(over: Partial<HourCellInput> = {}): AgencyGroupRow {
  return hourCell({ day: 0, hour: 20, attempts: 2, connected: 1, successes: 1, ...over });
}

/**
 * Plenty of DIALS, too few CONNECTS — the cell one flag cannot describe.
 *
 * 41 dials and 11 connects: `rates_reportable` is true so the CONNECT rate must be
 * coloured, and `success_rate_reportable` is false so the CONVERSION rate must not
 * be. The same cell, two answers, on two views of one payload.
 */
export function hollowHourCell(over: Partial<HourCellInput> = {}): AgencyGroupRow {
  return hourCell({ day: 2, hour: 11, attempts: 41, connected: 11, successes: 2, ...over });
}

/**
 * A cell that dialled and reached nobody — `success_rate_pct: null`, reachable and
 * ordinary.
 *
 * It must not print `0%` on the conversion view: that reads as an hour with forty
 * conversations and no bookings, which is a different and much worse finding.
 */
export function unconnectedHourCell(over: Partial<HourCellInput> = {}): AgencyGroupRow {
  return hourCell({ day: 4, hour: 3, attempts: 30, connected: 0, successes: 0, ...over });
}

/**
 * The same cell with `success_rate_reportable` **absent from the object**, as a core
 * that predates the field serves it.
 *
 * ── Why a helper and not `{ success_rate_reportable: undefined }` ──────────
 * {@link hourCell} DERIVES both flags with `??`, so passing `undefined` gets the
 * derived value back and the absent-field path is never taken. Every fixture in this
 * file therefore carries both flags, which meant the console's `typeof` guard for
 * the second one had no test over it at all — and that guard is where the fail-closed
 * ruling lives. A path with no fixture is the MAG-106 pattern: the code that reads
 * it looks tested and is not.
 *
 * `delete` on a copy rather than a hand-built row, so the cell is otherwise exactly
 * what the server would send — the flag is the only thing missing.
 */
export function withoutSuccessFlag(row: AgencyGroupRow): AgencyGroupRow {
  const stripped: AgencyGroupRow = { ...row };
  delete stripped.success_rate_reportable;
  return stripped;
}

export function bestHoursPage(over: Partial<AgencyGroupPage> = {}): AgencyGroupPage {
  const rows = over.rows ?? [hourCell({ day: 1, hour: 10, attempts: 300 })];
  return {
    from: WEEK_FROM,
    to: WEEK_TO,
    /*
      ONE campaign, always — the read is a 400 without it, because both time
      dimensions are grouped and the zone is unambiguous only under a single campaign
      filter. `group_by` echoes both dimensions in the vocabulary's canonical order.
    */
    campaign_id: 'camp-1',
    group_by: ['day_of_week', 'hour_of_day'],
    /* The route's defaults, which is what this client asks for: a matrix renders
       every cell, so no order is meaningful and no `limit` is sent. */
    sort: 'key',
    order: 'asc',
    limit: 200,
    total_groups: rows.length,
    inactive_omitted: 0,
    /*
      Present by default, for the reason `roster.ts` gives about `shift_seconds`: a
      fixture that omitted it would make every assertion run down the ABSENT-field
      path, and the case asserting that path is reached would then pass vacuously. The
      absence is opted into with `bestHoursPage({ resolved_timezone: undefined })`.
    */
    resolved_timezone: FIXTURE_ZONE,
    ...over,
    rows,
  };
}
