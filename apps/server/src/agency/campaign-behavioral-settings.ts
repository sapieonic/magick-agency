import type { FastifyReply, FastifyRequest } from 'fastify';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { createChildLogger } from '@magick-agency/observability';
import { DEFAULT_ALLOW_RECORDING, DEFAULT_ANALYZE_CALLS } from '../settings/agency-account-settings.js';

const log = createChildLogger({ component: 'campaign-behavioral-settings' });

/*
 * PORT NOTE (magick-agency): ported from magick-master@a1f0756a
 * `src/api/routes/proxy-agency-campaigns.routes.ts:412-575` (MAG-138 —
 * `assertBehavioralCapabilitiesForConfig`, `assertCampaignBehavioralCapabilities`,
 * `resolveInheritedBehavioralConfig`) into its own module, so the Phase 8 campaign
 * routes (lane B2's port of that route file) call ONE definition instead of a
 * second copy inside the route file.
 *
 * The one plan change (§3.2): the two governance capabilities became two columns
 * of the per-account settings row. `agency.recording` is
 * `account_settings.allow_recording`; `agency.analytics` is
 * `account_settings.analyze_calls`. Master's `assertCapability(request, reply,
 * key)` resolved `governance[key] === false`; here the check reads the row for
 * (`request.tenantId`, `request.accountId`) and refuses unless the column is
 * EXPLICITLY true — a NULL column resolves to the documented default `false`
 * (`settings/agency-account-settings.ts`), the same default the governance keys
 * had (`agency.md` §7.2). Master's two other paths are gone with governance: the
 * `config.governance.enabled` kill switch (no governance) and the section-level
 * `requireCapability('agency')` (the app IS agency). Failure posture is master's:
 * no tenant context, or a settings read that throws, FAILS CLOSED with the same
 * 403. NEW: no ACCOUNT context also fails closed, because the settings are
 * per-account and a campaign always belongs to one; master resolved governance at
 * tenant level when the header was absent.
 *
 * The refusal body is master's established `{ error: 'capability_disabled',
 * capability }` with master's capability names, so the console's handling of it
 * ports unchanged.
 *
 * ── Two INTERFACE changes vs master, both because this is a new boundary ─────
 * (security review of d2e33bc, lead.)
 *  1. **The account checked is the campaign's, passed as `target`.** Master's
 *     gate was tenant-level governance and core scoped the campaign, so the
 *     capability and the campaign could not belong to different accounts. Here
 *     the setting is per account, so reading the request's `X-Account-Id` would
 *     let a PATCH or retry on a campaign in account X, sent with account Y's
 *     header, be judged by Y's settings. The caller passes the ids of the account
 *     that OWNS the campaign being created, patched or retried (the loaded
 *     campaign's own ids; the request's on create). A missing id fails closed.
 *  2. **There is no `request.body` convenience.** Master's
 *     `assertCampaignBehavioralCapabilities(request, reply)` inspected the raw
 *     body; the Phase 8 routes act on their Zod-PARSED output, and anything the
 *     schema accepts that a raw key check does not see (coercion, a default, an
 *     alias, a nested field) would be a gap. Callers MUST pass exactly the object
 *     they persist — the parsed create/patch body, or for a retry
 *     `resolveInheritedBehavioralConfig`'s output.
 */

/** The two behavioral capabilities and the settings column each now reads. */
export const BEHAVIORAL_SETTING_COLUMN = {
  'agency.recording': 'allow_recording',
  'agency.analytics': 'analyze_calls',
} as const;

export type BehavioralCapability = keyof typeof BEHAVIORAL_SETTING_COLUMN;

/**
 * The account that OWNS the campaign being written. Optional members only so a
 * caller holding no id still reaches the fail-closed path rather than a type error.
 */
export interface BehavioralTarget {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
}

/** The two facts the gate needs, already resolved to booleans. */
export interface BehavioralSettings {
  allow_recording: boolean;
  analyze_calls: boolean;
}

export interface BehavioralRefusal {
  error: 'capability_disabled';
  capability: BehavioralCapability;
}

