import { useEffect, useMemo, useRef } from 'react';
import { getMyDay, getMyStats } from '../../../api/agencyStats';
import { listMyContacts } from '../../../api/agencyAssignment';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { usePolledRead } from '../../../hooks/usePolledRead';
import { todayWindow } from '../../../utils/agency/home';
import type { AgencyAgentState } from '../../../types/agency';
import type { AgencyMyContact } from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyMyDay } from '@magick-agency/contracts/api/agency/my-day';

/**
 * My day and the call-later list on Start of day, Ready, No calls right now and Finish work
 * (spec 01, 02, 11; backend plan BE-1 to BE-3), in one read.
 *
 * ── The read ────────────────────────────────────────────────────────────────
 * `GET /proxy/agency/my-day?campaign_id=` answers everything: connected calls, numbers dialled,
 * talk time, will pay, the campaign's daily target and the agent's own call-laters, on the
 * campaign's own day, with whether they come back to this agent (`comes_to_me`, AS8) and where one
 * left at Finish work goes (`left_today_goes_to`).
 *
 * **On any error** (a server without the route answers 404) it falls back to phase 0's reads, as
 * the agent app does: today's `my-stats` for this campaign from the agent's local midnight (calls,
 * talk time, numbers dialled; no target, no will pay), and, only where the campaign assigns
 * contacts with contact assignment on (`callLaterFallback`), `my-contacts?bucket=callback` for
 * today's call-laters. Either half of the fallback that fails is simply not shown.
 *
 * It is read on join, every minute, at the local midnight, and again each time the agent comes back
 * to Ready after a call or a break, so the count moves after every saved call.
 */
export interface MyDay {
  /** Connected calls today (AS6), or null when not known. */
  calls: number | null;
  /** The campaign's daily target in connected calls (AS6, BE-2); null when it has none. */
  target: number | null;
  /** Talk time today, in seconds. */
  talkSeconds: number | null;
  /** Outcomes today that recorded a pay date (AS7, BE-1); null on a campaign whose outcomes record no promise. */
  willPay: number | null;
  /** Numbers dialled today: the third tile when there is no Will pay. */
  dialled: number | null;
}

export interface CallLaterRow {
  id: string;
  /** Epoch ms when it falls due. */
  dueAt: number;
  /** The customer's name, or null: the list then says "Customer", never the number. */
  name: string | null;
  /** Its time has passed and it has not been made yet. */
  overdue: boolean;
}

export interface MyCallLaters {
  /** Oldest due first. */
  rows: CallLaterRow[];
  /** How many are due from now to the end of the day (my-day's count, else the rows not overdue). */
  today: number;
  /** Whether these calls come back to this agent (AS8). */
  comesToMe: boolean;
  /** Where one left at Finish work goes; null when the server did not say (the fallback read). */
  leftTodayGoesTo: 'pool' | 'waits_for_me' | null;
}

export interface MyDayReads {
  myDay: MyDay | null;
  callLaters: MyCallLaters | null;
}

export const MY_DAY_POLL_MS = 60_000;
const LIST_LIMIT = 50;
const NOTHING: MyDayReads = { myDay: null, callLaters: null };

/**
 * The target My day can draw: only one whose metric the station knows (`calls`, AS6) and that is a
 * positive number, as the app reads it (`station_reads.dart`). A metric added later is not shown
 * as a number of calls.
 */
export function knownTarget(target: AgencyMyDay['target'] | undefined): number | null {
  if (!target || target.metric !== 'calls') return null;
  return Number.isFinite(target.value) && target.value > 0 ? target.value : null;
}

/** my-day's answer, in the station's shapes. */
export function fromMyDay(day: AgencyMyDay): MyDayReads {
  const later = day.call_later;
  return {
    myDay: {
      calls: day.calls,
      target: knownTarget(day.target),
      talkSeconds: day.talk_seconds,
      willPay: day.will_pay,
      dialled: day.dialed,
    },
    callLaters: {
      rows: later.rows
        .map((r) => ({ id: r.contact_id, dueAt: Date.parse(r.due_at), name: r.customer_name?.trim() || null, overdue: r.overdue }))
        .filter((r) => Number.isFinite(r.dueAt)),
      today: later.today,
      comesToMe: later.comes_to_me,
      leftTodayGoesTo: later.left_today_goes_to,
    },
  };
}

