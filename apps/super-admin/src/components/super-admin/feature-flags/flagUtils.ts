/**
 * Pure helpers shared by the per-tenant and platform-wide feature-flag
 * surfaces. Kept side-effect free so both the tenant detail tab and the global
 * registry page can import without pulling in component state.
 */
import type { FeatureFlagCatalogEntry, FlagScopeType } from '@magick-agency/contracts/api/platform/super-admin';

/** Tri-state selection derived from the presence/value of an override. */
export type TriState = 'inherit' | 'on' | 'off';

/**
 * Can this flag be overridden at this scope? Mirrors the server's registry `scopes`
 * declaration, which its write path enforces with a 422 — so every surface that
 * offers an edit affordance must gate on this, or it ships a control whose only
 * possible outcome is a server rejection.
 *
 * Flags with narrower scopes (`prewarm_enabled`, `prewarm_ring_delay_ms`,
 * `ai_turn_transcript_logging`) are not in agency's registry; they survive only
 * as unregistered TEST FIXTURES, as does `webrtc_max_duration_seconds`, which is
 * a per-account setting rather than a flag. Every agency flag has all three
 * scopes, so today this gate never refuses a real flag.
 *
 * KEEP IN STEP with `scopes` in the server's feature-flag registry —
 * the catalog response carries them per flag, so this reads them rather than
 * hard-coding a list.
 */
export function canEditAtScope(flag: FeatureFlagCatalogEntry, scope: FlagScopeType): boolean {
  return flag.scopes.includes(scope);
}

/**
 * May this flag be offered in the cross-tenant bulk rollout? The modal writes
 * `true`/`false` at tenant scope, so the flag must be boolean and
 * tenant-scopable — and the server's `policy.bulk_allowed` must not forbid it.
 * The server refuses such a bulk write (422) regardless; this keeps the UI from
 * offering an action whose only outcome is that refusal.
 */
export function canBulkRollOut(flag: FeatureFlagCatalogEntry): boolean {
  return flag.type === 'boolean'
    && flag.scopes.includes('tenant')
    && flag.policy?.bulk_allowed !== false;
}

/**
 * Is turning this flag ON the guarded direction? True for flags whose policy
 * asks for a reason to enable (e.g. transcript logging): there, OFF is the safe
 * state, so a "turn it off?" confirm — written for capabilities a tenant loses —
 * is friction pointing the wrong way.
 */
export function isGuardedWhenOn(flag: FeatureFlagCatalogEntry): boolean {
  return flag.policy?.reason_required_to_enable === true;
}

/*
 * the `whatsapp` and `sip` tokens, the SIP / knowledge-base /
 * catalog / document KEY_LABELS and their NUMERIC_FLAG_BOUNDS entries are deleted
 * (those features are out of scope). `prewarm_*` and `webrtc_max_duration_seconds`
 * stay: the numeric-dialog and scope-gate tests drive them as fixtures.
 */

/**
 * Per-token label overrides so flag keys render with correct product/brand
 * casing instead of naive title-case (e.g. `ivr` → `IVR`, not
 * `Ivr`). Add entries here as new acronym/brand tokens appear in keys.
 */
const TOKEN_LABELS: Record<string, string> = {
  ivr: 'IVR',
  tts: 'TTS',
  stt: 'STT',
  api: 'API',
  sms: 'SMS',
  ai: 'AI',
  url: 'URL',
  id: 'ID',
  ui: 'UI',
  ms: '(ms)',
  kb: 'KB',
};

/**
 * Full-key label overrides for flags whose default humanization reads as
 * jargon. Prefer this over stretching `TOKEN_LABELS` when the fix is per-flag.
 */
const KEY_LABELS: Record<string, string> = {
  prewarm_enabled: 'Pre-warm AI pipeline on ringing',
  prewarm_ring_delay_ms: 'Pre-warm ring delay (ms)',
  webrtc_max_duration_seconds: 'WebRTC max call duration (seconds)',
};

/** Render a snake_case flag key for humans: `agency_dialer_enabled` → `Agency Dialer Enabled`. */
export function humanize(key: string): string {
  return KEY_LABELS[key] ?? key
    .split('_')
    .map((w) => TOKEN_LABELS[w] ?? (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Strict boolean coercion — only the literal `true` is On (everything else Off). */
export function asBool(value: unknown): boolean {
  return value === true;
}

/**
 * Map an override's value (or its absence) to a tri-state. `undefined`/`null`
 * means "no override at this scope" → inherit.
 */
export function toTriState(value: unknown): TriState {
  if (value === undefined || value === null) return 'inherit';
  return asBool(value) ? 'on' : 'off';
}

/** Relative, human expiry label for an ISO timestamp (`in 7d`, `in 4h`, `expired`). */
export function relativeExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) return `in ${days}d`;
  // Never round down to "in 0h" for a still-future expiry.
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `in ${hours}h`;
}

/**
 * Client-side bounds for numeric flags, mirroring the server's registry `validate`
 * fns (e.g. `isRingDelay` for `prewarm_ring_delay_ms`). Purely for pre-flight
 * validation and the input `(min..max)` label; server always re-validates and
 * returns 422 on breach. Add an entry here when a new numeric flag lands so
 * the dialog can show a real inline error instead of falling through to a
 * generic server-side 422 at the top of the page. `hint` shows up as the
 * input placeholder.
 *
 * KEEP IN SYNC with the `validate` fns in
 * the server's feature-flag registry. A less-brittle long-term fix
 * would be to expose `min`/`max` in the catalog response.
 */
export interface NumericFlagBounds {
  min?: number;
  max?: number;
  hint?: string;
  /** Arrow-key step for the number input; defaults to 1 for count-like flags. */
  step?: number;
}

const NUMERIC_FLAG_BOUNDS: Record<string, NumericFlagBounds> = {
  prewarm_ring_delay_ms: { min: 0, max: 30_000, step: 100, hint: 'e.g. 3000 (milliseconds)' },
  webrtc_max_duration_seconds: { min: 60, max: 14_400, step: 60, hint: 'e.g. 1800 (seconds)' },
};

/**
 * Returns bounds for a known numeric flag, or `{}` for unknown ones (which
 * suppresses the `(min..max)` label suffix and lets the integer check do the
 * loose gating). Unknown numeric flags still pre-flight through
 * `Number.isInteger`, and the server re-validates on write.
 */
export function numericBoundsFor(flagKey: string): NumericFlagBounds {
  return NUMERIC_FLAG_BOUNDS[flagKey] ?? {};
}