/**
 * ─── MAG-138: the two `behavioral` capabilities, actually enforced ───────────
 *
 * (master's header, kept for its rationale) `agency.recording` and
 * `agency.analytics` were declared with `enforcement: ['nav', 'behavioral']`, but
 * until this guard existed only the `nav` half was real: a tenant with
 * `agency.recording` OFF could record human↔human calls with one curl. For a
 * consent-bearing capability that is not a thin spot in defence-in-depth, it is
 * the absence of the defence.
 *
 * ── Refuse, do not silently strip ───────────────────────────────────────────
 * Stripping the field looks kinder and is worse. A supervisor turns recording
 * on, the save succeeds, the screen shows it on, and the absence is discovered
 * months later by whoever needed the recording. A 403 naming the capability is
 * the only outcome that tells the operator the truth while they can still act
 * on it.
 *
 * ── Only ENABLING is refused ────────────────────────────────────────────────
 * `record_calls: false`, an absent `record_calls`, and `analysis_profile_id:
 * null` all pass even with the capability off. Refusing those would strand a
 * tenant that LOSES the capability: it could no longer edit the campaign at all
 * and — the perverse case — could no longer turn recording OFF. The gate exists
 * to stop the feature being switched on, not to freeze the campaign.
 *
 * ── Why not a strict `=== true` ─────────────────────────────────────────────
 * The column is a `BOOLEAN` and Postgres coerces `'true'`, `'t'`, `'yes'` and `1`
 * on the way in. A strict identity check would therefore be bypassable by
 * spelling the value as a string. So anything that is not an explicit `false`,
 * `null` or absent counts as enabling — fail-closed. The price is that a malformed
 * *disabling* spelling (`record_calls: 'false'`) is refused too; real callers send
 * JSON booleans, and an ambiguous value on a consent gate is the right thing to
 * be wrong about in the safe direction.
 *
 * PORT NOTE (magick-agency): the decision, as a pure function over the resolved
 * settings — master interleaved it with `assertCapability`'s I/O. Returns the
 * FIRST refusal in master's order (recording, then analytics), exactly the
 * capability master's sequential `await`s would have named.
 */
export function behavioralRefusalForConfig(
  config: unknown,
  settings: BehavioralSettings,
): BehavioralRefusal | null {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  const record = config as Record<string, unknown>;

  const recordCalls = record['record_calls'];
  if (recordCalls !== undefined && recordCalls !== null && recordCalls !== false) {
    if (settings.allow_recording !== true) return { error: 'capability_disabled', capability: 'agency.recording' };
  }

  const analysisProfileId = record['analysis_profile_id'];
  if (analysisProfileId !== undefined && analysisProfileId !== null) {
    if (settings.analyze_calls !== true) return { error: 'capability_disabled', capability: 'agency.analytics' };
  }

  return null;
}

/** Does this config ask for either behavioral feature at all? (Then no read is needed.) */
function enablesAnything(config: unknown): boolean {
  return behavioralRefusalForConfig(config, { allow_recording: false, analyze_calls: false }) !== null;
}

/**
 * The effective settings row for the target (tenant, account), or `null` when
 * there is no context to resolve against. A NULL column is the documented
 * default (`false`). Throws on a read failure; the caller fails closed.
 */
async function resolveBehavioralSettings(target: BehavioralTarget): Promise<BehavioralSettings | null> {
  const { tenantId, accountId } = target;
  if (!tenantId || !accountId) return null;
  const row = await accountSettingsRepository.findByTenantAndAccount(tenantId, accountId);
  return {
    allow_recording: row?.allow_recording ?? DEFAULT_ALLOW_RECORDING,
    analyze_calls: row?.analyze_calls ?? DEFAULT_ANALYZE_CALLS,
  };
}

