/*
 * PORT NOTE (magick-agency): ported from master `src/db/models/audit.model.ts`
 * (v3.24.0) to `models/platform/` because core's `models/audit.model.ts` already
 * holds that path (docs/seams.md §1 collision; same convention the lead set for
 * `apps/server/src/audit/platform/`). Changes, each in PORTING.md:
 *
 *  - Master imported the catalog types and `AuditActorFields` from
 *    `src/audit/{catalog,audit-actor}.ts`. Those live in
 *    `apps/server/src/audit/platform/`, which this package cannot import. So the
 *    actor union is declared HERE and `audit-actor.ts` re-exports it (one
 *    definition), and `CreateAuditLogInput` takes the action and resource-type
 *    unions as type parameters. The server binds them to the catalog in
 *    `apps/server/src/audit/platform/audit-logger.ts` (`PlatformCreateAuditLogInput`),
 *    which is what every call site writes through — so a write that is not in the
 *    catalog is still a type error at the call site. The repository accepts the
 *    unparameterised (string) form.
 *  - The `api_key` actor branch and `api_key_id` are gone (decision #5: no API
 *    keys; the baseline dropped `platform_audit_log.api_key_id`).
 */

/**
 * The actor half of an audit row — see `apps/server/src/audit/platform/audit-actor.ts`,
 * which re-exports this as `AuditActorFields` and carries master's rationale.
 * Master's `| { actor_type: 'api_key'; api_key_id?: string }` branch is removed
 * (no API keys).
 */
export type AuditActorFields =
  | { actor_type: 'human'; user_id: string }
  | { actor_type: 'system' };

/** The `actor_type` values this service writes (master's catalog minus `api_key`). */
export type PlatformAuditActorType = AuditActorFields['actor_type'];

export interface AuditLogRecord {
  id: string;
  tenant_id: string;
  account_id: string | null;
  user_id: string | null;
  /**
   * What kind of principal acted. NULL on rows written before migration 067 —
   * see {@link PlatformAuditActorType}. NULL is "unknowable", not a fourth value,
   * and no reader may collapse it into one: `normalizeMasterRow` bridges it to
   * the inference the activity trail made before the column existed, so
   * historical rows keep rendering as they always did.
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
 * that made 86d45t7rm platform-wide rather than another special case: adding the
 * column without it would have left 29 call sites free to keep stamping `user_id`
 * alone, and the review that produced this ticket rejected a fix that covered
 * four of them. `npm run lint` is `tsc --noEmit`, so a forgotten call site does
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
