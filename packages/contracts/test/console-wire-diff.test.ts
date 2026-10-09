import { describe, expect, it } from 'vitest';
import type {
  AgencyDispositionResponse,
  AgencyStationIntervals,
  AgencyWrapupHoldReason,
} from '../src/agency';
import type { AgencyApi } from '../src/index';

/**
 * NEW (magick-agency, Phase 8): the three fields CONTRACT-DIFF §1 said the console wire types
 * lacked, added to `api/agency/agency.ts` (the console rendered them from a local override
 * until this landed). Type-level: `pnpm lint` fails if a field goes missing or its type drifts
 * from core's frozen contract (`../src/agency.ts`).
 */

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// `supervisor_hold`: the console's hold vocabulary is core's, exactly.
const _holds: Equals<AgencyApi.AgencyWrapupHold, AgencyWrapupHoldReason> = true;
// `callback_requested_at`: the console type carries core's field with core's type.
const _callback: Equals<
  AgencyApi.AgencyDispositionResponse['callback_requested_at'],
  AgencyDispositionResponse['callback_requested_at']
> = true;
// `deferred_hangup_ms`: core's required number is optional on the console side (it degrades to
// cusui's copy when absent), so core's intervals are assignable to the console's, and the
// member exists with core's type once defined.
const _intervals: AgencyStationIntervals extends AgencyApi.AgencyStationIntervals ? true : false = true;
const _deferred: Equals<
  NonNullable<AgencyApi.AgencyStationIntervals['deferred_hangup_ms']>,
  AgencyStationIntervals['deferred_hangup_ms']
> = true;
void [_holds, _callback, _intervals, _deferred];

describe('console wire types carry the CONTRACT-DIFF §1 fields', () => {
  it('names both wrap-up hold reasons', () => {
    const holds: AgencyApi.AgencyWrapupHold[] = ['disposition_required', 'supervisor_hold'];
    expect(holds).toHaveLength(2);
  });

  it('accepts a disposition response with the requested callback instant, and intervals with the reconnect window', () => {
    const res: Pick<AgencyApi.AgencyDispositionResponse, 'next_attempt_at' | 'callback_requested_at'> = {
      next_attempt_at: '2026-10-09T10:00:00.000Z',
      callback_requested_at: '2026-10-09T09:30:00.000Z',
    };
    const intervals: AgencyApi.AgencyStationIntervals = {
      heartbeat_ms: 1, heartbeat_grace_ms: 1, reservation_lease_ms: 1, countdown_ms: 1, deferred_hangup_ms: 30_000,
    };
    expect(res.callback_requested_at).not.toBe(res.next_attempt_at);
    expect(intervals.deferred_hangup_ms).toBe(30_000);
  });
});
