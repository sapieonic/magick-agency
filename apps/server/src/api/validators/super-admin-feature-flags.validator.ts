import { z } from 'zod';
import type { FlagDefinition } from '../../feature-flags/registry.js';

// Validation for the super-admin feature-flag management endpoints
// (/super-admin/feature-flags/*). These mirror core's
// /internal/feature-flags/* contract — master validates the request shape early
// and core re-validates authoritatively (per-flag value-type checks, scope
// permissions), passing 404/422 back through.
//
// PORT NOTE (magick-agency): hop collapse. There is no core behind this route,
// so the "core re-validates" half now runs in-process in the route handler,
// using `validateFlagValue` below (core `src/api/validators/feature-flags.validator.ts`,
// ported here verbatim because this module is its only consumer). Core's own
// body schemas (`upsertOverrideSchema` …) differed from master's only by the S2S
// `updated_by` field, which is now the authenticated super admin's id read from
// the request, never from the body — so they are not carried.
// `tenant_id` / `account_id` are `.uuid()`: `feature_flag_overrides.tenant_id` /
// `account_id` are UUID columns in the baseline (core's were VARCHAR), and a
// malformed id would otherwise reach Postgres as `22P02` — a 500 for a bad request.

/** Scope/column coherence shared by upsert + delete bodies. */
const scopeCoherence = (
  data: { scope_type: 'global' | 'tenant' | 'account'; tenant_id?: string; account_id?: string },
  ctx: z.RefinementCtx,
): void => {
  if (data.scope_type === 'global') {
    if (data.tenant_id || data.account_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'global scope must not carry tenant_id/account_id' });
    }
  } else if (data.scope_type === 'tenant') {
    if (!data.tenant_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tenant scope requires tenant_id' });
    if (data.account_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tenant scope must not carry account_id' });
  } else {
    if (!data.tenant_id || !data.account_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account scope requires tenant_id and account_id' });
    }
  }
};

export const resolveFlagsQuerySchema = z.object({
  tenant_id: z.string().uuid(),
  account_id: z.string().uuid().optional(),
});

export const upsertFlagOverrideSchema = z
  .object({
    scope_type: z.enum(['global', 'tenant', 'account']),
    tenant_id: z.string().uuid().optional(),
    account_id: z.string().uuid().optional(),
    value: z.unknown(),
    reason: z.string().max(500).nullable().optional(),
    // UTC-only (Zulu) to match core's authoritative `z.string().datetime()` —
    // keeps master from accepting an offset form (e.g. +05:30) that core 422s.
    expires_at: z.string().datetime().nullable().optional(),
  })
  .superRefine(scopeCoherence);

export const deleteFlagOverrideSchema = z
  .object({
    scope_type: z.enum(['global', 'tenant', 'account']),
    tenant_id: z.string().uuid().optional(),
    account_id: z.string().uuid().optional(),
  })
  .superRefine(scopeCoherence);

export const bulkFlagOverrideSchema = z.object({
  tenant_ids: z.array(z.string().uuid()).min(1).max(1000),
  value: z.unknown(),
  reason: z.string().max(500).nullable().optional(),
});

/**
 * Validate an override value against a flag's declared type + optional
 * registry `validate`. Returns an error message, or `null` when valid. The type
 * fidelity check lives here (not the DB) because it depends on the flag.
 *
 * PORT NOTE (magick-agency): core `src/api/validators/feature-flags.validator.ts`
 * @4850d1d9, verbatim.
 */
export function validateFlagValue(flag: FlagDefinition, value: unknown): string | null {
  switch (flag.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return `value must be a boolean for flag '${flag.key}'`;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `value must be a number for flag '${flag.key}'`;
      break;
    case 'string':
      if (typeof value !== 'string') return `value must be a string for flag '${flag.key}'`;
      break;
    case 'json':
      if (value === undefined) return `value is required for flag '${flag.key}'`;
      break;
  }
  if (flag.validate && flag.validate(value) === false) {
    return `value failed validation for flag '${flag.key}'`;
  }
  return null;
}
