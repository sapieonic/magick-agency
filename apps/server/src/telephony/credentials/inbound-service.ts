// Inbound on a tenant's Plivo credential, the operator side (`docs/inbound.md` §3.1, §8.1,
// §8.2; IB6: only super-admins, since it writes to the tenant's carrier account):
//
//  - Enable: one Plivo Application on the tenant's account (answer, hangup and fallback answer
//    URLs, `inbound-urls.ts`), its id, URLs and the purpose token's hash stored on the credential.
//  - Disable: the Application deleted and forgotten; refused while a number is linked.
//  - Health: the Application's live URLs compared with the stored ones.
//  - Re-point: the Application given this server's URLs now and a new token (the old one still
//    accepted for `INBOUND_TOKEN_REPOINT_GRACE_SECONDS`); an Application gone from the account
//    is made again and every linked number moved onto it.
//  - Link / Unlink a number: its app on Plivo set to the Application (the app it was on kept,
//    and restored by Unlink). Never on sync.
//  - The §8.2 cascade (`release*`): a number that may no longer be answered (unassigned from the
//    tenant, retired by a sync or by hand) loses its route and its link at once, and is put back
//    on its previous app at the carrier while the credential still works. Revoke is refused while
//    inbound is enabled (`TelephonyCredentialService.revoke`). Disabling the credential keeps
//    every link and route: its calls are answered with the closed message while it is disabled
//    (docs/inbound.md §10), and enabling it again answers them as before.
//
// Partial failures. Each operator write that calls the carrier runs its carrier WRITE inside ONE
// database transaction that holds the credential row (`lockInbound`, or `FOR SHARE` for a link)
// together with the row that records it, and the commit is the last step: a carrier refusal rolls
// the write back, so the database never claims what the carrier does not have. (Enable, Link,
// Unlink and Re-point make the carrier call first and write after; Disable writes first and
// deletes the Application after, in the same transaction, so the outcome is the same.) The
// carrier's read-only answers that a write starts from (Enable's find-by-name, Link's current
// app) are read before the lock, so the row and a pool connection are held only across the
// carrier writes. What is left is a commit failing after the carrier accepted, and each has its
// way back:
//  - Enable: the Application exists but is not stored. Its name is fixed per credential
//    (`inbound-<credential id>`), so the next Enable finds it by name and adopts it (new URLs
//    and token) instead of making another. An Application made inside a transaction that then
//    fails before the commit is deleted on the spot (best effort; the name finds it otherwise).
//  - Re-point: the Application carries a token the database does not know, so inbound calls
//    are refused until the next Re-point; the health check says `url_mismatch` meanwhile.
//  - Disable: the Application is gone but still stored: the health check says `app_missing`,
//    and the next Disable reads Plivo's 404 as done.
//  - Link: the number is on the Application but not linked: the next Link finds it already
//    there, and keeps no previous app (it cannot know it; logged).
//  - Unlink: the number is back on its app but still linked: the next Unlink sets it again.
// The cascade is the other way round: the database is cleared first and always (a number that
// may not be answered must stop routing whatever the carrier says), then the carrier is asked
// to restore the previous app; a failure there is logged and audited with the app id, so it can
// be put back by hand.
//
// Every write is audited in `super_admin_audit_log` with the inbound actions
// (`INBOUND_SUPER_ADMIN_AUDIT_ACTIONS`): ids, the app id and numbers only, never a token or URL.
import type { PoolClient } from 'pg';
import { createChildLogger } from '@magick-agency/observability';
import { withTransaction, type TransactionPool } from '@magick-agency/db/utils/transaction';
import type { TelephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import type { PhoneNumberRepository } from '@magick-agency/db/repositories/phone-number.repository';
import type { TelephonyCredentialInboundRecord } from '@magick-agency/db/models/telephony-credential.model';
import type { PhoneNumberInboundLinkRecord } from '@magick-agency/db/models/phone-number.model';
import type {
  InboundSuperAdminAuditAction,
  PhoneNumberInboundBlocker,
  PhoneNumberInboundLink,
  PhoneNumberInboundResponse,
  TelephonyCredentialInbound,
  TelephonyCredentialInboundHealthCheck,
  TelephonyCredentialInboundHealthResponse,
  TelephonyCredentialInboundResponse,
  TelephonyCredentialInboundUrl,
} from '@magick-agency/contracts/api/platform/super-admin-inbound';
import type { TelephonyCredentialErrorCode } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import type { AgencyInboundCallRepository, AgencyInboundRouteRepository } from '../../db/repositories/agency.repository.js';
import type { SuperAdminAuditEntry } from '../../audit/super-admin-audit.js';
import {
  CredentialUnavailableError,
  type ResolvedCredential,
  type ServiceResult,
  type TelephonyCredentialService,
} from './credential-service.js';
import { hashInboundToken, INBOUND_TOKEN_REPOINT_GRACE_SECONDS, mintInboundToken } from '../plivo/inbound-token.js';
import { PLIVO_INBOUND_ROUTES, plivoInboundUrls, splitInboundToken, type PlivoInboundUrls } from '../plivo/inbound-urls.js';
import { PlivoApiError, type PlivoApplication } from '../plivo/plivo-inbound.wire.js';
import type { PlivoAdapter } from '../plivo/plivo.adapter.js';

const log = createChildLogger({ component: 'telephony-inbound' });

/** The carrier that answers inbound calls here. A credential on any other is refused. */
const INBOUND_PROVIDER = 'plivo';

/** The Plivo REST calls inbound makes (`PlivoAdapter`'s inbound members). */
export type InboundCarrierApi = Pick<PlivoAdapter,
  | 'createInboundApplication' | 'getInboundApplication' | 'updateInboundApplication' | 'deleteInboundApplication'
  | 'findInboundApplications' | 'getNumberApp' | 'setNumberApp'>;

/** Who is acting: the super-admin, for the audit row. */
export interface InboundActor {
  adminId: string;
  adminEmail: string;
}

/**
 * Why a number's link is being released (`details.cause` on `phone_number.inbound_unlinked`):
 * `unlinked` by hand; the §8.2 cascade's `unassigned` (from its credential's tenant),
 * `retired_by_sync` (no longer on the carrier account), `retired` or `deleted` (by a
 * super-admin). (Audit rows written before disabling a credential stopped releasing its links
 * may carry `credential_disabled`.)
 */
export type InboundReleaseCause = 'unlinked' | 'unassigned' | 'retired_by_sync' | 'retired' | 'deleted';

/**
 * What became of the number at the carrier when its link was released: put back on its previous
 * app (`restored`), not on the account any more (`number_missing`), not asked because the number
 * is not active (retired: not the account's; `skipped_not_active`), or the carrier could not be
 * asked or refused (`failed`: the audit row keeps the app id to put it back by hand).
 */
export type InboundCarrierRestore = 'restored' | 'number_missing' | 'skipped_not_active' | 'failed';

/** The Application's fixed name on the tenant's account: how an Application we lost track of is found again. */
export function inboundApplicationName(credentialId: string): string {
  return `inbound-${credentialId}`;
}

export interface TelephonyInboundServiceDeps {
  /** Opens the credential's secret (`resolve`): the carrier is asked with the tenant's own account. */
  credentials: Pick<TelephonyCredentialService, 'resolve'>;
  repo: Pick<TelephonyCredentialRepository, 'findById' | 'findInbound' | 'lockInbound' | 'enableInbound' | 'repointInbound' | 'disableInbound' | 'inboundTokenMatches'>;
  numbers: Pick<PhoneNumberRepository, 'findInboundLink' | 'listInboundForCredential' | 'linkInbound' | 'clearInboundLink' | 'findUnroutedMissed'>;
  routes: Pick<AgencyInboundRouteRepository, 'detachNumberEverywhere'>;
  /** The inbound spine: whether a call answered under the token a Re-point would drop is still live. */
  calls: Pick<AgencyInboundCallRepository, 'anyLiveArrivedBefore'>;
  /** The carrier client on a resolved credential (`createPlivoAdapter`). */
  carrierFor(credential: ResolvedCredential): InboundCarrierApi;
  /**
   * `PLIVO_WEBHOOK_BASE_URL` and `PLIVO_INBOUND_FALLBACK_ANSWER_URL`, read per call; and
   * `MEDIA_WORKERS` (IB8: with workers on, nobody is put through to an agent).
   */
  settings(): { webhookBaseUrl: string; inboundFallbackAnswerUrl: string; mediaWorkers: number };
  /** `recordSuperAdminAudit`. */
  audit(entry: SuperAdminAuditEntry): void;
  pool: TransactionPool;
}

type Failure = Extract<ServiceResult<never>, { ok: false }>;
const fail = (code: TelephonyCredentialErrorCode, message: string): Failure => ({ ok: false, code, message });

/** A refusal decided inside a transaction: thrown to roll it back, answered by the caller. */
class Refusal extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A carrier failure as a route answer. */
function carrierFailure(err: PlivoApiError): Failure {
  switch (err.kind) {
    case 'auth_rejected':
      return fail('carrier_rejected', 'Plivo refused the stored credential. Nothing was changed. Verify or rotate the secret, then try again.');
    case 'unreachable':
      return fail('carrier_unreachable', 'Plivo could not be reached. Nothing was changed. Try again shortly.');
    case 'refused':
      return fail('carrier_refused', `Plivo refused the request (${err.status === null ? 'unreadable answer' : `HTTP ${err.status}`}). Nothing was changed.`);
  }
}

/** A credential whose secret cannot be opened for the purpose, as a route answer. */
function unavailable(err: CredentialUnavailableError): Failure {
  switch (err.kind) {
    case 'store_unconfigured': return fail('credential_store_unavailable', 'No credential keyring is configured');
    case 'not_found': return fail('not_found', 'Credential not found');
    case 'status': return fail('credential_not_active', 'The credential cannot be used for this in its current status');
    default: return fail('secret_unavailable', 'The credential’s stored secret cannot be opened; restore its master key or rotate the secret');
  }
}

/** Run `fn`, turning the failures a caller answers (a refusal, the carrier, the secret) into results. */
async function answer<T>(fn: () => Promise<T>): Promise<ServiceResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof Refusal) return err.failure;
    if (err instanceof PlivoApiError) return carrierFailure(err);
    if (err instanceof CredentialUnavailableError) return unavailable(err);
    throw err;
  }
}

