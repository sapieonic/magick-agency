import { describe, expect, it } from 'vitest';
import type * as Core from '../src/agency';
import type { AgencyApi, PlatformApi } from '../src/index';
import type { AgencyClientFlagMap } from '../src/flags';
import { buildLiterals } from '../../../tooling/contracts-literals.mjs';
import actions from '../fixtures/agent/actions.json';
import literals from '../fixtures/agent/literals.json';
import platform from '../fixtures/agent/platform.json';
import reads from '../fixtures/agent/reads.json';
import session from '../fixtures/agent/session.json';
import stationClient from '../fixtures/agent/station-client.json';
import station from '../fixtures/agent/station.json';

/**
 * The agent app's golden wire samples (`fixtures/agent/*.json`) against the contract.
 *
 * The mobile app is Dart, so it cannot compile against these types; its wire package
 * (`apps/mobile/packages/agency_wire`) decodes the same JSON files in its own suite. This
 * file is the TypeScript half: a contract change that a fixture no longer satisfies fails
 * `pnpm lint` here, and the fixture then has to be updated, which fails the Dart suite
 * until the Dart type follows.
 *
 * ── What the type check can and cannot see ──────────────────────────────────
 * A JSON import is typed with its literals WIDENED (`"ready"` is `string`), so a fixture
 * cannot be checked against a literal union directly. {@link fits} therefore checks the
 * fixture against the contract type with every literal union widened to its primitive
 * (`Widen`), plus a strict no-extra-keys rule (`Stray`), which together catch:
 *
 *   - a required field added to the contract and missing from the fixture;
 *   - a field removed or renamed in the contract and still present in the fixture
 *     (the error names the path, as `__stray_keys__: ".attempt.old_name"`);
 *   - a type or nullability change (`string` → `number`, `string | null` → `string`).
 *
 * The literal VALUES are covered elsewhere: `literals.json` is extracted from the sources
 * (and checked fresh below), the Dart suite fails on a literal its enums do not know, and
 * {@link LITERAL_FIELDS} checks the discriminants here at runtime.
 *
 * Type-level failures surface in `pnpm lint`; the runtime checks in `pnpm test`.
 */

// ── The type-level checks ────────────────────────────────────────────────────

/** `T` with every literal widened to its primitive, recursively. Optionality is kept. */
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends null | undefined
        ? T
        : T extends readonly (infer E)[]
          ? Widen<E>[]
          : T extends object
            ? { [K in keyof T]: Widen<T[K]> }
            : T;

/** The object part of `T` (drops `null`, `undefined` and primitives from a union). */
type ObjectPart<T> = Extract<NonNullable<T>, object>;

/**
 * The paths of keys in the fixture `J` that the contract type `T` does not declare, as a
 * union of `".a.b"` strings; `never` when there are none. An index-signature object
 * (`Record<string, unknown>`) declares every key, and `unknown` ends the walk.
 */
type Stray<J, T, P extends string = ''> = unknown extends T
  ? never
  : J extends readonly (infer JE)[]
    ? ObjectPart<T> extends readonly (infer TE)[]
      ? Stray<JE, TE, `${P}[]`>
      : never
    : J extends object
      ? {
          [K in keyof J & string]: K extends keyof ObjectPart<T>
            ? Stray<J[K], ObjectPart<T>[K], `${P}.${K}`>
            : `${P}.${K}`;
        }[keyof J & string]
      : never;

/**
 * Checks one fixture against its contract type at compile time and returns it unchanged.
 * `fits<T>()(json)` fails `tsc` when `json` does not fit `Widen<T>` or has a stray key.
 */
function fits<T>() {
  return <J extends Widen<T>>(
    json: J & ([Stray<J, T>] extends [never] ? unknown : { __stray_keys__: Stray<J, T> }),
  ): J => json;
}

/** The request bodies the app sends: the server injects the actor fields itself. */
type AppBody<T> = Omit<T, keyof Core.AgencyActorFields>;

/** The body the invite-claim route sends on a 404/409 (`invites.routes.ts`). */
interface InviteClaimRefusalBody {
  error: string;
  message: string;
  status: PlatformApi.InviteUnavailableStatus | PlatformApi.InviteClaimRefusalStatus;
  email?: string;
}

