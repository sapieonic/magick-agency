/*
 * The public-API audit record, in `models/platform/` because `models/audit.model.ts`
 * is the dialer-side audit model (docs/seams.md; same convention as
 * `apps/server/src/audit/platform/`).
 *
 *  - The catalog types and `AuditActorFields` live in
 *    `apps/server/src/audit/platform/`, which this package cannot import. So the
 *    actor union is declared HERE and `audit-actor.ts` re-exports it (one
 *    definition), and `CreateAuditLogInput` takes the action and resource-type
 *    unions as type parameters. The server binds them to the catalog in
 *    `apps/server/src/audit/platform/audit-logger.ts` (`PlatformCreateAuditLogInput`),
 *    which is what every call site writes through — so a write that is not in the
 *    catalog is still a type error at the call site. The repository accepts the
 *    unparameterised (string) form.
 *  - The `api_key` actor branch and `api_key_id` are gone (no API
 *    keys; the baseline dropped `platform_audit_log.api_key_id`).
 */

/**
 * The actor half of an audit row — see `apps/server/src/audit/platform/audit-actor.ts`,
 * which re-exports this as `AuditActorFields` and carries the rationale.
 * There is no `| { actor_type: 'api_key'; api_key_id?: string }` branch
 * (no API keys).
 */
export type AuditActorFields =
  | { actor_type: 'human'; user_id: string }
  | { actor_type: 'system' };

/** The `actor_type` values this service writes (the audit catalog's, minus `api_key`). */
export type PlatformAuditActorType = AuditActorFields['actor_type'];

export interface AuditLogRecord {
  id: string;
  tenant_id: string;
  account_id: string | null;
  user_id: string | null;
  /**
   * What kind of principal acted. NULL on rows with no recorded principal —
   * see {@link PlatformAuditActorType}. NULL is "unknowable", not a fourth value,
   * and no reader may collapse it into one: `normalizeMasterRow` bridges it to
   * the inference the activity trail makes without the column, so
   * those rows keep rendering as they always did.
   */
  actor_type: PlatformAuditActorType | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  campaign_id: string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  created_at: Date;
}

/**
 * One audited write.
 *
 * ── The actor is REQUIRED, and it is an intersection rather than three fields ─
 * `AuditActorFields` is a discriminated union (`src/audit/audit-actor.ts`), so
 * every call site must state what kind of principal acted, and can only supply
 * the identity field that kind actually has. Making it required is the mechanism
 * that made this platform-wide rather than another special case: adding the
 * column without it would have left 29 call sites free to keep stamping `user_id`
 * alone, and a fix that covered only four of them was rejected. `npm run lint` is `tsc --noEmit`, so a forgotten call site does
 * not compile.
 *
 * `user_id` and `api_key_id` therefore do NOT appear as independent optional
 * fields here — they arrive through the union, which is what stops an `api_key`
 * row from also naming a human.
 *
 * Precisely: that holds for an object LITERAL, which is every call site in this
 * service — excess-property checking rejects all four bad shapes. It does not
 * hold through a spread of a pre-built variable, where excess-property checking
 * does not apply. `AuditRepository.insertBatch` is therefore the backstop rather
 * than a belt-and-braces nicety: it reads each id off the discriminant, so a
 * `user_id` smuggled onto an `api_key` row is discarded before it reaches a
 * column (pinned by an `as never` case in the repository's test).
 */
export type CreateAuditLogInput<
  PlatformAuditAction extends string = string,
  PlatformAuditResourceType extends string = string,
> = AuditActorFields & {
  tenant_id: string;
  account_id?: string;
  action: PlatformAuditAction;
  resource_type: PlatformAuditResourceType;
  resource_id?: string;
  campaign_id?: string;
  details?: Record<string, unknown>;
  ip_address?: string;
};