/** Why a number cannot be linked now, from its link read; null when it can (or already is). */
export function inboundLinkBlocker(rec: PhoneNumberInboundLinkRecord): PhoneNumberInboundBlocker | null {
  if (!rec.telephony_credential_id) return 'not_synced';
  if (rec.status !== 'active') return 'not_active';
  if (!rec.assigned) return 'not_assigned';
  if (rec.credential_status !== 'active') return 'credential_not_active';
  if (!rec.credential_app_id) return 'inbound_not_enabled';
  return null;
}

const BLOCKER_MESSAGE: Record<PhoneNumberInboundBlocker, string> = {
  not_synced: 'Only a number synced from a tenant’s Plivo credential can be linked to inbound',
  not_active: 'The number is not active',
  not_assigned: 'The number is not assigned to its credential’s tenant',
  credential_not_active: 'The number’s credential is not active',
  inbound_not_enabled: 'Inbound is not enabled on the number’s credential: enable it on the credential first',
};

/**
 * Whether a linked number may stay linked: still on the account (`active`) and assigned to the
 * credential's tenant. The credential's status is not this rule's: a disabled credential, or one
 * the carrier refused (`invalid`), keeps its links, and its calls are answered with the closed
 * message while the signature verifies (§10); enabled again, it answers them as before.
 */