// The station frames are the dialer runtime's own shapes (the proxy relays them unchanged).
const STATION = {
  ready_first_join: fits<Core.AgencyStationReadyFrame>()(station.ready_first_join),
  ready_reconnect_live: fits<Core.AgencyStationReadyFrame>()(station.ready_reconnect_live),
  ready_reconnect_wrapup: fits<Core.AgencyStationReadyFrame>()(station.ready_reconnect_wrapup),
  ready_missed_release: fits<Core.AgencyStationReadyFrame>()(station.ready_missed_release),
  ready_device_away: fits<Core.AgencyStationReadyFrame>()(station.ready_device_away),
  reserved: fits<Core.AgencyStationReservedFrame>()(station.reserved),
  countdown: fits<Core.AgencyStationCountdownFrame>()(station.countdown),
  bridged: fits<Core.AgencyStationBridgedFrame>()(station.bridged),
  released_completed: fits<Core.AgencyStationReleasedFrame>()(station.released_completed),
  released_no_answer: fits<Core.AgencyStationReleasedFrame>()(station.released_no_answer),
  wrapup_timed: fits<Core.AgencyStationWrapupFrame>()(station.wrapup_timed),
  wrapup_held_timerless: fits<Core.AgencyStationWrapupFrame>()(station.wrapup_held_timerless),
  agent_state_available: fits<Core.AgencyStationAgentStateFrame>()(station.agent_state_available),
  agent_state_break: fits<Core.AgencyStationAgentStateFrame>()(station.agent_state_break),
  agent_state_break_queued: fits<Core.AgencyStationAgentStateFrame>()(station.agent_state_break_queued),
  campaign_state_exhausted: fits<Core.AgencyStationCampaignStateFrame>()(station.campaign_state_exhausted),
  pong: fits<Core.AgencyStationPongFrame>()(station.pong),
  pong_without_ts: fits<Core.AgencyStationPongFrame>()(station.pong_without_ts),
  error: fits<Core.AgencyStationErrorFrame>()(station.error),
  bridge_status: fits<Core.AgencyStationBridgeStatusFrame>()(station.bridge_status),
  bridge_ended: fits<Core.AgencyStationBridgeEndedFrame>()(station.bridge_ended),
  media: fits<Core.AgencyStationMediaFrame>()(station.media),
  manual_call: fits<Core.AgencyStationManualCallFrame>()(station.manual_call),
};

const STATION_CLIENT = {
  ping: fits<Core.AgencyStationPingFrame>()(stationClient.ping),
  ping_without_ts: fits<Core.AgencyStationPingFrame>()(stationClient.ping_without_ts),
  media: fits<Core.AgencyStationMediaFrame>()(stationClient.media),
};

const SESSION = {
  create_session_request: fits<Omit<Core.AgencyCreateSessionRequest, 'agent_user_id'>>()(
    session.create_session_request,
  ),
  bootstrap_first_join: fits<Core.AgencySessionBootstrap>()(session.bootstrap_first_join),
  bootstrap_retry_rehydrated: fits<Core.AgencySessionBootstrap>()(session.bootstrap_retry_rehydrated),
  station_token: fits<Core.AgencyStationTokenResponse>()(session.station_token),
  break_request: fits<Core.AgencySessionBreakRequest>()(session.break_request),
  session_state_available: fits<Core.AgencySessionStateResponse>()(session.session_state_available),
  session_state_break_queued: fits<Core.AgencySessionStateResponse>()(session.session_state_break_queued),
  break_request_device_away: fits<Core.AgencySessionBreakRequest>()(session.break_request_device_away),
  session_state_device_away: fits<Core.AgencySessionStateResponse>()(session.session_state_device_away),
  session_state_left: fits<Core.AgencySessionStateResponse>()(session.session_state_left),
  conflict_other_campaign: fits<Core.AgencySessionCampaignConflict>()(session.conflict_other_campaign),
  conflict_softphone: fits<Core.AgencySoftphoneSessionOnSoftphoneRefusal>()(session.conflict_softphone),
};

const ACTIONS = {
  hangup_response: fits<Core.AgencyHangupResponse>()(actions.hangup_response),
  disposition_request_callback: fits<AppBody<Core.AgencyDispositionRequest>>()(actions.disposition_request_callback),
  disposition_request_plain: fits<AppBody<Core.AgencyDispositionRequest>>()(actions.disposition_request_plain),
  disposition_response_callback: fits<Core.AgencyDispositionResponse>()(actions.disposition_response_callback),
  disposition_response_completed: fits<Core.AgencyDispositionResponse>()(actions.disposition_response_completed),
  notes_request: fits<AppBody<Core.AgencyNotesRequest>>()(actions.notes_request),
  notes_response: fits<Core.AgencyNotesResponse>()(actions.notes_response),
  dnc_request: fits<AppBody<Core.AgencyDncRequest>>()(actions.dnc_request),
  dnc_response: fits<Core.AgencyDncResponse>()(actions.dnc_response),
  error_unknown_disposition_code: fits<Core.AgencyActionErrorResponse>()(actions.error_unknown_disposition_code),
  error_break_already_applied: fits<Core.AgencyActionErrorResponse>()(actions.error_break_already_applied),
  error_session_ended: fits<Core.AgencyActionErrorResponse>()(actions.error_session_ended),
};

