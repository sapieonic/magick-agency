/**
 * The agency feature flags: keys, defaults, scopes, `envVar` names,
 * `clientExposed`, owners and descriptions. Super-admins can override them per
 * tenant and account.
 *
 * Data and types only. A registry that registers into a module-level `Map` and an
 * env resolver that reads `process.env` do not belong in a package two browser
 * apps import, so the registry and the env resolution are the server's to build
 * on top of {@link AGENCY_FLAGS}. `FlagDefinition` has no `validate` predicate
 * (a function), and none of these flags needs one.
 */

import type { AllListed } from './primitives';

export type FlagScope = 'global' | 'tenant' | 'account';
export type FlagType = 'boolean' | 'number' | 'string' | 'json';

/** A flag definition, without `validate` (see the module note). */
export interface FlagDefinition<T = unknown> {
  /** Unique catalog key (matches the `feature_flag_overrides.flag_key`). */
  key: string;
  type: FlagType;
  /** Resolved fallback when no override row and no env default apply. */
  default: T;
  description: string;
  /** Owning team/domain. */
  owner: string;
  /** Which override scopes are permitted for this flag. */
  scopes: FlagScope[];
  /** Optional boot-time default override env var (e.g. staging = on). */
  envVar?: string;
  /** May be returned to tenant-facing clients (the `/api/v1/feature-flags` surface). */
  clientExposed?: boolean;
  /** Future: deterministic percentage bucketing by tenant. */
  rollout?: { percentByTenant?: boolean };
}

/**
 * The definitions, frozen as the dialer runtime's `defineFlag` freezes each one
 *. Keyed by flag key.
 */