const mayStayLinked = (rec: PhoneNumberInboundLinkRecord): boolean => rec.status === 'active' && rec.assigned;

function linkOf(rec: PhoneNumberInboundLinkRecord): PhoneNumberInboundLink {
  return {
    linked: rec.inbound_linked_at !== null,
    linked_at: iso(rec.inbound_linked_at),
    previous_app_id: rec.inbound_previous_app_id,
    route: rec.route_id ? { id: rec.route_id, name: rec.route_name!, account_id: rec.route_account_id! } : null,
  };
}

function inboundOf(rec: TelephonyCredentialInboundRecord): TelephonyCredentialInbound {
  return {
    enabled: rec.app_id !== null,
    app_id: rec.app_id,
    enabled_at: iso(rec.enabled_at),
    linked_numbers: rec.linked_numbers,
    previous_token_expires_at: iso(rec.previous_token_expires_at),
  };
}

export class TelephonyInboundService {
  constructor(private readonly deps: TelephonyInboundServiceDeps) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The credential's inbound state and its numbers. */
  async state(credentialId: string): Promise<ServiceResult<TelephonyCredentialInboundResponse>> {
    const inbound = await this.deps.repo.findInbound(credentialId);
    if (!inbound) return fail('not_found', 'Credential not found');
    return { ok: true, value: await this.stateOf(inbound) };
  }

  /** A number's link and whether it can be linked now. */
  async numberState(phoneNumberId: string): Promise<ServiceResult<PhoneNumberInboundResponse>> {
    const rec = await this.deps.numbers.findInboundLink(phoneNumberId);
    if (!rec) return fail('phone_number_not_found', 'Phone number not found');
    return { ok: true, value: await this.numberStateOf(rec) };
  }

  /**
   * The Application compared with what is stored: `app_missing` when Plivo has no such
   * Application, `unreachable` when Plivo could not be asked, `url_mismatch` naming each URL
   * whose address, method or (for the answer and hangup URLs) token is not the stored one.
   */
  async health(credentialId: string): Promise<ServiceResult<TelephonyCredentialInboundHealthResponse>> {
    const inbound = await this.deps.repo.findInbound(credentialId);
    if (!inbound) return fail('not_found', 'Credential not found');
    if (!inbound.app_id) return fail('inbound_not_enabled', 'Inbound is not enabled on this credential');
    return answer(async () => {
      const carrier = await this.carrier(credentialId, 'call_control');
      let health: TelephonyCredentialInboundHealthCheck;
      const checkedAt = new Date().toISOString();
      const current = this.storedUrlsCurrent(inbound);
      try {
        const app = await carrier.getInboundApplication(inbound.app_id!);
        if (!app) {
          health = { health: 'app_missing', mismatched: [], stored_urls_current: current, checked_at: checkedAt };
        } else {
          const mismatched = await this.mismatches(inbound, app);
          health = { health: mismatched.length ? 'url_mismatch' : 'ok', mismatched, stored_urls_current: current, checked_at: checkedAt };
        }
      } catch (err) {
        if (!(err instanceof PlivoApiError) || err.kind !== 'unreachable') throw err;
        health = { health: 'unreachable', mismatched: [], stored_urls_current: current, checked_at: checkedAt };
      }
      return { inbound: inboundOf(inbound), health };
    });
  }

  // ── The credential's Application ──────────────────────────────────────────