/**
 * Returns true to proceed. On refusal the established
 * `{ error: 'capability_disabled', capability }` 403 has already been sent, so the
 * caller must `return` immediately.
 *
 * ── The config is a PARAMETER, and the retry create is why ─────────────────
 * On create and patch the config being enabled is literally the request body,
 * (its parsed form). On
 * `POST /campaigns/:id/retry` it is not: a retry INHERITS its parent's config
 * (DR-10) and the body may name none of it, so the thing that has to be checked
 * is the parent's values with `config_overrides` applied on top. Reading
 * `request.body` there would assert the capability against a body that says
 * nothing and pass every time — a gate that is only ever handed the one input on
 * which it cannot fail. See `resolveInheritedBehavioralConfig`.
 */
export async function assertBehavioralCapabilitiesForConfig(
  _request: FastifyRequest,
  reply: FastifyReply,
  /** The schema-PARSED config the route will persist (see the module header). */
  config: unknown,
  /** The account that owns the campaign (see the module header). */
  target: BehavioralTarget,
): Promise<boolean> {
  // PORT NOTE (magick-agency): master called `assertCapability` only for a field
  // that enables something, so a disabling body never read governance. Same here:
  // a body that enables nothing passes without a settings read, which is what
  // keeps the on→off write available to an account that has LOST the permission.
  if (!enablesAnything(config)) return true;

  let settings: BehavioralSettings | null;
  try {
    settings = await resolveBehavioralSettings(target);
  } catch (err) {
    log.error({ err }, 'account settings resolve failed in behavioral assert — failing closed');
    settings = null;
  }
  // No context, or a failed read ⇒ every enabling field is refused (fail closed).
  const refusal = behavioralRefusalForConfig(config, settings ?? { allow_recording: false, analyze_calls: false });
  if (refusal) {
    reply.code(403).send(refusal);
    return false;
  }
  return true;
}

/*
 * PORT NOTE (magick-agency): master's `assertCampaignBehavioralCapabilities(request,
 * reply)` — the create/patch convenience that passed the RAW `request.body` — is
 * deliberately not ported (interface change 2 in the module header). Create and
 * patch call `assertBehavioralCapabilitiesForConfig` with their parsed body.
 */

/**
 * The EFFECTIVE behavioral config a retry campaign would be created with:
 * the parent's values, with `config_overrides` applied on top. (master
 * `proxy-agency-campaigns.routes.ts:499-575`, verbatim; its full rationale is
 * there.)
 *
 * ── An override wins in BOTH directions, which is why this is a merge ──────
 * `config_overrides: { record_calls: false }` on a recording parent is a retry
 * that does not record, and must not be refused for a capability it is turning
 * OFF. `{ record_calls: true }` on a non-recording parent must be refused. So the
 * override is applied when the KEY IS PRESENT, not when it is truthy: an
 * explicit `null`/`false` is an opinion, and `??` would have discarded it.
 *
 * ── An absent key on the parent FAILS CLOSED ───────────────────────────────
 * An absent key is read as ENABLING: `record_calls` absent is treated as
 * `true`, `analysis_profile_id` absent as set. A tenant that HOLDS the
 * capability is unaffected — the gate passes either way — and a tenant that does
 * not is refused rather than silently having a consent-gated feature switched on
 * by a copy.
 *
 * ── `Object.hasOwn`, not `in` ──────────────────────────────────────────────
 * `in` walks the prototype chain. `'record_calls' in overrides` is true for an
 * overrides object carrying a polluted prototype, which reads as "the caller is
 * turning recording OFF" — passing the gate — while the parent's `true` is
 * copied.
 */
export function resolveInheritedBehavioralConfig(
  parentCampaign: unknown,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const parent = (parentCampaign && typeof parentCampaign === 'object' && !Array.isArray(parentCampaign))
    ? (parentCampaign as Record<string, unknown>)
    : {};
  /** What an unreadable parent is assumed to hold. See the header. */
  const FAIL_CLOSED = {
    record_calls: true,
    analysis_profile_id: '__unreported_by_core__',
  } as const;
  const effective: Record<string, unknown> = {};
  for (const key of ['record_calls', 'analysis_profile_id'] as const) {
    if (overrides && Object.hasOwn(overrides, key)) effective[key] = overrides[key];
    else if (Object.hasOwn(parent, key)) effective[key] = parent[key];
    else effective[key] = FAIL_CLOSED[key];
  }
  return effective;
}