export const AGENCY_FLAGS = Object.freeze({
  /*
   * The agency analysis switch. Agency legs are `webrtc_calls` rows, and this flag
   * gates end-of-call analysis (transcription and the analysis worker) for them.
   *
   * ── `default: false`, deliberately ─────────────────────────────────────────
   *
   * Do not "fix" this default to true. A tenant that never asked for analysis
   * would otherwise get a metered, consent-sensitive feature, including every
   * tenant created afterwards. Analysis is a per-call transcription cost, so that
   * blast radius is a bill. With no override row the gate returns false, nothing
   * is enqueued, and `analysis_status` stays NULL with no error anywhere — that is
   * the intended off state. Turn it on per tenant or account with an override row,
   * where it can be scoped, attributed and removed.
   */
  agency_call_analysis: {
    key: 'agency_call_analysis',
    type: 'boolean',
    // Gated: costs money, consent-sensitive — see above.
    default: false,
    envVar: 'FF_AGENCY_CALL_ANALYSIS', // staging: FF_AGENCY_CALL_ANALYSIS=true
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true, // the console shows/hides the agency analysis UI
    owner: 'voice',
    description: 'Post-call analysis (transcript + summary + dimensions) for agency campaign calls',
  },

  // ── Agency dialer (human-agent outbound power dialing) ──────────────────────
  // Off by default. v1 has no settlement, so the flag is the per-tenant /
  // per-account kill switch for the dialer.
  agency_dialer_enabled: {
    key: 'agency_dialer_enabled',
    type: 'boolean',
    default: false,
    envVar: 'FF_AGENCY_DIALER', // staging: FF_AGENCY_DIALER=true
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true, // the console shows/hides the Agent + Supervisor consoles
    owner: 'voice',
    description: 'Agency dialer: human-agent outbound power dialing (campaigns, agent stations, pacing engine)',
  },

  // ── Late binding: attach the agent at the ANSWER, not before the dial ───────
  //
  // Off changes nothing: `executeDial` writes the `reserved` panel to the agent's
  // socket and attaches it to the bridge before the carrier is dialed, so the
  // agent watches the call ring. On, the panel is built at dial time but held, the
  // leg is placed with no browser socket at all, and both the panel and the socket
  // are delivered synchronously at the carrier answer — so a dial that rings out,
  // is busy, fails or finds an unreachable handset reaches the console as
  // *nothing*. A dial answered by VOICEMAIL still reaches the agent: the carrier
  // reports it `answered` like any other, and answering-machine detection is out of scope, so
  // nothing can tell a machine from a human before the bind (see
  // `contracts.ts` on `AgencyAttemptOutcome`). Shortening that greeting is a
  // wrap-up problem, not a binding one.
  //
  // Two things it is NOT, because both would be reasonable guesses:
  //
  //  1. **It is not over-dialing.** The pacing tick still places at most one dial
  //     per idle agent (`pacing-engine.ts`'s `to_dial`), so the fan-out is
  //     unchanged. Late binding fixes the idle *experience*; only over-dialing
  //     moves idle *time*, and that is blocked on a carrier that can cancel a
  //     ringing leg (`ProviderCapabilities.cancelRinging`) and on a floor of five
  //     or more agents — at two the marginal-abandonment arithmetic allows no
  //     extra dials at all.
  //  2. **It is not provider-gated in code.** VoiceLink is the intended first
  //     cohort, because that is where a cancelled ring silently keeps ringing and
  //     answers into a dismissed console — but the gate is this flag and the
  //     adapter capability, never a branch on a provider name. A per-provider
  //     branch here is how the next carrier gets the wrong behaviour by default.
  //
  // ⚠️ The bind runs INSIDE the 1s `ABANDONMENT_BRIDGE_GRACE_MS` budget
  // (`src/agency/abandonment-predicate.ts`): everything after the answer and
  // before the socket is attached is time the compliance predicate counts as a
  // call that reached nobody. That is why the bind path is synchronous and why the
  // panel's contact context is fetched at dial time rather than at the answer.
  // Anything added to it — an AMD dwell, a second round trip — spends that budget.
  agency_late_binding: {
    key: 'agency_late_binding',
    type: 'boolean',
    default: false,
    envVar: 'FF_AGENCY_LATE_BINDING', // staging: FF_AGENCY_LATE_BINDING=true
    scopes: ['global', 'tenant', 'account'],
    // NOT client-exposed: the console receives the same frames in the same order,
    // just later, so there is nothing for the console to show or hide. A flag the client
    // can read is a flag the client can branch on, and the whole point here is
    // that the console needs no knowledge of when the bind happened.
    owner: 'voice',
    description: 'Agency dialer: bind the agent to a campaign call at the carrier answer instead of before the dial',
  },

  // ── The soft phone: an agent dials a typed number outside pacing ────────────
  //
  // `docs/softphone.md`. Off by default, like the dialer: it places real calls on
  // the account's numbers and its outcomes can move roster contacts (SP6), so a
  // tenant gets it by an override row, scoped and attributed. On, EVERY agent in
  // the account has it (SP4, Manas 2026-10-30): there is no per-agent switch, and
  // `agency.softphone.dial` floors at `agent`. Every soft-phone route checks it
  // (`softphone_disabled`), and the console shows the soft phone's nav item and
  // the station's "Switch to soft phone" on it, so it is client-exposed.
  agency_softphone_enabled: {
    key: 'agency_softphone_enabled',
    type: 'boolean',
    default: false,
    envVar: 'FF_AGENCY_SOFTPHONE', // staging: FF_AGENCY_SOFTPHONE=true
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true, // the console shows/hides the soft phone
    owner: 'voice',
    description: 'Agency soft phone: agents dial a typed number from the browser, outside campaign pacing',
  },

  // ── The console's call audio on the station socket: A-law, or the PCM16 fallback ──
  //
  // On, the web console opens its station socket with `media=alaw8`: binary G.711
  // A-law 8 kHz frames both ways (`agency/station.ts`, `AgencyStationMediaFormat`),
  // which the server relays to and from VoiceLink without a transcode. Off, it asks
  // for `media=pcm16`: base64 PCM16 16 kHz in JSON, transcoded on the server for every
  // frame. There is no quality difference (the carrier leg is A-law 8 kHz either way);
  // the difference is server CPU per relayed frame, which is what decides how many
  // simultaneous calls one process carries.
  //
  // ── `default: true`, deliberately, unlike every flag above ─────────────────────
  //
  // It is not a capability being granted, it is the way BACK: a tenant whose agents
  // hit a problem with the A-law path is switched to `pcm16` with an override row
  // (`false`), no deploy. The console reads it at each station connect, so the switch
  // reaches an agent on their next socket. A console that cannot read the flags uses
  // `pcm16` (it fails closed to the format every server speaks), and the mobile app
  // ignores it: it always speaks `alaw8`.
  agency_console_alaw8: {
    key: 'agency_console_alaw8',
    type: 'boolean',
    default: true,
    envVar: 'FF_AGENCY_CONSOLE_ALAW8', // FF_AGENCY_CONSOLE_ALAW8=false: every tenant on pcm16
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true, // the console picks its station socket's media format from it
    owner: 'voice',
    description: 'Agency console call audio as binary A-law 8 kHz on the station socket (media=alaw8); off falls back to base64 PCM16 (media=pcm16)',
  },

  // ── Contact assignment, agent-led retry and outcome overrides ────────────────
  //
  // Gates the SURFACE: the supervisor's assignment operations and progress, the agent's own
  // contact list, agent retry, and setting a campaign's `assignment_mode` to anything but
  // `pool`, `allow_agent_retry` on, or an outcome `override`. Off, every one of those answers
  // `403 assignment_disabled` (the campaign settings `feature_disabled`), and the console and app
  // hide them.
  //
  // It does NOT gate the runtime: pacing reads `assignment_mode` as stored, so turning the flag
  // off for a tenant with a running `strict` campaign keeps that campaign strict (its agents'
  // queues and callbacks keep working) rather than suddenly dialling every agent's contacts to
  // everyone. Pause it and set it back to `pool` to stop it.
  agency_contact_assignment_enabled: {
    key: 'agency_contact_assignment_enabled',
    type: 'boolean',
    default: false,
    envVar: 'FF_AGENCY_CONTACT_ASSIGNMENT', // staging: FF_AGENCY_CONTACT_ASSIGNMENT=true
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true, // the console and the app show/hide assignment, My contacts and agent retry
    owner: 'voice',
    description: 'Agency contact assignment: supervisors assign roster contacts to agents, agents work their own queue, agent-led retry and outcome overrides',
  },

  // ── Reports: agent, campaign and account exports (PDF and Excel) ─────────────
  //
  // `docs/reports.md` (RP10). Gates every report route (`403 feature_disabled` when off), the
  // assembler and the subscription tick's new runs for the tenant/account, and the console's
  // Reports page and export entry points. Off by default: a report renders on our own compute
  // (a Lambda or headless Chromium) and stores files for 90 days, so a tenant gets it by an
  // override row, scoped and attributed. The download route is gated too, so turning it off
  // also hides runs already rendered (their files still expire on the usual lifecycle).
  agency_reports_enabled: {
    key: 'agency_reports_enabled',
    type: 'boolean',
    default: false,
    envVar: 'FF_AGENCY_REPORTS', // staging: FF_AGENCY_REPORTS=true
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true, // the console shows/hides Reports and the export buttons
    owner: 'voice',
    description: 'Agency reports: agent, campaign and account performance reports as PDF and Excel, ad hoc or on a schedule',
  },
} satisfies Record<string, FlagDefinition<boolean>>);

/** The seven agency flag keys. */
export type AgencyFlagKey = keyof typeof AGENCY_FLAGS;

export const AGENCY_FLAG_KEYS = [
  'agency_dialer_enabled',
  'agency_late_binding',
  'agency_call_analysis',
  'agency_softphone_enabled',
  'agency_console_alaw8',
  'agency_contact_assignment_enabled',
  'agency_reports_enabled',
] as const satisfies readonly AgencyFlagKey[];

const _allFlagKeysListed: AllListed<AgencyFlagKey, typeof AGENCY_FLAG_KEYS> = true;
void _allFlagKeysListed;

/** Flags whose resolved values may reach a browser (`clientExposed: true`). */
export type ClientExposedAgencyFlagKey = {
  [K in AgencyFlagKey]: (typeof AGENCY_FLAGS)[K] extends { clientExposed: true } ? K : never;
}[AgencyFlagKey];

/**
 * The client-exposed flag map the console reads (the agency successor of
 * `GET /proxy/feature-flags` → the console `FeatureFlagMap`), narrowed to agency's
 * exposed keys. `agency_late_binding` is deliberately absent — see its comment.
 */
export type AgencyClientFlagMap = Record<ClientExposedAgencyFlagKey, boolean>;
