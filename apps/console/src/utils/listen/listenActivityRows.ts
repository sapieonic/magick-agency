import type { ActivityRow } from '../../types/agency-activity';
import type { AgencyListenEndReason } from '../../types/live-calls';
import { isoMs, mergeListenVisits } from './listenVisits';

/**
 * A campaign History's listen rows, merged for display (`docs/listening.md` §9, LS19 b, e). Every
 * attach of a listen is its own session with its own `agency_call.listen_started` and
 * `_ended` rows, so one listen with a reconnect reads as four rows. Here a supervisor's sessions on
 * one call are merged by the Listening history's rule (`mergeListenVisits`: within 30 s, overlaps
 * counted once, the reason of the last to end) into the row of the visit's newest end, its
 * `detail` carrying the whole visit's `duration_seconds` and `end_reason` and the `listen_ids`
 * merged; the visit's other rows are not shown. A started row whose session has no ended row in
 * what is loaded (a listen still open, or its end filtered out) is left as it is. Rows that are
 * not listen rows pass through, in order. Pure: the rows read are never changed.
 *
 * Only complete sessions merge, read from their ended rows: the start is the started row's
 * `at` where it is loaded, else the end less its `duration_seconds` (its started row may be on a
 * page not yet loaded).
 */

const STARTED = 'agency_call.listen_started';
const ENDED = 'agency_call.listen_ended';

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function mergeListenActivityRows(rows: readonly ActivityRow[]): ActivityRow[] {
  const startedAt = new Map<string, number>();
  const endedIds = new Set<string>();
  for (const row of rows) {
    const id = str(row.detail?.['listen_id']);
    if (!id) continue;
    if (row.action === STARTED) {
      const at = isoMs(row.at);
      if (at !== null) startedAt.set(id, at);
    } else if (row.action === ENDED) {
      endedIds.add(id);
    }
  }
  if (endedIds.size === 0) return [...rows];

  const ended = rows.filter((row) => row.action === ENDED && str(row.detail?.['listen_id']) && row.actor.user_id);
  const visits = mergeListenVisits(ended, (row) => {
    const id = str(row.detail['listen_id'])!;
    const endedMs = isoMs(row.at);
    const callId = str(row.detail['call_id']) ?? row.target.id;
    if (endedMs === null || !callId) return null;
    const seconds = typeof row.detail['duration_seconds'] === 'number' ? row.detail['duration_seconds'] : 0;
    const startedMs = startedAt.get(id) ?? endedMs - Math.max(0, seconds) * 1000;
    const reason = str(row.detail['end_reason']) as AgencyListenEndReason | null;
    return { listenerId: row.actor.user_id!, callId, id, startedMs: Math.min(startedMs, endedMs), endedMs, endReason: reason };
  });

  // Each visit is shown as the row of its newest end; the rest of its rows are not.
  const shownAs = new Map<string, ActivityRow>();
  const hidden = new Set<string>();
  for (const visit of visits) {
    const newest = visit.sessions.reduce((a, b) => ((isoMs(b.at) ?? 0) >= (isoMs(a.at) ?? 0) ? b : a));
    for (const row of visit.sessions) if (row !== newest) hidden.add(row.id);
    if (visit.sessions.length === 1) {
      shownAs.set(newest.id, newest);
      continue;
    }
    shownAs.set(newest.id, {
      ...newest,
      detail: {
        ...newest.detail,
        duration_seconds: Math.round((visit.listenedMs ?? 0) / 1000),
        end_reason: visit.endReason,
        listen_ids: visit.sessions.map((row) => str(row.detail['listen_id'])),
      },
    });
  }

  const shown: ActivityRow[] = [];
  for (const row of rows) {
    if (hidden.has(row.id)) continue;
    const id = str(row.detail?.['listen_id']);
    // A started row whose session ended is told by its ended row (or its visit's).
    if (row.action === STARTED && id && endedIds.has(id)) continue;
    shown.push(shownAs.get(row.id) ?? row);
  }
  return shown;
}
