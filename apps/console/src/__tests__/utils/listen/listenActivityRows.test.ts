import { describe, it, expect } from 'vitest';
import { mergeListenActivityRows } from '../../../utils/listen/listenActivityRows';
import type { ActivityRow } from '../../../types/agency-activity';

/**
 * A campaign History's listen rows merged for display (`docs/listening.md` §9, LS19 b, e): a
 * supervisor's sessions on one call within 30 s of each other are one row, the newest end's,
 * reading the time listened once and the reason of the last to end; every other row as it was.
 */

const SUP = { type: 'human', system: false, user_id: 'sup-1', api_key_id: null, display: 'Anita Kapoor' } as const;

function listenRow(
  action: 'started' | 'ended',
  listenId: string,
  at: string,
  over: { duration?: number; reason?: string; call?: string; actor?: ActivityRow['actor'] } = {},
): ActivityRow {
  return {
    id: `master:${action}-${listenId}`,
    at,
    source: 'master',
    action: `agency_call.listen_${action}`,
    actor: over.actor ?? SUP,
    target: { type: 'agency_call', id: over.call ?? 'call-1' },
    detail: {
      listen_id: listenId,
      call_id: over.call ?? 'call-1',
      origin: 'campaign',
      correlation_id: 'att-1',
      agent_user_id: 'u-1',
      agent_name: 'Priya Sharma',
      ...(action === 'ended' ? { duration_seconds: over.duration ?? 0, end_reason: over.reason ?? 'listener_stopped', frames_dropped: 0 } : {}),
    },
  };
}

const OTHER: ActivityRow = {
  id: 'master:pause',
  at: '2026-11-16T10:01:30.000Z',
  source: 'master',
  action: 'agency_campaign.paused',
  actor: SUP,
  target: { type: 'agency_campaign', id: 'camp-1' },
  detail: {},
};

const ids = (rows: ActivityRow[]) => rows.map((r) => r.id);

describe('mergeListenActivityRows', () => {
  it('a listen with a reconnect inside 30 s is one row: the newest end, the time counted once, its reason', () => {
    // Newest first, as the page reads them: 10:00:00–10:01:00 dropped, 10:01:10–10:02:20 stopped.
    const rows = [
      listenRow('ended', 'l-2', '2026-11-16T10:02:20.000Z', { duration: 70, reason: 'listener_stopped' }),
      OTHER,
      listenRow('started', 'l-2', '2026-11-16T10:01:10.000Z'),
      listenRow('ended', 'l-1', '2026-11-16T10:01:00.000Z', { duration: 60, reason: 'listener_disconnected' }),
      listenRow('started', 'l-1', '2026-11-16T10:00:00.000Z'),
    ];
    const shown = mergeListenActivityRows(rows);
    expect(ids(shown)).toEqual(['master:ended-l-2', 'master:pause']);
    expect(shown[0]!.detail).toMatchObject({ duration_seconds: 130, end_reason: 'listener_stopped', listen_ids: ['l-1', 'l-2'] });
    // The row it stands for is not changed.
    expect(rows[0]!.detail['duration_seconds']).toBe(70);
  });

  it('a supervisor who comes back minutes later is another row', () => {
    const shown = mergeListenActivityRows([
      listenRow('ended', 'l-2', '2026-11-16T10:12:00.000Z', { duration: 60 }),
      listenRow('started', 'l-2', '2026-11-16T10:11:00.000Z'),
      listenRow('ended', 'l-1', '2026-11-16T10:01:00.000Z', { duration: 60 }),
      listenRow('started', 'l-1', '2026-11-16T10:00:00.000Z'),
    ]);
    expect(ids(shown)).toEqual(['master:ended-l-2', 'master:ended-l-1']);
    expect(shown[0]!.detail['duration_seconds']).toBe(60);
  });

  it('another supervisor, or another call, is never merged in', () => {
    const rohan = { ...SUP, user_id: 'sup-2', display: 'Rohan Shah' };
    const shown = mergeListenActivityRows([
      listenRow('ended', 'l-3', '2026-11-16T10:01:20.000Z', { duration: 10, call: 'call-2' }),
      listenRow('ended', 'l-2', '2026-11-16T10:01:15.000Z', { duration: 10, actor: rohan }),
      listenRow('ended', 'l-1', '2026-11-16T10:01:00.000Z', { duration: 60 }),
    ]);
    expect(ids(shown)).toEqual(['master:ended-l-3', 'master:ended-l-2', 'master:ended-l-1']);
  });

  it('an ended row whose started row is on a later page starts at its end less its duration', () => {
    const shown = mergeListenActivityRows([
      listenRow('ended', 'l-2', '2026-11-16T10:02:20.000Z', { duration: 70 }),
      listenRow('started', 'l-2', '2026-11-16T10:01:10.000Z'),
      listenRow('ended', 'l-1', '2026-11-16T10:01:00.000Z', { duration: 60 }),
    ]);
    expect(ids(shown)).toEqual(['master:ended-l-2']);
    expect(shown[0]!.detail['duration_seconds']).toBe(130);
  });

  it('a listen still open (its started row alone) stays as it is', () => {
    const rows = [
      listenRow('started', 'l-2', '2026-11-16T10:01:10.000Z'),
      listenRow('ended', 'l-1', '2026-11-16T10:01:00.000Z', { duration: 60 }),
      listenRow('started', 'l-1', '2026-11-16T10:00:00.000Z'),
    ];
    expect(ids(mergeListenActivityRows(rows))).toEqual(['master:started-l-2', 'master:ended-l-1']);
  });

  it('a single session’s row is the row itself; rows without listen ids are left alone', () => {
    const one = listenRow('ended', 'l-1', '2026-11-16T10:01:00.000Z', { duration: 60 });
    const odd: ActivityRow = { ...one, id: 'master:odd', detail: { call_id: 'call-1' } };
    const shown = mergeListenActivityRows([one, odd, OTHER]);
    expect(shown[0]).toBe(one);
    expect(ids(shown)).toEqual(['master:ended-l-1', 'master:odd', 'master:pause']);
  });

  it('returns the same rows when there is nothing to merge', () => {
    const rows = [OTHER];
    expect(mergeListenActivityRows(rows)).toEqual(rows);
  });
});