  /** Enable inbound: make (or adopt, by name) the Application and store it. */
  async enable(credentialId: string, actor: InboundActor): Promise<ServiceResult<TelephonyCredentialInboundResponse>> {
    const pre = await this.precheck(credentialId);
    if (!pre.ok) return pre;
    if (pre.value.status !== 'active') return fail('credential_not_active', `Inbound is enabled only on an active credential; this one is ${pre.value.status}`);
    if (pre.value.app_id) return fail('inbound_enabled', 'Inbound is already enabled on this credential');
    const urls = this.urlsNow(credentialId);
    if (!urls) return this.unconfigured();
    const result = await answer(async () => {
      const carrier = await this.carrier(credentialId, 'dial');
      // Read-only, so before the row is locked: an Application of ours an earlier Enable left
      // unstored. Stale by the time of the lock only if another Enable ran meanwhile, and that one
      // stored its Application, which the lock's `app_id` check then refuses on.
      const named = await carrier.findInboundApplications(inboundApplicationName(credentialId));
      return withTransaction(async (client) => {
        const locked = await this.lockOrRefuse(credentialId, client);
        if (locked.status !== 'active') throw new Refusal(fail('credential_not_active', 'The credential stopped being active; nothing was changed'));
        if (locked.app_id) throw new Refusal(fail('inbound_enabled', 'Inbound is already enabled on this credential'));
        const { token, tokenHash } = mintInboundToken();
        const placed = await this.placeApplication(carrier, credentialId, urls, token, named);
        try {
          const stored = await this.deps.repo.enableInbound(credentialId, { ...this.storedForm(urls), appId: placed.appId, tokenHash }, actor.adminId, { client });
          // We hold the row and checked it: a miss here is a bug, not a race.
          if (!stored) throw new Error('enableInbound wrote nothing on a locked, active, not-enabled credential');
          return { stored, placed };
        } catch (err) {
          if (placed.created) await this.deleteQuietly(carrier, placed.appId, credentialId);
          throw err;
        }
      }, { pool: this.deps.pool });
    });
    if (!result.ok) return result;
    const { stored, placed } = result.value;
    log.info({ credentialId, appId: placed.appId, adopted: !placed.created }, 'Inbound enabled on a telephony credential');
    this.audit(actor, 'telephony_credential.inbound_enabled', 'telephony_credential', credentialId, {
      tenant_id: stored.tenant_id, provider: stored.provider, app_id: placed.appId,
      adopted_existing_application: !placed.created, fallback: urls.fallbackMethod === 'GET' ? 'external' : 'own',
    });
    return { ok: true, value: await this.stateOf(stored) };
  }

  /**
   * Disable inbound: delete the Application at the carrier and forget it. Refused while any of
   * the credential's numbers is linked. A credential the carrier refuses that is not active
   * (disabled or invalid: the tenant closed or rotated the account) cannot delete it, and may
   * forget it anyway, audited with its app id (`application_deleted: false`), so a dead account
   * never blocks the revoke; an active one must delete it.
   */
  async disable(credentialId: string, actor: InboundActor): Promise<ServiceResult<TelephonyCredentialInboundResponse>> {
    const pre = await this.precheck(credentialId);
    if (!pre.ok) return pre;
    if (!pre.value.app_id) return fail('inbound_not_enabled', 'Inbound is not enabled on this credential');
    if (pre.value.linked_numbers > 0) return this.numbersLinked(pre.value.linked_numbers);
    const result = await answer(async () => {
      const carrier = await this.carrier(credentialId, 'call_control');
      return withTransaction(async (client) => {
        const locked = await this.lockOrRefuse(credentialId, client);
        if (!locked.app_id) throw new Refusal(fail('inbound_not_enabled', 'Inbound is not enabled on this credential'));
        if (locked.linked_numbers > 0) throw new Refusal(this.numbersLinked(locked.linked_numbers));
        const off = await this.deps.repo.disableInbound(credentialId, actor.adminId, { client });
        if (!off.ok) throw new Error(`disableInbound refused (${off.reason}) on a locked credential with no linked number`);
        let deleted: 'deleted' | 'not_found' | 'refused_credential';
        try {
          deleted = await carrier.deleteInboundApplication(locked.app_id);
        } catch (err) {
          if (!(err instanceof PlivoApiError) || err.kind !== 'auth_rejected' || locked.status === 'active') throw err;
          deleted = 'refused_credential';
        }
        return { appId: locked.app_id, tenantId: locked.tenant_id, provider: locked.provider, deleted, inbound: off.inbound };
      }, { pool: this.deps.pool });
    });
    if (!result.ok) return result;
    const r = result.value;
    if (r.deleted === 'refused_credential') {
      log.warn({ credentialId, appId: r.appId }, 'Inbound disabled without deleting the Application: the carrier refuses this credential; remove it by hand');
    } else {
      log.info({ credentialId, appId: r.appId, alreadyGone: r.deleted === 'not_found' }, 'Inbound disabled on a telephony credential');
    }
    this.audit(actor, 'telephony_credential.inbound_disabled', 'telephony_credential', credentialId, {
      tenant_id: r.tenantId, provider: r.provider, app_id: r.appId,
      application_deleted: r.deleted !== 'refused_credential', application_already_gone: r.deleted === 'not_found',
    });
    return { ok: true, value: await this.stateOf(r.inbound) };
  }