/** The fallback list from my-contacts: today's call-laters on the reader's calendar, soonest first. */
export function callLaterRowsFor(contacts: readonly AgencyMyContact[], now: Date): CallLaterRow[] {
  const today = now.toDateString();
  const present = now.getTime();
  return contacts
    .map((c) => ({
      id: c.id,
      dueAt: Date.parse(c.next_attempt_at),
      // Never the number: no named column leaves the name out.
      name: c.hero.find((h) => h.value.trim())?.value.trim() ?? null,
    }))
    .filter((r) => Number.isFinite(r.dueAt) && new Date(r.dueAt).toDateString() === today)
    .map((r) => ({ ...r, overdue: r.dueAt < present }))
    .sort((a, b) => a.dueAt - b.dueAt);
}

async function fallbackReads(
  campaignId: string,
  callLaterFallback: boolean,
  tenantId: string,
  accountId: string,
  now: Date,
): Promise<MyDayReads> {
  const window = todayWindow(now);
  const [stats, contacts] = await Promise.allSettled([
    getMyStats({ ...window, bucket: 'day', campaign_id: campaignId }, tenantId, accountId),
    callLaterFallback
      ? listMyContacts({ campaign_id: campaignId, bucket: ['callback'], limit: LIST_LIMIT }, tenantId, accountId)
      : Promise.resolve(null),
  ]);
  // Each half stands alone; with neither, the read failed (a refusal stops the asking).
  if (stats.status === 'rejected' && (contacts.status === 'rejected' || contacts.value === null)) throw stats.reason;
  const rows = contacts.status === 'fulfilled' && contacts.value ? callLaterRowsFor(contacts.value.rows, now) : null;
  const totals = stats.status === 'fulfilled' ? stats.value.totals : null;
  return {
    myDay: totals
      ? { calls: totals.connected, target: null, talkSeconds: totals.talk_seconds, willPay: null, dialled: totals.attempts }
      : null,
    callLaters: rows ? { rows, today: rows.filter((r) => !r.overdue).length, comesToMe: true, leftTodayGoesTo: null } : null,
  };
}

/** A failed refresh keeps the figures shown only while they are still today's. */
const keepToday = (kept: { day: string }, failedDay: string) => kept.day === failedDay;

export function useMyDay({
  campaignId,
  tenantId,
  accountId,
  agentState,
  enabled,
  callLaterFallback,
}: {
  campaignId: string | null;
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  agentState: AgencyAgentState;
  enabled: boolean;
  /** The campaign assigns contacts and contact assignment is on: the fallback may read my-contacts. */
  callLaterFallback: boolean;
}): MyDayReads {
  const fallbackRef = useLatestRef(callLaterFallback);
  const { state, reload } = usePolledRead<MyDayReads>({
    tenantId,
    accountId,
    enabled: enabled && campaignId !== null,
    // The station is the agent's own; a refusal (no permission) stops asking rather than retrying.
    stopOnRefusal: true,
    periodMs: MY_DAY_POLL_MS,
    keepOnFailure: keepToday,
    turnOfDay: true,
    read: async (t, a, now) => {
      try {
        return fromMyDay(await getMyDay(campaignId!, t, a));
      } catch {
        return fallbackReads(campaignId!, fallbackRef.current, t, a, now);
      }
    },
  });

  // Back on Ready after a call or a break: read again, so the count includes the call just saved.
  const was = useRef(agentState);
  useEffect(() => {
    if (agentState === 'available' && was.current !== 'available' && was.current !== 'offline') reload();
    was.current = agentState;
  }, [agentState, reload]);

  return useMemo<MyDayReads>(() => (state.status === 'ready' ? state.value : NOTHING), [state]);
}
