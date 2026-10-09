import {
  AGENCY_FLAGS,
  type FlagDefinition as ContractFlagDefinition,
  type FlagScope,
  type FlagType,
} from '@magick-agency/contracts/flags';

/**
 * Feature-flag registry — the single source of truth for *which* flags exist.
 *
 * Code declares flags (type, default, scope, owner, description); data
 * (`feature_flag_overrides` rows) sets per-tenant/account/global values. A typo'd
 * or unknown flag key is rejected at write time because it isn't in this catalog.
 *
 * Deliberately dependency-light: it reads `process.env` directly for boot-time
 * `envVar` defaults rather than importing `config/index.js`, so it stays free of
 * the config graph (the service, routes, and CallManager all import the registry).
 *
 * PORT NOTE (magick-agency): ported from core `src/feature-flags/registry.ts`
 * (v1.123.2). The catalog keeps ONLY the three agency flags, and their
 * definitions are not restated here: each is `defineFlag`'d from
 * `AGENCY_FLAGS` in `@magick-agency/contracts/flags`, which carries core's
 * keys, defaults, scopes, env vars, owners, descriptions and comments verbatim.
 * `FlagScope` / `FlagType` are the contracts' (identical to core's), and
 * `FlagDefinition` is the contracts' interface plus core's `validate`
 * predicate (a function, so it cannot live in a package the browser apps import).
 * `test/unit/feature-flags/registry-contracts.test.ts` pins that the two agree.
 * Removed: every AI/softphone/messaging/KB/SIP flag and all the value
 * validators (none of the agency flags declares one); `webrtc_max_duration_seconds`
 * moved to `account_settings` (plan §3.2). Each is listed in PORTING.md.
 */

export type { FlagScope, FlagType };

export interface FlagDefinition<T = unknown> extends ContractFlagDefinition<T> {
  /** Enum/range checks beyond the base type. Returns false to reject a value. */
  validate?: (v: unknown) => boolean;
}

const FLAG_REGISTRY = new Map<string, FlagDefinition>();

/** Register a flag definition, freeze it, and return it. Throws on duplicate key. */
export function defineFlag<T>(def: FlagDefinition<T>): FlagDefinition<T> {
  if (FLAG_REGISTRY.has(def.key)) {
    throw new Error(`Duplicate feature flag registration: ${def.key}`);
  }
  const frozen = Object.freeze({ ...def }) as FlagDefinition<T>;
  FLAG_REGISTRY.set(def.key, frozen as FlagDefinition);
  return frozen;
}

/** Look up a flag definition by key. */
export function getFlag(key: string): FlagDefinition | undefined {
  return FLAG_REGISTRY.get(key);
}

/** Every registered flag definition. */
export function allFlags(): FlagDefinition[] {
  return [...FLAG_REGISTRY.values()];
}

/** Flags that may be returned to tenant-facing clients. */
export function clientExposedFlags(): FlagDefinition[] {
  return allFlags().filter((f) => f.clientExposed === true);
}

/**
 * The boot-time default: `parse(process.env[envVar]) ?? def.default`. Boolean
 * parsing mirrors the config schema's `envBoolean` ("false"/"0"/"no"/"" are
 * falsey, any other non-empty string is truthy); a number that fails to parse
 * falls back to the registry default; json is parsed leniently.
 */
export function resolveEnvDefault(def: FlagDefinition): unknown {
  const raw = def.envVar ? process.env[def.envVar] : undefined;
  if (raw === undefined || raw === null) return def.default;

  switch (def.type) {
    case 'boolean':
      return !['false', '0', 'no', ''].includes(raw.toLowerCase().trim());
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : def.default;
    }
    case 'string':
      return raw;
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        return def.default;
      }
    default:
      return def.default;
  }
}

/**
 * Declared flags. Add new flags here; the override table never needs a schema
 * change. Defaults are prod-safe (gated capabilities default off).
 *
 * PORT NOTE (magick-agency): core's order of the three agency entries is kept
 * (`agency_call_analysis`, `agency_dialer_enabled`, `agency_late_binding`);
 * their rationale comments live beside the definitions in
 * `packages/contracts/src/flags.ts`.
 */
export const FLAGS = {
  agency_call_analysis: defineFlag<boolean>(AGENCY_FLAGS.agency_call_analysis),

  agency_dialer_enabled: defineFlag<boolean>(AGENCY_FLAGS.agency_dialer_enabled),

  agency_late_binding: defineFlag<boolean>(AGENCY_FLAGS.agency_late_binding),
} as const;