  /**
   * Re-point: the Application gets this server's URLs now and a new token; the replaced token
   * stays accepted for `INBOUND_TOKEN_REPOINT_GRACE_SECONDS` (calls answered before it post
   * their hangup with it). An Application gone from the account is made again (or adopted by
   * name) and every linked number still on the account moved onto it.
   *
   * **Two Re-points inside one call's life.** The credential keeps one previous token, so a
   * second Re-point drops the first one's. That is refused (`inbound_previous_token_in_use`)
   * while a call answered BEFORE the last Re-point is still live on the credential (its hangup
   * carries the token that would be dropped); otherwise the previous token is no longer needed
   * and is replaced. The last Re-point's time is the previous token's expiry less the grace. A
   * call lasts at most `WEBRTC_MAX_DURATION_SECONDS` and the sweep ends any older, so the refusal
   * lasts at most about four hours after a Re-point, and only while such a call is live.
   */
  async repoint(credentialId: string, actor: InboundActor): Promise<ServiceResult<TelephonyCredentialInboundResponse>> {
    const pre = await this.precheck(credentialId);
    if (!pre.ok) return pre;
    if (!pre.value.app_id) return fail('inbound_not_enabled', 'Inbound is not enabled on this credential');
    const urls = this.urlsNow(credentialId);
    if (!urls) return this.unconfigured();
    const result = await answer(async () => {
      const carrier = await this.carrier(credentialId, 'call_control');
      return withTransaction(async (client) => {
        const locked = await this.lockOrRefuse(credentialId, client);
        if (!locked.app_id) throw new Refusal(fail('inbound_not_enabled', 'Inbound is not enabled on this credential'));
        await this.refuseWhilePreviousTokenInUse(locked, client);
        const { token, tokenHash } = mintInboundToken();
        const updated = await carrier.updateInboundApplication(locked.app_id, urls, token);
        let appId = locked.app_id;
        let moved: string[] = [];
        let missing: string[] = [];
        let created = false;
        if (updated === 'not_found') {
          // The rare path (the Application was deleted at Plivo): its find-by-name runs under the
          // lock, bounded by PLIVO_APPLICATIONS_MAX_PAGES.
          const named = (await carrier.findInboundApplications(inboundApplicationName(credentialId))).filter((id) => id !== locked.app_id);
          const placed = await this.placeApplication(carrier, credentialId, urls, token, named);
          appId = placed.appId;
          created = placed.created;
          try {
            ({ moved, missing } = await this.moveLinkedNumbers(carrier, credentialId, appId));
          } catch (err) {
            if (created) await this.deleteQuietly(carrier, appId, credentialId);
            throw err;
          }
        }
        const stored = await this.deps.repo.repointInbound(credentialId, {
          ...this.storedForm(urls), tokenHash, previousTokenGraceSeconds: INBOUND_TOKEN_REPOINT_GRACE_SECONDS,
          ...(appId !== locked.app_id ? { appId } : {}),
        }, actor.adminId, { client });
        if (!stored) throw new Error('repointInbound wrote nothing on a locked, enabled credential');
        return { stored, previousAppId: locked.app_id, appId, moved, missing };
      }, { pool: this.deps.pool });
    });
    if (!result.ok) return result;
    const r = result.value;
    const recreated = r.appId !== r.previousAppId;
    log.info({ credentialId, appId: r.appId, recreated, movedNumbers: r.moved.length, missingNumbers: r.missing.length }, 'Inbound Application re-pointed');
    this.audit(actor, 'telephony_credential.inbound_repointed', 'telephony_credential', credentialId, {
      tenant_id: r.stored.tenant_id, provider: r.stored.provider, app_id: r.appId,
      ...(recreated ? { replaced_app_id: r.previousAppId, moved_numbers: r.moved, numbers_not_on_account: r.missing } : {}),
      previous_token_grace_seconds: INBOUND_TOKEN_REPOINT_GRACE_SECONDS,
    });
    return { ok: true, value: await this.stateOf(r.stored) };
  }

  // ── Numbers ───────────────────────────────────────────────────────────────

  /** Link a number: its app on Plivo becomes the credential's Application; the app it was on is kept. */
  async link(phoneNumberId: string, actor: InboundActor): Promise<ServiceResult<PhoneNumberInboundResponse>> {
    const rec = await this.deps.numbers.findInboundLink(phoneNumberId);
    if (!rec) return fail('phone_number_not_found', 'Phone number not found');
    // Already linked: the carrier was set before the link committed. Nothing to do.
    if (rec.inbound_linked_at) return { ok: true, value: await this.numberStateOf(rec) };
    const blocker = inboundLinkBlocker(rec);
    if (blocker) return fail('phone_number_not_linkable', BLOCKER_MESSAGE[blocker]);
    const credentialId = rec.telephony_credential_id!;
    const appId = rec.credential_app_id!;
    const result = await answer(async () => {
      const carrier = await this.carrier(credentialId, 'dial');
      // Read-only, so before the credential row is held: the app the number is on now (kept as
      // its previous app). Only the write it is recorded with runs under the lock.
      const current = await carrier.getNumberApp(rec.phone_number);
      if (!current) throw new Refusal(this.numberMissing());
      return withTransaction(async (client) => {
        if (current.appId === appId) {
          // On the Application already (a link whose commit failed, or set in Plivo's console):
          // the app it was on before is not known any more.
          log.warn({ phoneNumberId, credentialId, appId }, 'Linking a number already on the inbound Application: its previous app is unknown');
        }
        const previousAppId = current.appId === appId ? null : current.appId;
        const linked = await this.deps.numbers.linkInbound({ phoneNumberId, credentialId, appId, previousAppId }, client);
        if (!linked) throw new Refusal(await this.linkLost(phoneNumberId));
        if (await carrier.setNumberApp(rec.phone_number, appId) === 'not_found') throw new Refusal(this.numberMissing());
        return { previousAppId };
      }, { pool: this.deps.pool });
    });
    if (!result.ok) return result;
    log.info({ phoneNumberId, credentialId, appId }, 'Number linked to inbound');
    this.audit(actor, 'phone_number.inbound_linked', 'phone_number', phoneNumberId, {
      tenant_id: rec.credential_tenant_id, telephony_credential_id: credentialId, phone_number: rec.phone_number,
      app_id: appId, previous_app_id: result.value.previousAppId,
    });
    return this.numberState(phoneNumberId);
  }

