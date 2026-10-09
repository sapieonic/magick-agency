import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { buildAgencyAccountSettingsMap } from '../settings/agency-account-settings.js';
import { createChildLogger } from '@magick-agency/observability';
import type { MembershipRecord } from '@magick-agency/db/models/membership.model';
import type { TenantRecord } from '@magick-agency/db/models/tenant.model';
import type { AgencyAccountSettingsMap } from '@magick-agency/contracts/api/platform/settings';

const log = createChildLogger({ component: 'session-payload' });

/**
 * The body `POST /auth/session` answers with, built in one place.
 *
 * ── Why it is a shared function and not three copies ────────────────────────
 * `POST /invites/:token/claim` must return **exactly** this shape, because the
 * whole point of that endpoint is that the SPA can reuse its existing
 * `SessionResponse` type unchanged: an invited agent finishes claiming and is
 * already signed in, with no second round trip to `/auth/session` and no second
 * response type to keep in step. A second transcription of the three lookups
 * plus the settings resolve is exactly how the two would drift — and the
 * drift would be invisible, because both endpoints would keep returning
 * well-formed JSON that merely disagreed about what a session contains.
 *
 * The three lookups are also not interchangeable with anything simpler.
 * `findAllByUserId` orders by `created_at DESC`, so `memberships[0]`, "the
 * primary context", means "the most recent membership" — a rule that lives here
 * rather than being re-derived at each call site.
 */
export interface SessionPayload {
  user: unknown;
  tenants: TenantRecord[];
  memberships: MembershipRecord[];
  /** Effective per-account settings, keyed by `account_id`. */
  settings: AgencyAccountSettingsMap;
  is_new: false;
}

/**
 * Resolve the effective per-account settings map for the caller, fail-open.
 *
 * The contract keys the map by `account_id` across EVERY account the active
 * memberships reach (decision Q3 (a)).
 *
 * A resolver/DB error must never break login — on throw we log and return an
 * empty map.
 *
 * The fail-open posture matters more on the claim path than on the login path,
 * and for a reason worth stating: a claim that threw here would have already
 * spent the invite and bound the identity, so the 500 would be reported for work
 * that succeeded, and the recipient's link would be gone.
 */
export async function resolveSettingsSafe(
  memberships: MembershipRecord[],
): Promise<AgencyAccountSettingsMap> {
  try {
    return await buildAgencyAccountSettingsMap(memberships);
  } catch (err) {
    log.warn({ err }, 'account settings resolve failed; sending empty map');
    return {};
  }
}

/**
 * Assemble the session body for a user who already exists.
 *
 * `is_new` is hard-coded `false` and typed as the literal, which is deliberate:
 * every caller of this function is a path where the user was found or adopted,
 * never provisioned. `POST /auth/session` never provisions an unknown user (path
 * 4 answers `403 no_membership`), so no session body here is ever `is_new: true`.
 *
 * `user` is passed in rather than re-read, because the two callers hold
 * different rows at this point: the session path holds the row it just adopted,
 * and the claim path holds the row its transaction returned. Re-reading here
 * would add a query whose only effect could be to disagree with the write that
 * just committed.
 *
 * ── `findAllByUserId` is deliberately UNSCOPED, and filtering it would be the
 *    wrong fix for the right worry ──────────────────────────────────────────
 * It lists every active membership the row holds, in every tenant — which is
 * what a session IS, and what the tenant switcher renders. On the claim path
 * that once meant a token minted in one workspace could return a `tenant_owner`
 * membership in another, because `POST /users/invite` REUSES a `users` row
 * whenever the address is already known and a `pending_` stub can therefore be
 * several workspaces' pending invitee at once.
 *
 * The fix is at the BIND, not here: `AdoptIdentityOptions.confineStubToTenantId`
 * refuses to activate a stub carrying active memberships outside the invite's
 * tenant, so by the time this function runs the row is either confined to that
 * tenant or was ALREADY the claimant's own identity — in which case every
 * membership on it is genuinely theirs and narrowing the list would hide their
 * other workspaces from them on the one screen that exists to list them. A
 * tenant filter here would also have to be threaded through the session path,
 * which has no invite and no single tenant to filter to.
 */
export async function buildSessionPayload(
  user: unknown,
  userId: string,
): Promise<SessionPayload> {
  const memberships = await membershipRepository.findAllByUserId(userId);
  const tenants = await tenantRepository.listByUserId(userId);
  const settings = await resolveSettingsSafe(memberships);
  return { user, tenants, memberships, settings, is_new: false };
}
