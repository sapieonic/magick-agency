import type { FeatureFlagPolicy } from '@magick-agency/contracts/api/platform/super-admin';

/*
 * Flag handling policies: the few flags whose change needs more than a toggle on the super-admin
 * screens. The super-admin flag routes (`super-admin-feature-flags.routes.ts`) serve a flag's
 * policy on the catalog and the detail read (`FeatureFlagCatalogEntry.policy`, which the
 * super-admin UI reads for its warning, its reason dialog and its bulk rollout list) and ENFORCE
 * it on every write:
 *  - `reason_required_to_enable`: an override that turns the flag ON (value `true`) at tenant or
 *    account scope needs a non-blank reason (`400 flag_reason_required`). Turning it off, and
 *    deleting an override, need none: off is the safe direction.
 *  - `bulk_allowed: false`: the cross-tenant bulk rollout refuses the flag whatever the value
 *    (`422 flag_bulk_not_allowed`), and so does a GLOBAL override that turns it on, which is every
 *    tenant at once. A global `false` (a kill switch) stays allowed.
 * A flag absent from this map is ordinary. Only boolean flags have policies.
 */

/** Live call listening's consent gate (LS1, the guard rails of LS20). */
const LIVE_LISTEN_POLICY: FeatureFlagPolicy = Object.freeze({
  warning:
    'Live call listening lets this tenant\'s supervisors hear calls in progress. Turn it on only for a '
    + 'tenant whose callers are told calls may be monitored: every inbound route that can be listened to '
    + 'plays a notice that mentions monitoring (or agency_live_listen_unrecorded is off), and its agents '
    + 'know. Follow the enablement checklist in the operations runbook, one tenant or account at a time.',
  bulk_allowed: false,
  reason_required_to_enable: true,
});

const FLAG_POLICIES: ReadonlyMap<string, FeatureFlagPolicy> = new Map([
  ['agency_live_listen_enabled', LIVE_LISTEN_POLICY],
]);

/** The flag's handling policy, or undefined for an ordinary flag. */
export function flagPolicy(flagKey: string): FeatureFlagPolicy | undefined {
  return FLAG_POLICIES.get(flagKey);
}

/** The flag keys that have a policy (tests). */
export function flagPolicyKeys(): string[] {
  return [...FLAG_POLICIES.keys()];
}

/** A write the policy refuses: the status and the first-party body the route sends. */
export interface FlagPolicyRefusal {
  status: 400 | 422;
  body: { error: string; code: 'flag_reason_required' | 'flag_bulk_not_allowed'; message: string };
}

function bulkRefusal(flagKey: string, message: string): FlagPolicyRefusal {
  return { status: 422, body: { error: 'Bulk Not Allowed', code: 'flag_bulk_not_allowed', message: `Flag '${flagKey}': ${message}` } };
}

/**
 * Does the flag's policy refuse this override upsert? Null when it may be written. Runs after the
 * scope and value checks, so a value of the wrong type or a scope the flag does not permit is
 * refused for that first.
 */
export function checkOverridePolicy(
  flagKey: string,
  write: { scope_type: 'global' | 'tenant' | 'account'; value?: unknown; reason?: string | null },
): FlagPolicyRefusal | null {
  const policy = flagPolicy(flagKey);
  if (!policy || write.value !== true) return null;
  if (write.scope_type === 'global' && !policy.bulk_allowed) {
    return bulkRefusal(flagKey, 'it cannot be turned on for every tenant at once. Turn it on for one tenant or account, with a reason.');
  }
  if (policy.reason_required_to_enable && !(write.reason ?? '').trim()) {
    return {
      status: 400,
      body: { error: 'Reason Required', code: 'flag_reason_required', message: `Flag '${flagKey}': turning it on needs a reason (shown in the audit log).` },
    };
  }
  return null;
}

/** Does the flag's policy refuse the cross-tenant bulk rollout? Null when it may run. */
export function checkBulkPolicy(flagKey: string): FlagPolicyRefusal | null {
  const policy = flagPolicy(flagKey);
  if (!policy || policy.bulk_allowed) return null;
  return bulkRefusal(flagKey, 'it is never rolled out to several tenants at once. Turn it on for one tenant or account, with a reason.');
}
