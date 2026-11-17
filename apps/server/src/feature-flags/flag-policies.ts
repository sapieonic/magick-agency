import { logger } from '@magick-agency/observability';
import type { FeatureFlagPolicy } from '@magick-agency/contracts/api/platform/super-admin';
import { allFlags, getFlag, resolveEnvDefault } from './registry.js';

/*
 * Flag handling policies: the few flags whose change needs more than a toggle on the super-admin
 * screens, declared on the flag's definition (`FlagDefinition.policy`, `packages/contracts/src/flags.ts`;
 * today `agency_live_listen_enabled`, LS1, LS20). The super-admin flag routes (`super-admin-feature-flags.routes.ts`) serve a flag's
 * policy on the catalog and the detail read (`FeatureFlagCatalogEntry.policy`, which the
 * super-admin UI reads for its warning, its reason dialog and its bulk rollout list) and ENFORCE
 * it on every write:
 *  - `reason_required_to_enable`: an override that turns the flag ON (value `true`) at tenant or
 *    account scope needs a non-blank reason (`400 flag_reason_required`). Turning it off, and
 *    deleting an override, need none: off is the safe direction.
 *  - `bulk_allowed: false`: the cross-tenant bulk rollout refuses the flag whatever the value
 *    (`422 flag_bulk_not_allowed`), and so does a GLOBAL override that turns it on, which is every
 *    tenant at once. A global `false` (a kill switch) stays allowed.
 * A flag without a policy is ordinary. Only boolean flags have policies.
 *
 * One path the routes cannot see: a flag's env default (`envVar`, the boot-time global default).
 * `FF_AGENCY_LIVE_LISTEN=true` turns the consent gate on for every tenant, with no reason and no
 * audit row, which is what a global On through the routes is refused for. It is kept for dev and
 * staging, and boot says so in a warning ({@link warnOfEnvDefaultsPastPolicy}, LS22 p).
 */

/** The flag's handling policy, or undefined for an ordinary (or unregistered) flag. */
export function flagPolicy(flagKey: string): FeatureFlagPolicy | undefined {
  return getFlag(flagKey)?.policy;
}

/**
 * The flags with a policy that refuses a global On (`bulk_allowed: false`) whose env default turns
 * them on for every tenant now.
 */
export function envDefaultsPastPolicy(): Array<{ flag: string; envVar: string }> {
  const past: Array<{ flag: string; envVar: string }> = [];
  for (const def of allFlags()) {
    if (!def.policy || def.policy.bulk_allowed) continue;
    if (!def.envVar || resolveEnvDefault(def) !== true) continue;
    past.push({ flag: def.key, envVar: def.envVar });
  }
  return past;
}

/** At boot: one warning line for each of {@link envDefaultsPastPolicy}. Answers how many. */
export function warnOfEnvDefaultsPastPolicy(
  warn: (fields: Record<string, string>, msg: string) => void = (f, m) => logger.warn(f, m),
): number {
  const past = envDefaultsPastPolicy();
  for (const p of past) {
    warn(p, `${p.envVar} turns ${p.flag} on for every tenant, with no reason and no audit row, past the flag's `
      + 'handling policy (it refuses a global On): dev and staging only. In production, unset it and turn the '
      + 'flag on per tenant or account through the super-admin flag routes.');
  }
  return past.length;
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