// The agent's reads are public-API-layer shapes, so they are checked against `AgencyApi`.
const READS = {
  my_assignments: fits<AgencyApi.AgencyMyAssignments>()(reads.my_assignments),
  my_assignments_empty: fits<AgencyApi.AgencyMyAssignments>()(reads.my_assignments_empty),
  my_campaigns: fits<AgencyApi.AgencyStaffingHistory>()(reads.my_campaigns),
  my_stats: fits<AgencyApi.AgencyAgentStats>()(reads.my_stats),
  my_stats_unmeasured: fits<AgencyApi.AgencyAgentStats>()(reads.my_stats_unmeasured),
  my_attempts: fits<AgencyApi.AgencyKeysetPage<AgencyApi.AgencyAttempt>>()(reads.my_attempts),
  my_attempts_last_page: fits<AgencyApi.AgencyKeysetPage<AgencyApi.AgencyAttempt>>()(reads.my_attempts_last_page),
};

const PLATFORM = {
  session_request: fits<PlatformApi.SessionRequest>()(platform.session_request),
  session_response: fits<PlatformApi.SessionResponse>()(platform.session_response),
  me_response: fits<PlatformApi.MeResponse>()(platform.me_response),
  session_refusal: fits<PlatformApi.SessionRefusal>()(platform.session_refusal),
  my_accounts: fits<PlatformApi.MyAccountsResponse>()(platform.my_accounts),
  invite_lookup_pending: fits<Extract<PlatformApi.InviteLookup, { status: 'pending' }>>()(
    platform.invite_lookup_pending,
  ),
  invite_lookup_expired: fits<Exclude<PlatformApi.InviteLookup, { status: 'pending' }>>()(
    platform.invite_lookup_expired,
  ),
  invite_claim_request: fits<{ id_token: string }>()(platform.invite_claim_request),
  invite_claim_refusal: fits<InviteClaimRefusalBody>()(platform.invite_claim_refusal),
  feature_flags: fits<AgencyClientFlagMap>()(platform.feature_flags),
  notification_preferences: fits<PlatformApi.NotificationPreferencesResponse>()(platform.notification_preferences),
  notification_update: fits<PlatformApi.NotificationPreferenceUpdate>()(platform.notification_update),
  error_generic: fits<{ error: string; code?: string; message: string }>()(platform.error_generic),
  client_config: fits<PlatformApi.ClientConfigResponse>()(platform.client_config),
  uplink_probe_response: fits<PlatformApi.UplinkProbeResponse>()(platform.uplink_probe_response),
  error_not_staffed: fits<Core.AgencyActionErrorResponse>()(platform.error_not_staffed),
};

// ── The runtime checks ───────────────────────────────────────────────────────

type Vocabulary = { source: string; values: string[] };
const vocab = (key: string): string[] => {
  const entry = (literals as unknown as Record<string, Vocabulary | undefined>)[key];
  if (!entry) throw new Error(`literals.json has no "${key}"`);
  return entry.values;
};

/**
 * The literal-typed fields of the fixtures, checked against the extracted vocabularies at
 * runtime because the JSON import cannot carry them to the type check. `path` is a dotted
 * path into one sample; a `null`/absent value is skipped (nullability is the type check's).
 */
