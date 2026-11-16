import { describe, expect, it } from 'vitest';
import type { AgencyListenEndReason } from '@magick-agency/contracts/agency';
import type { AgencyListenErrorCode } from '@magick-agency/contracts/errors';
import { AGENCY_LISTEN_END_REASONS } from '@magick-agency/contracts/agency';
import { AGENCY_LISTEN_ERROR_CODES } from '@magick-agency/contracts/errors';
import type {
  ListenEndMetricReason,
  ListenGrantResult,
} from '@magick-agency/observability/metrics/agency';

/**
 * The listen metrics' label vocabularies (`packages/observability/src/metrics/agency.ts`) against
 * the contract's (docs/listening.md). The observability package cannot import the contract, so it
 * spells them out; this holds the two equal, so a reason or a refusal added to the contract
 * without its label is a `pnpm lint` failure here, not a series nobody can chart. Type-level
 * (`pnpm lint`), with the runtime lists beside them for `pnpm test`.
 */

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const _endReasonsAgree: Equals<ListenEndMetricReason, AgencyListenEndReason> = true;
const _grantRefusalsAgree: Equals<Exclude<ListenGrantResult, 'granted'>, AgencyListenErrorCode> = true;
void [_endReasonsAgree, _grantRefusalsAgree];

describe('listen metric labels', () => {
  it('cover every end reason and every refusal the contract lists', () => {
    const endReasons: Record<ListenEndMetricReason, true> = {
      call_ended: true, listener_stopped: true, listener_disconnected: true, permission_revoked: true, superseded: true,
      send_backlog: true, tap_error: true, server_shutdown: true, server_restarted: true,
    };
    expect(Object.keys(endReasons).sort()).toEqual([...AGENCY_LISTEN_END_REASONS].sort());
    const refusals: Record<Exclude<ListenGrantResult, 'granted'>, true> = {
      listen_call_not_live: true, listen_recording_off: true, listen_limit_call: true, listen_limit_server: true,
      listen_own_call: true, listen_unavailable: true,
    };
    expect(Object.keys(refusals).sort()).toEqual([...AGENCY_LISTEN_ERROR_CODES].sort());
  });
});