  /**
   * Unlink a number by hand: back on its previous app at the carrier, then its link and route
   * cleared. A carrier failure changes nothing (the number keeps being answered); a number no
   * longer on the account is unlinked all the same.
   */
  async unlink(phoneNumberId: string, actor: InboundActor): Promise<ServiceResult<PhoneNumberInboundResponse>> {
    const rec = await this.deps.numbers.findInboundLink(phoneNumberId);
    if (!rec) return fail('phone_number_not_found', 'Phone number not found');
    if (!rec.inbound_linked_at) return fail('phone_number_not_linked', 'The number is not linked to inbound');
    const credentialId = rec.telephony_credential_id!;
    const result = await answer(async () => {
      const carrier = await this.carrier(credentialId, 'call_control');
      return withTransaction(async (client) => {
        const released = await this.clearInTransaction(phoneNumberId, client);
        if (!released) throw new Refusal(fail('phone_number_not_linked', 'The number is not linked to inbound'));
        let restore: InboundCarrierRestore = 'skipped_not_active';
        if (released.cleared.status === 'active') {
          restore = await carrier.setNumberApp(released.cleared.phone_number, released.cleared.inbound_previous_app_id) === 'not_found'
            ? 'number_missing' : 'restored';
        }
        return { ...released, restore };
      }, { pool: this.deps.pool });
    });
    if (!result.ok) return result;
    this.auditRelease(actor, 'unlinked', rec.credential_tenant_id, result.value.cleared, result.value.routeId, result.value.restore);
    return this.numberState(phoneNumberId);
  }

  // ── The §8.2 cascade ──────────────────────────────────────────────────────

  /**
   * After a change to one number (unassigned from its tenant, retired, deleted): if it is linked
   * and may no longer be ({@link mayStayLinked}), release it. Returns whether it was released.
   * Never throws: the change that called it has happened; a failure is logged, and the next
   * reconcile of the credential (every sync) releases it.
   */
  async reconcileNumber(phoneNumberId: string, cause: Exclude<InboundReleaseCause, 'unlinked'>, actor: InboundActor): Promise<boolean> {
    try {
      const rec = await this.deps.numbers.findInboundLink(phoneNumberId);
      if (!rec?.inbound_linked_at || mayStayLinked(rec)) return false;
      return await this.release(rec, cause, actor);
    } catch (err) {
      log.error({ err, phoneNumberId, cause }, 'Inbound cascade failed for a number; the next sync of its credential retries it');
      return false;
    }
  }