const LITERAL_FIELDS: Array<[file: string, sample: string, path: string, vocabulary: string]> = [
  ...Object.keys(station).map((s): [string, string, string, string] => ['station', s, 'event', 'station_server_events']),
  ['station', 'ready_first_join', 'state', 'agent_states'],
  ['station', 'ready_reconnect_live', 'state', 'agent_states'],
  ['station', 'ready_reconnect_live', 'pending_state', 'agent_states'],
  ['station', 'ready_reconnect_live', 'active_attempt.state', 'attempt_states'],
  ['station', 'ready_reconnect_live', 'active_attempt.prior_attempts.0.outcome', 'attempt_outcomes'],
  ['station', 'ready_missed_release', 'missed_release.reason', 'release_reasons'],
  ['station', 'ready_device_away', 'state', 'agent_states'],
  ['station', 'ready_device_away', 'break_reason', 'reserved_break_codes'],
  ['station', 'reserved', 'attempt.prior_attempts.0.outcome', 'attempt_outcomes'],
  ['station', 'released_completed', 'reason', 'release_reasons'],
  ['station', 'released_no_answer', 'reason', 'release_reasons'],
  ['station', 'wrapup_held_timerless', 'wrapup.held_reason', 'wrapup_hold_reasons'],
  ['station', 'agent_state_available', 'state', 'agent_states'],
  ['station', 'agent_state_break', 'state', 'agent_states'],
  ['station', 'agent_state_break_queued', 'pending_state', 'agent_states'],
  ['station', 'campaign_state_exhausted', 'status', 'campaign_statuses'],
  ['station', 'campaign_state_exhausted', 'reason', 'campaign_change_reasons'],
  ['station', 'error', 'code', 'station_error_codes'],
  ['station', 'bridge_status', 'status', 'bridge_statuses'],
  ['station', 'manual_call', 'call.state', 'attempt_states'],
  ['session', 'bootstrap_first_join', 'state', 'agent_states'],
  ['session', 'bootstrap_first_join', 'campaign_status', 'campaign_statuses'],
  ['session', 'bootstrap_retry_rehydrated', 'state', 'agent_states'],
  ['session', 'bootstrap_retry_rehydrated', 'break_reason', 'reserved_break_codes'],
  ['session', 'session_state_break_queued', 'kind', 'session_kinds'],
  ['session', 'session_state_break_queued', 'pending_state', 'agent_states'],
  ['session', 'session_state_device_away', 'state', 'agent_states'],
  ['session', 'session_state_device_away', 'break_reason', 'reserved_break_codes'],
  ['session', 'break_request_device_away', 'reason', 'reserved_break_codes'],
  ['platform', 'error_not_staffed', 'code', 'action_error_codes'],
  ['session', 'conflict_other_campaign', 'code', 'action_error_codes'],
  ['session', 'conflict_other_campaign', 'state', 'agent_states'],
  ['actions', 'hangup_response', 'state', 'attempt_states'],
  ['actions', 'disposition_response_callback', 'contact_state', 'contact_states'],
  ['actions', 'disposition_response_callback', 'agent_state', 'agent_states'],
  ['actions', 'dnc_request', 'scope', 'dnc_scopes'],
  ['actions', 'dnc_response', 'contact_state', 'contact_states'],
  ['actions', 'error_unknown_disposition_code', 'code', 'action_error_codes'],
  ['actions', 'error_break_already_applied', 'code', 'action_error_codes'],
  ['actions', 'error_session_ended', 'code', 'action_error_codes'],
  ['reads', 'my_attempts', 'rows.0.state', 'attempt_states'],
  ['reads', 'my_attempts', 'rows.0.outcome', 'attempt_outcomes'],
  ['reads', 'my_attempts', 'rows.1.outcome', 'attempt_outcomes'],
  ['platform', 'session_response', 'memberships.0.role', 'roles'],
  ['platform', 'invite_lookup_pending', 'invite.role', 'roles'],
  ['platform', 'invite_lookup_expired', 'status', 'invite_unavailable_statuses'],
  ['platform', 'invite_claim_refusal', 'status', 'invite_claim_refusal_statuses'],
];

const FILES: Record<string, Record<string, unknown>> = { station, session, actions, reads, platform };

function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v == null ? v : (v as Record<string, unknown>)[k]), value);
}

describe('agent fixtures (fixtures/agent/*.json)', () => {
  it('registers every sample of every file with a contract type', () => {
    const registered: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['station', station, STATION],
      ['station-client', stationClient, STATION_CLIENT],
      ['session', session, SESSION],
      ['actions', actions, ACTIONS],
      ['reads', reads, READS],
      ['platform', platform, PLATFORM],
    ];
    for (const [name, file, checked] of registered) {
      expect(Object.keys(checked).sort(), `${name}.json`).toEqual(Object.keys(file).sort());
    }
  });

  it('covers every station server event the contract declares', () => {
    const events = new Set(Object.values(station).map((frame) => frame.event));
    expect([...events].sort()).toEqual([...vocab('station_server_events')].sort());
  });

  it.each(LITERAL_FIELDS)('%s.%s: `%s` is a member of %s', (file, sample, path, vocabulary) => {
    const value = at(FILES[file]?.[sample], path);
    expect(value, `${file}.${sample} has no ${path}`).not.toBeUndefined();
    if (value !== null) expect(vocab(vocabulary)).toContain(value);
  });

  it('keeps the client frames the server reads to ping and media', () => {
    expect(new Set(Object.values(STATION_CLIENT).map((f) => f.event))).toEqual(new Set(['ping', 'media']));
  });
});

describe('fixtures/agent/literals.json', () => {
  it('matches the vocabularies extracted from the sources (run `node tooling/contracts-literals.mjs`)', () => {
    expect(literals).toEqual(buildLiterals());
  });

  it('extracts the station close codes the console switches on', () => {
    expect(buildLiterals()['station_close_codes']).toMatchObject({
      values: {
        TOKEN_REJECTED: 4401,
        SESSION_GONE: 4404,
        HEARTBEAT_TIMEOUT: 4408,
        SUPERSEDED: 4409,
        INVALID_UPGRADE: 1008,
        INTERNAL_ERROR: 1011,
      },
    });
  });
});