  /**
   * After a number sync of a credential: release its linked numbers that may no longer be linked
   * (`retired_by_sync`: a sync retired them; one still active but unassigned is released as
   * `unassigned`). Returns how many were released. Never throws (as above). Disabling the
   * credential releases nothing (the header).
   */
  async reconcileCredential(credentialId: string, cause: 'retired_by_sync', actor: InboundActor): Promise<number> {
    let released = 0;
    try {
      const rows = await this.deps.numbers.listInboundForCredential(credentialId);
      for (const rec of rows) {
        if (!rec.inbound_linked_at) continue;
        if (mayStayLinked(rec)) continue;
        try {
          // After a sync, a number still active was released for not being assigned any more.
          const why: InboundReleaseCause = rec.status === 'active' ? 'unassigned' : cause;
          if (await this.release(rec, why, actor)) released++;
        } catch (err) {
          log.error({ err, phoneNumberId: rec.phone_number_id, credentialId, cause }, 'Inbound cascade failed for a number; the next sync of its credential retries it');
        }
      }
    } catch (err) {
      log.error({ err, credentialId, cause }, 'Inbound cascade could not list the credential’s numbers');
    }
    if (released > 0) log.info({ credentialId, cause, released }, 'Inbound cascade released numbers');
    return released;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * One number out of inbound: its route detached and its link cleared, committed whatever the
   * carrier says; then, while the number is on the account, put back on its previous app.
   */
  private async release(rec: PhoneNumberInboundLinkRecord, cause: InboundReleaseCause, actor: InboundActor): Promise<boolean> {
    const released = await withTransaction((client) => this.clearInTransaction(rec.phone_number_id, client), { pool: this.deps.pool });
    if (!released) return false; // released meanwhile by someone else
    let restore: InboundCarrierRestore = 'skipped_not_active';
    if (released.cleared.status === 'active') {
      try {
        const carrier = await this.carrier(released.cleared.telephony_credential_id, 'call_control');
        restore = await carrier.setNumberApp(released.cleared.phone_number, released.cleared.inbound_previous_app_id) === 'not_found'
          ? 'number_missing' : 'restored';
      } catch (err) {
        restore = 'failed';
        log.error(
          { err, phoneNumberId: rec.phone_number_id, credentialId: released.cleared.telephony_credential_id, previousAppId: released.cleared.inbound_previous_app_id, cause },
          'Inbound cascade: the number is no longer answered here, but its previous app could not be restored at the carrier; put it back by hand',
        );
      }
    }
    this.auditRelease(actor, cause, rec.credential_tenant_id, released.cleared, released.routeId, restore);
    return true;
  }

  /** Clear a link and detach its route in `client`'s transaction; null when it was not linked. */
  private async clearInTransaction(phoneNumberId: string, client: PoolClient) {
    const cleared = await this.deps.numbers.clearInboundLink(phoneNumberId, { client });
    if (!cleared) return null;
    const route = await this.deps.routes.detachNumberEverywhere(phoneNumberId, { client });
    return { cleared, routeId: route?.routeId ?? null };
  }

  private auditRelease(
    actor: InboundActor,
    cause: InboundReleaseCause,
    tenantId: string | null,
    cleared: { phone_number_id: string; phone_number: string; telephony_credential_id: string; inbound_previous_app_id: string | null },
    routeId: string | null,
    restore: InboundCarrierRestore,
  ): void {
    log.info({ phoneNumberId: cleared.phone_number_id, cause, restore, routeId }, 'Number unlinked from inbound');
    this.audit(actor, 'phone_number.inbound_unlinked', 'phone_number', cleared.phone_number_id, {
      tenant_id: tenantId, telephony_credential_id: cleared.telephony_credential_id, phone_number: cleared.phone_number,
      cause, previous_app_id: cleared.inbound_previous_app_id, detached_route_id: routeId, carrier: restore,
    });
  }

  /**
   * The Application to use: one of ours found by name (`found`, the caller's find-by-name: an
   * earlier Enable or Re-point whose write never committed), given `urls` and `token`, else a new
   * one. Our extra ones by the same name, if a past failure left several, are deleted.
   */
  private async placeApplication(
    carrier: InboundCarrierApi, credentialId: string, urls: PlivoInboundUrls, token: string, found: readonly string[],
  ): Promise<{ appId: string; created: boolean }> {
    const name = inboundApplicationName(credentialId);
    for (const appId of found) {
      if (await carrier.updateInboundApplication(appId, urls, token) === 'not_found') continue;
      for (const extra of found.filter((id) => id !== appId)) await this.deleteQuietly(carrier, extra, credentialId);
      log.warn({ credentialId, appId }, 'Adopted an inbound Application found by name (an earlier attempt that did not complete)');
      return { appId, created: false };
    }
    return { appId: await carrier.createInboundApplication(name, urls, token), created: true };
  }

  /** Move every linked number still on the account onto `appId` (a recreated Application). */
  private async moveLinkedNumbers(carrier: InboundCarrierApi, credentialId: string, appId: string): Promise<{ moved: string[]; missing: string[] }> {
    const moved: string[] = [];
    const missing: string[] = [];
    for (const rec of await this.deps.numbers.listInboundForCredential(credentialId)) {
      if (!rec.inbound_linked_at || rec.status !== 'active') continue;
      if (await carrier.setNumberApp(rec.phone_number, appId) === 'not_found') missing.push(rec.phone_number);
      else moved.push(rec.phone_number);
    }
    return { moved, missing };
  }

  private async deleteQuietly(carrier: InboundCarrierApi, appId: string, credentialId: string): Promise<void> {
    try {
      await carrier.deleteInboundApplication(appId);
    } catch (err) {
      log.error({ err, credentialId, appId }, 'Could not delete an inbound Application nothing stores; the next Enable or Re-point finds it by name');
    }
  }

  /** See {@link repoint}: refuse while a call answered under the previous token is still live. */
  private async refuseWhilePreviousTokenInUse(locked: TelephonyCredentialInboundRecord, client: PoolClient): Promise<void> {
    const expires = locked.previous_token_expires_at;
    if (!expires || expires.getTime() <= Date.now()) return;
    const lastRepointAt = new Date(expires.getTime() - INBOUND_TOKEN_REPOINT_GRACE_SECONDS * 1000);
    if (await this.deps.calls.anyLiveArrivedBefore(locked.credential_id, lastRepointAt, client)) {
      throw new Refusal(fail('inbound_previous_token_in_use',
        'A call answered before the last Re-point is still live on this credential, and its hangup still needs the token that Re-point replaced. Nothing was changed. Try again once it has ended.'));
    }
  }

  /** The credential's inbound state, refused unless it exists and is on the inbound carrier. */
  private async precheck(credentialId: string): Promise<ServiceResult<TelephonyCredentialInboundRecord>> {
    const inbound = await this.deps.repo.findInbound(credentialId);
    if (!inbound) return fail('not_found', 'Credential not found');
    if (inbound.provider !== INBOUND_PROVIDER) return fail('unknown_provider', 'Inbound calls are answered only on Plivo credentials');
    if (inbound.status === 'revoked') return fail('invalid_transition', 'A revoked credential cannot be changed');
    return { ok: true, value: inbound };
  }

  private async lockOrRefuse(credentialId: string, client: PoolClient): Promise<TelephonyCredentialInboundRecord> {
    const locked = await this.deps.repo.lockInbound(credentialId, client);
    if (!locked) throw new Refusal(fail('not_found', 'Credential not found'));
    if (locked.status === 'revoked') throw new Refusal(fail('invalid_transition', 'A revoked credential cannot be changed'));
    return locked;
  }

  private async carrier(credentialId: string, purpose: 'dial' | 'call_control'): Promise<InboundCarrierApi> {
    return this.deps.carrierFor(await this.deps.credentials.resolve(credentialId, purpose));
  }

  private urlsNow(credentialId: string): PlivoInboundUrls | null {
    return plivoInboundUrls(this.deps.settings(), credentialId);
  }

  private storedForm(urls: PlivoInboundUrls) {
    return { answerUrl: urls.answerUrl, hangupUrl: urls.hangupUrl, fallbackAnswerUrl: urls.fallbackAnswerUrl };
  }

  private storedUrlsCurrent(inbound: TelephonyCredentialInboundRecord): boolean {
    const now = this.urlsNow(inbound.credential_id);
    return now !== null && now.answerUrl === inbound.answer_url && now.hangupUrl === inbound.hangup_url
      && now.fallbackAnswerUrl === inbound.fallback_answer_url;
  }

  /** The URLs whose address, method or token differ from the stored ones. */
  private async mismatches(inbound: TelephonyCredentialInboundRecord, app: PlivoApplication): Promise<TelephonyCredentialInboundUrl[]> {
    const out: TelephonyCredentialInboundUrl[] = [];
    const tokened = async (live: string, method: string, stored: string | null): Promise<boolean> => {
      const split = splitInboundToken(live);
      if (!split || split.stored !== stored || method !== 'POST' || !split.token) return false;
      return this.deps.repo.inboundTokenMatches(inbound.credential_id, hashInboundToken(split.token));
    };
    if (!(await tokened(app.answerUrl, app.answerMethod, inbound.answer_url))) out.push('answer_url');
    if (!(await tokened(app.hangupUrl, app.hangupMethod, inbound.hangup_url))) out.push('hangup_url');
    // Our own fallback route is POSTed; an operator-hosted static file is fetched with GET.
    const ownFallback = (inbound.fallback_answer_url ?? '').endsWith(`/${PLIVO_INBOUND_ROUTES.fallback}`);
    if (app.fallbackAnswerUrl !== inbound.fallback_answer_url || app.fallbackMethod !== (ownFallback ? 'POST' : 'GET')) {
      out.push('fallback_answer_url');
    }
    return out;
  }

  private async stateOf(inbound: TelephonyCredentialInboundRecord): Promise<TelephonyCredentialInboundResponse> {
    const rows = await this.deps.numbers.listInboundForCredential(inbound.credential_id);
    return {
      inbound: inboundOf(inbound),
      webhook_base_configured: this.deps.settings().webhookBaseUrl !== '',
      connects_agents: this.deps.settings().mediaWorkers === 0,
      numbers: rows.map((r) => ({
        phone_number_id: r.phone_number_id, phone_number: r.phone_number, status: r.status, assigned: r.assigned, link: linkOf(r),
      })),
    };
  }

  private async numberStateOf(rec: PhoneNumberInboundLinkRecord): Promise<PhoneNumberInboundResponse> {
    // A synced number's calls that reached no account (§8.3): no console screen lists them.
    const unrouted = rec.credential_tenant_id
      ? await this.deps.numbers.findUnroutedMissed(rec.credential_tenant_id, rec.phone_number_id)
      : null;
    return {
      phone_number_id: rec.phone_number_id,
      phone_number: rec.phone_number,
      link: linkOf(rec),
      credential: rec.telephony_credential_id
        ? { id: rec.telephony_credential_id, label: rec.credential_label!, status: rec.credential_status!, inbound_enabled: rec.credential_app_id !== null }
        : null,
      link_blocker: rec.inbound_linked_at ? null : inboundLinkBlocker(rec),
      unrouted_missed: unrouted
        ? { open: unrouted.open_count, latest_at: iso(unrouted.latest_arrived_at), latest_from: unrouted.latest_from_e164 }
        : null,
    };
  }

  /** A link that did not land: why, on a fresh read. */
  private async linkLost(phoneNumberId: string): Promise<Failure> {
    const rec = await this.deps.numbers.findInboundLink(phoneNumberId);
    if (!rec) return fail('phone_number_not_found', 'Phone number not found');
    const blocker = inboundLinkBlocker(rec);
    if (blocker) return fail('phone_number_not_linkable', BLOCKER_MESSAGE[blocker]);
    return fail('version_conflict', 'The number or its credential changed while the carrier was answering; try again');
  }

  private numberMissing(): Failure {
    return fail('carrier_number_missing', 'The carrier account does not have this number any more. Nothing was changed. Sync the credential’s numbers.');
  }

  private numbersLinked(n: number): Failure {
    return fail('inbound_numbers_linked', `${n === 1 ? '1 number is' : `${n} numbers are`} still linked to inbound on this credential. Unlink ${n === 1 ? 'it' : 'them'} first.`);
  }

  private unconfigured(): Failure {
    return fail('inbound_unconfigured', 'This server has no public base for Plivo’s callbacks (PLIVO_WEBHOOK_BASE_URL), so it cannot give the carrier inbound URLs');
  }

  private audit(actor: InboundActor, action: InboundSuperAdminAuditAction, resourceType: string, resourceId: string, details: Record<string, unknown>): void {
    this.deps.audit({ admin_id: actor.adminId, admin_email: actor.adminEmail, action, resource_type: resourceType, resource_id: resourceId, details });
  }
}
