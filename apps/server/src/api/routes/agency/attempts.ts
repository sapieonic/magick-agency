/*
 * The attempt handlers: disposition, DNC mark and notes. Part of `agency.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { getPool } from '@magick-agency/db';
import { agencyAttemptRepository, agencyContactRepository } from '../../../db/repositories/agency.repository.js';
import {
  checkActor,
  dispositionRefusal,
  resolveDisposition,
  validateDispositionFields,
} from '../../../agency/disposition.js';
import { resolveDispositionDecision } from '../../../agency/disposition-policy.js';
import { markDnc } from '../../../agency/dnc-mark.js';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import type {
  AgencyDisposition,
  AgencyDispositionRequest,
  AgencyDispositionResponse,
  AgencyDncRequest,
  AgencyDncResponse,
  AgencyDncScope,
  AgencyHangupRequest,
  AgencyHangupResponse,
  AgencyNotesRequest,
  AgencyNotesResponse,
} from '@magick-agency/contracts/agency';
import { requireOwnedAttempt, resolveCallbackDialTime, resolveReservedAgentUserId, sendActionError } from './helpers.js';

const log = createChildLogger({ component: 'agency-routes' });

/**
 * Registered by `agencyRoutes` inside its authenticated scope (`sub`, the one carrying
 * `authMiddleware`), so every route here runs behind it.
 */
export async function registerAttemptRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // ── POST /attempts/:id/disposition ─────────────────────────────────────
  // Served at `/proxy/agency/attempts/:id/disposition`, gated there at
  // `agency.attempts.dispose`. The ownership rule lives here, because "is the
  // reserved agent for this attempt" is a dialer-runtime fact the RBAC gate
  // cannot check — and `agency.attempts.dispose` floors at `agent` over a LINEAR
  // hierarchy, so every role above holds it by design and the permission matrix
  // will never produce a 403 for it. There is no second place this can live.
  /**
   * ── POST /attempts/:id/hangup — the agent ends the call ────
   *
   * An HTTP route rather than a station-socket control frame: HTTP is the
   * supported surface for agent actions, the public API layer floors this at
   * `agency.attempts.handle`, the console calls it, and a control frame gives the
   * console no status to act on. The contract's `AgencyStationHangupFrame` is
   * withdrawn and nothing reads it, so this is the only way to hang up.
   */
  sub.post('/attempts/:id/hangup', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const found = await requireOwnedAttempt(request, reply);
    if (!found) return reply;
    const { attempt } = found;

    // Ownership, exactly as on disposition. Without it any tenant member holding
    // `agency.attempts.handle` — which every agent holds — could hang up any
    // other agent's live conversation. This is the check the contract promises:
    // the server verifies the caller is the reserved agent.
    const reservedUserId = await resolveReservedAgentUserId(attempt.reserved_agent_id);
    const actor = checkActor(reservedUserId, (request.body ?? {}) as AgencyHangupRequest);
    if (!actor.ok) {
      return sendActionError(reply, actor.code === 'missing_actor' ? 400 : 403, actor.code);
    }

    // An agent's hangup routinely races the customer's. Erroring on an attempt
    // that just ended would show a failure for the thing that already happened,
    // so a terminal row is an idempotent success.
    const ended = await runtime.dialer.hangupAttempt(attempt.id);
    if (!ended && attempt.state !== 'ended') {
      return sendActionError(reply, 409, 'attempt_not_live');
    }

    // Re-read rather than echo `attempt`: `hangupAttempt` awaits the bridge, so
    // by now the row is usually terminal. Usually, not always — the terminal
    // write rides the bridge's `ended` lifecycle event and `emitLifecycle` does
    // not await its listeners. The station socket's `released` frame is the
    // console's authority for "the call is over"; this response says the hangup
    // was accepted, and `AgencyHangupResponse` says so too.
    const fresh = await agencyAttemptRepository.findById(attempt.id).catch(() => null);
    const body: AgencyHangupResponse = {
      attempt_id: attempt.id,
      campaign_id: attempt.campaign_id,
      state: fresh?.state ?? attempt.state,
      outcome: fresh?.outcome ?? attempt.outcome ?? null,
    };
    return reply.send(body);
  });

  sub.post('/attempts/:id/disposition', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const found = await requireOwnedAttempt(request, reply);
    if (!found) return reply;
    const { attempt, campaign } = found;
    const body = (request.body ?? {}) as AgencyDispositionRequest;

    // ── 1. Who is acting (steps 1–4 on `AgencyActorFields`) ──────────────
    // Ahead of catalog validation deliberately: a caller who has no business
    // with this attempt must not learn the campaign's catalog from the
    // `allowed_codes` echo on a validation error.
    const reservedUserId = await resolveReservedAgentUserId(attempt.reserved_agent_id);
    const actor = checkActor(reservedUserId, body);
    if (!actor.ok) {
      return sendActionError(reply, actor.code === 'missing_actor' ? 400 : 403, actor.code);
    }

    // ── 2. Is there anything here to disposition ─────────────────────────
    const refusal = dispositionRefusal(attempt);
    if (refusal) return sendActionError(reply, 409, refusal);

    // ── 3. The code, then the fields it makes mandatory ──────────────────
    const resolved = resolveDisposition(campaign.disposition_catalog, body.disposition_code);
    if (!resolved.ok) {
      return sendActionError(reply, 400, 'unknown_disposition_code', resolved.allowed);
    }
    const fields = validateDispositionFields(resolved.entry, body, new Date());
    if (!fields.ok) return sendActionError(reply, 400, fields.code);

    // ── 4. The write. Same code ⇒ success; different code ⇒ 409 ──────────
    // One guarded UPDATE does both, so a double-click cannot interleave a read
    // with a write and quietly overwrite the record of a conversation.
    const updated = await agencyAttemptRepository.recordDisposition({
      attemptId: attempt.id,
      dispositionCode: resolved.entry.code,
      notes: fields.notes,
      callbackAt: fields.callbackAt,
      actorUserId: actor.actorUserId,
      onBehalf: actor.onBehalf,
    });
    if (!updated) {
      // The predicate only fails on a DIFFERENT code — a same-code replay is a
      // successful write above. Silently rewriting the record of what was said
      // to a customer is not a retry.
      return sendActionError(reply, 409, 'already_dispositioned');
    }

    // ── 5. The contact: `completed`, or `pending` for a callback or retry ──
    // A callback is honoured rather than merely captured: storing the datetime
    // and doing nothing would have an agent promise a customer a call that never
    // comes. It re-enters the roster as an ordinary contact — whichever agent is
    // available takes it, which is why nothing binds it to this session.
    //
    // No `bump_attempt`: the attempt was already counted when it ended. Bumping
    // here would charge a contact twice for one dial and, at `max_attempts: 3`,
    // exhaust someone after two real conversations.
    //
    // ── The precedence, applied ──────────────────────────────────────────
    // A disposition's `retry`/`terminal`/`suppress` OVERRIDES the outcome
    // policy, so this is the site that has to honour them — a `voicemail`
    // code's `retry` and a `do_not_call` code's `suppress` are not just
    // captured in the catalog, they decide the contact's next state.
    //
    // `attemptsUsed` is the STORED count, with no bump: the attempt was already
    // charged when it ended. Bumping here would charge a contact twice for one
    // dial and, at `max_attempts: 3`, exhaust someone after two real
    // conversations. That is the opposite convention from the dial path, which
    // passes the post-bump count — hence a read rather than a reuse.
    //
    // Read ONLY when the decision can turn on it — a disposition `retry` with no
    // callback. Every other arm (`suppress`, `terminal`, a callback, a plain
    // label) ignores `attemptsUsed`, so the common path costs no query, and the
    // `0` those arms are handed cannot silently become load-bearing later without
    // this condition being revisited.
    //
    // `.catch(() => null)` is not defensive noise: a DB blip must not fail an
    // agent's disposition, because the conversation is over and this write is the
    // only record of it — the same posture `resolveCallbackDialTime` already
    // takes on its own read of this row. The fallback is 0, which is permissive:
    // it schedules a retry rather than declaring a budget spent on no evidence.
    const needsAttemptCount = !!resolved.entry.retry && !fields.callbackAt;
    const contactRow = needsAttemptCount
      ? await agencyContactRepository.findById(attempt.contact_id).catch(() => null)
      : null;
    const decision = resolveDispositionDecision(resolved.entry, {
      now: new Date(),
      attemptsUsed: contactRow?.attempt_count ?? 0,
      callbackAt: fields.callbackAt,
    });
    const contactState = decision.contactState;
    // ── The callback is scheduled for when we can actually dial ──────────
    //
    // A `callback_at` outside the contact's calling window is honoured by
    // DEFERRING it to the next window open, not by refusing it. Refusing would
    // block a legitimate "call me Saturday" on a Mon–Fri campaign, and the
    // operator's window is the compliance boundary; the pre-dial calling-hours
    // gate would refuse that dial anyway, so writing the raw time would only
    // make the contact wake up, get deferred, and wake again.
    //
    // The response then reports THIS instant rather than the raw request, because
    // the agent says the time out loud to a customer. `callback_at` on the attempt
    // row keeps the raw request — what was promised and what we scheduled are two
    // different facts and the audit needs both.
    const scheduledAt = fields.callbackAt
      ? await resolveCallbackDialTime(campaign, attempt.contact_id, fields.callbackAt)
      : null;
    // `scheduledAt` wins over the decision's own instant when there is one: for a
    // callback they are the same moment, one deferred into the calling window, and
    // the deferred one is what we will actually dial. A DISPOSITION RETRY's delay
    // (`voicemail`, 240 minutes) is deliberately written raw and NOT deferred —
    // matching the dial path's outcome-retry write, and leaving the calling-hours
    // question to the pre-dial gate. Only the callback is deferred, because only
    // the callback was said out loud to a customer.
    //
    // ⚠️ Gated on the DECISION having scheduled something, not merely on a
    // `callback_at` having been submitted. `scheduledAt` is derived from the
    // callback arm, and that arm can LOSE: the precedence puts `suppress` and
    // `terminal` above it, and `callback_at` is only ever *required* by
    // `requires_datetime` — never *refused* without it — so a sticky console field
    // or a supervisor correcting a code without clearing the time submits
    // `do_not_call` or `not_interested` WITH a datetime. Ungated, the losing arm's
    // instant would override the winning decision's `null`: the contact would be
    // written `suppressed`/`completed` while carrying a future `next_attempt_at`,
    // and the response would tell the console a DNC'd customer is to be dialed on
    // Wednesday.
    // Inert for dialing — `claimDialable` gates on `state = 'pending'` — but it is
    // the precedence contradicting itself in the field a console and a compliance
    // export both read.
    const nextAttemptAt = decision.nextAttemptAt ? (scheduledAt ?? decision.nextAttemptAt) : null;
    await agencyContactRepository.markState(attempt.contact_id, contactState, {
      last_outcome: attempt.outcome,
      last_disposition: resolved.entry.code,
      ...(nextAttemptAt ? { next_attempt_at: nextAttemptAt } : {}),
      ...(decision.suppressedReason ? { suppressed_reason: decision.suppressedReason } : {}),
    });
    // ⚠️ `markState` writes `next_attempt_at = COALESCE($6, next_attempt_at)`, so a
    // contact moved to `suppressed`/`completed`/`exhausted` with no new instant
    // KEEPS its previous one. Harmless today — `claimDialable` gates on
    // `state = 'pending'`, so nothing reads it — but it means a test asserting "no
    // retry was scheduled" here would be observing a stale value rather than an
    // absence. Assert the STATE. Nothing clears the column yet.
    log.info(
      {
        contactId: attempt.contact_id, attemptId: attempt.id,
        dispositionCode: resolved.entry.code, contactState,
        dispositionReason: decision.reason, nextAttemptAt,
      },
      'Contact released by the disposition policy',
    );

    // ── 6. Release the wrap-up, if this attempt is the one holding it ─────
    // `noteDisposition` is a no-op unless the session is in wrap-up FOR THIS
    // attempt, which is what lets a supervisor write up an old call without
    // pulling a live agent off a new one.
    if (attempt.reserved_agent_id) {
      await runtime.wrapup.noteDisposition(attempt.reserved_agent_id, attempt.id);
    }

    const live = attempt.reserved_agent_id ? await runtime.agents.get(attempt.reserved_agent_id) : null;
    const response: AgencyDispositionResponse = {
      attempt_id: attempt.id,
      contact_id: attempt.contact_id,
      campaign_id: attempt.campaign_id,
      disposition_code: resolved.entry.code,
      contact_state: contactState,
      // When we will dial, not what was asked for. The echo is a separate field
      // precisely so a console cannot mistake one for the other.
      //
      // Also carries a DISPOSITION RETRY's instant (`voicemail`'s 240 minutes),
      // not just a callback's: the console shows the agent when this contact comes
      // back, and reporting `null` for a retry that is genuinely scheduled would be
      // a worse lie than reporting a raw time. `callback_requested_at` stays null on
      // that arm, which is how a console tells the two apart.
      next_attempt_at: nextAttemptAt ? nextAttemptAt.toISOString() : null,
      callback_requested_at: fields.callbackAt ? fields.callbackAt.toISOString() : null,
      // ADVISORY, and it races the socket by design — releasing the wrap-up
      // returns the agent to the pool and the tick runs every 250ms, so a new
      // `reserved` frame can reach the console before this response does.
      agent_state: live?.state ?? 'offline',
    };
    return reply.send(response);
  });

  // ── POST /attempts/:id/dnc ─────────────────────────────────────────────
  //
  // The agent's "do not call" button. Registered inside THIS scope, which is the
  // one carrying `authMiddleware` — auth is registered per route-plugin rather
  // than globally, so a route landed outside it ships unauthenticated.
  //
  // Two writes, committed together in one transaction (decision B8):
  //
  //   1. **Every roster row in THIS campaign carrying this number** is
  //      suppressed. `claimDialable` claims only `state = 'pending'`, so those
  //      contacts leave the roster at once — which is what makes "marked DNC at
  //      T, not dialed by the retry at T+5" true.
  //   2. **The compliance record**: a `dnc_entries` row written by `markDnc`
  //      (`agency/dnc-mark.ts`), whose reach is the request's `scope` — this
  //      campaign by default, the whole tenant when the console escalates. The
  //      dial-time check (`DncRegistry.check`) reads that table, widened by
  //      scope. `dnc_recorded` reports whether the row landed.
  //
  // ⚠️ The two scopes differ ONLY in the `dnc_entries` row. Write (1) is
  // unconditional: the contact in front of the agent leaves the roster the same
  // way either way. Making it conditional on scope would leave a `tenant` mark
  // relying on the dial-time check alone to keep this campaign's rows from
  // being claimed.
  //
  // ⚠️ Why (1) is by PHONE and not by contact id. The schema has no
  // phone-unique index on purpose, so a campaign holding one number twice is
  // normal, supported data. A by-contact-id write would leave the duplicate
  // `pending`, so the number the customer just asked us to stop calling would
  // still be claimed from this campaign and rest on the dial-time check alone.
  // Do not narrow this to the contact id.
  sub.post('/attempts/:id/dnc', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const found = await requireOwnedAttempt(request, reply);
    if (!found) return reply;
    const { attempt, campaign } = found;
    const body = (request.body ?? {}) as AgencyDncRequest;

    // ── 1. Validate everything BEFORE writing anything ───────────────────
    // Same ordering discipline as the disposition route: a 400 must not leave a
    // half-applied request behind. The optional `disposition_code` is validated
    // here rather than ignored — silently dropping a field the public API layer
    // accepts and forwards is the exact failure class to avoid.
    //
    // ── The SCOPE, which is the field with the customer-facing promise on it ─
    //
    // ABSENT ⇒ `campaign`, the NARROWER of the two. A caller that knows nothing
    // about scope — an older console, a script — thereby fails safe instead of
    // suppressing a number across campaigns the customer never mentioned.
    //
    // An unrecognised value is REFUSED, not defaulted. The console's escalation
    // is labelled to the agent as "any campaign, forever" and an agent may read
    // that out to the customer; quietly writing the campaign-scoped row for a
    // misspelled `tenant` would make a compliance statement to a customer false,
    // behind a 200 and a green dashboard. Loud is the only safe direction here.
    //
    // ⚠️ The public API layer's `dncSchema` must keep declaring `scope`: if Zod
    // strips it there, the escalation silently becomes a campaign mark here.
    if (body.scope !== undefined && body.scope !== 'campaign' && body.scope !== 'tenant') {
      return sendActionError(reply, 400, 'invalid_dnc_scope', ['campaign', 'tenant']);
    }
    const scope: AgencyDncScope = body.scope ?? 'campaign';

    let disposition: { entry: AgencyDisposition; actorUserId: string; onBehalf: boolean } | null = null;
    if (body.disposition_code !== undefined) {
      const resolved = resolveDisposition(campaign.disposition_catalog, body.disposition_code);
      if (!resolved.ok) {
        return sendActionError(reply, 400, 'unknown_disposition_code', resolved.allowed);
      }
      // A disposition is the record of who said what about a customer, so it is
      // never written unattributed. The public API layer sends the authenticated
      // actor (`resolveAgencyActor`); a request without one is a loud 400 rather
      // than a silent drop, and deliberately NOT defaulted to the attempt's
      // reserved agent: a supervisor marking someone else's attempt would be
      // recorded as that agent.
      const reservedUserId = await resolveReservedAgentUserId(attempt.reserved_agent_id);
      const actor = checkActor(reservedUserId, body);
      if (!actor.ok) {
        return sendActionError(reply, actor.code === 'missing_actor' ? 400 : 403, actor.code);
      }
      disposition = { entry: resolved.entry, actorUserId: actor.actorUserId, onBehalf: actor.onBehalf };
    }

    const contact = await agencyContactRepository.findById(attempt.contact_id);
    if (!contact) {
      return reply.code(404).send({ error: 'Not Found', message: 'Contact not found' });
    }

    // Decision B8: steps 2–4 run in ONE transaction on one client — the roster
    // suppression, the optional disposition and the `dnc_entries` row commit or roll
    // back together. The mark is part of the agent's bookkeeping, so a failed insert
    // rolls the suppression back and the route answers a 5xx with nothing claimed
    // (`markDnc` rethrows when given `deps.client`). A number that is not usable E.164
    // is not a failure: `markDnc` writes nothing and says so (`dnc_recorded: false`),
    // and the marked contact still leaves the roster. The wrap-up release waits for
    // the COMMIT.
    let suppressedContactIds: string[] = [];
    let forwarded!: Awaited<ReturnType<typeof markDnc>>;
    let noteDispositionFor: string | null = null;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // ── 2. Suppress the roster rows ──────────────────────────────────────
      // All three steps share this transaction, so a throw at any of them rolls
      // the others back: the response never confirms a suppression that did not
      // happen, and a DNC confirmation an agent reads out to a customer must not
      // be a guess. A throw is a 5xx with nothing claimed.
      //
      // ⚠️ Unconditional in BOTH scopes, and not an oversight. A `tenant`
      // escalation's `dnc_entries` row also blocks this number at dial time
      // everywhere, but taking the rows off the roster here is what keeps them
      // from being claimed at all. The contact on the line leaves the roster the
      // same way whatever scope was asked for.
      //
      // ⚠️ `suppressByPhone` preserves `markState`'s `next_attempt_at` behaviour
      // exactly: a contact that already had a retry instant KEEPS it (the column
      // is left out of the UPDATE, which is what `COALESCE(NULL, next_attempt_at)`
      // did). Inert — `claimDialable` gates on `pending` — but it means the STATE
      // is the thing that took these contacts off the roster, and the thing any
      // test here must assert. Clearing the column does not belong in a
      // compliance route.
      //
      // `attempt.contact_id` is passed as the row that is suppressed WHATEVER
      // happens: a roster number that is not usable E.164 matches nothing by
      // phone, and the contact in front of the agent must still leave the roster —
      // the guarantee a naive by-phone write silently drops. The disposition rides that row alone; stamping it
      // on a housemate's row because they share a landline would invent a record
      // of a conversation that never happened.
      suppressedContactIds = await agencyContactRepository.suppressByPhone(
        campaign.id,
        contact.phone_e164,
        'dnc',
        {
          alwaysContactId: attempt.contact_id,
          ...(disposition ? { lastDisposition: disposition.entry.code } : {}),
        },
        { client },
      );

      // ── 3. The optional disposition, if one was asked for ────────────────
      // A null return means the attempt already carries a DIFFERENT code. The
      // disposition route calls that a 409, and rightly — but here the disposition
      // is the secondary half, and refusing the whole request over it would leave
      // a customer who asked not to be called again sitting on the roster. Logged,
      // not raised.
      if (disposition) {
        const updated = await agencyAttemptRepository.recordDisposition({
          attemptId: attempt.id,
          dispositionCode: disposition.entry.code,
          notes: null,
          callbackAt: null,
          actorUserId: disposition.actorUserId,
          onBehalf: disposition.onBehalf,
        }, { client });
        if (!updated) {
          log.warn(
            { attemptId: attempt.id, dispositionCode: disposition.entry.code },
            'Attempt already carries a different disposition — the DNC suppression still stands',
          );
        } else if (attempt.reserved_agent_id) {
          // No-op unless the session is in wrap-up FOR THIS attempt, exactly as on
          // the disposition route. Run after COMMIT (below), so a rolled-back
          // disposition never releases wrap-up.
          noteDispositionFor = attempt.reserved_agent_id;
        }
      }

      // ── 4. The durable compliance record, `dnc_entries` ──────────────────
      forwarded = await markDnc({
        tenantId: attempt.tenant_id,
        // ── The SCOPE of the `dnc_entries` row, and the ONE place it is set ──
        //
        // Present ⇒ a CAMPAIGN-scoped row: the dial-time check stops this
        // campaign calling the number, and other campaigns are untouched.
        //
        // Absent ⇒ a TENANT-WIDE row, which blocks the number at dial time in
        // every campaign the tenant runs, now and in future. That is not a
        // fallback or a leftover — it is the escalation the console offers under a
        // permission and describes to the agent as "any campaign, forever", and
        // this omission is the only thing in the dialer runtime that produces it.
        // Deleting the conditional here (either arm of it) makes that label a
        // false statement to a customer on an irreversible compliance action,
        // with a 200 and `dnc_recorded: true` behind it.
        //
        // The campaign id is the server's own — `requireOwnedAttempt` resolved it
        // from the attempt. The client asserts only which of the two scopes it
        // wants, never an id (`AgencyDncRequest.scope`).
        ...(scope === 'campaign' ? { campaignId: campaign.id } : {}),
        phoneE164: contact.phone_e164,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        // Who suppressed this number, for the compliance record. Two sources, in
        // order of how much they have been checked:
        //
        //   - the disposition arm's actor, which `checkActor` has already
        //     validated against the attempt's reservation;
        //   - otherwise the authenticated caller the public API layer sends,
        //     unchecked, because a plain mark-DNC deliberately has no ownership
        //     rule — a supervisor suppressing a number mid-shift is a real action.
        //
        // Still **never derived locally**. `resolveReservedAgentUserId` is right
        // here and is not consulted: filling the field from the attempt's reserved
        // agent would record whoever happened to hold the call rather than whoever
        // asked, and on a compliance record a confidently-wrong actor is worse
        // than a NULL one.
        ...(disposition
          ? { addedBy: disposition.actorUserId }
          : (typeof body.agent_user_id === 'string' && body.agent_user_id
            ? { addedBy: body.agent_user_id }
            : {})),
      }, { client });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
      throw err;
    } finally {
      client.release();
    }
    if (noteDispositionFor) {
      await runtime.wrapup.noteDisposition(noteDispositionFor, attempt.id);
    }

    log.info(
      {
        contactId: attempt.contact_id, attemptId: attempt.id,
        campaignId: campaign.id,
        // What the customer was actually promised. Logged because it is the one
        // property of this press that is invisible in every other signal: a
        // `tenant` escalation and a `campaign` mark produce the same 200, the
        // same `contact_state`, and the same suppressed-row count.
        dncScope: scope,
        // How many roster rows this press actually took off the campaign.
        // Logged rather than merely counted: >1 means this campaign held the
        // number more than once, the case the by-phone suppression exists for.
        suppressedContacts: suppressedContactIds.length,
        dncRecorded: forwarded.recorded, alreadyPresent: forwarded.alreadyPresent,
        dispositionCode: disposition?.entry.code ?? null,
      },
      'Contact marked do-not-call by an agent',
    );

    const response: AgencyDncResponse = {
      attempt_id: attempt.id,
      contact_id: attempt.contact_id,
      campaign_id: attempt.campaign_id,
      // What was actually suppressed, in the normalized form the dial-time DNC
      // check compares against — not what the roster row happened to hold.
      phone_e164: forwarded.phoneE164 ?? contact.phone_e164,
      // Always `suppressed` on success, by contract, and it outranks the
      // disposition precedence: a `sale` code would resolve to `completed`, but
      // the customer asked not to be called again and that wins.
      contact_state: 'suppressed',
      dnc_recorded: forwarded.recorded,
    };
    return reply.send(response);
  });

  // ── POST /attempts/:id/notes ───────────────────────────────────────────
  // Separate from the disposition because the two happen at different times:
  // agents type while the customer is talking. Safe to call repeatedly, live
  // and through wrap-up, so an autosave need not know which phase it is in. It
  // does NOT end wrap-up and does NOT satisfy `requires_disposition`.
  sub.post('/attempts/:id/notes', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const found = await requireOwnedAttempt(request, reply);
    if (!found) return reply;
    const { attempt } = found;
    const body = (request.body ?? {}) as AgencyNotesRequest;

    const reservedUserId = await resolveReservedAgentUserId(attempt.reserved_agent_id);
    const actor = checkActor(reservedUserId, body);
    if (!actor.ok) {
      return sendActionError(reply, actor.code === 'missing_actor' ? 400 : 403, actor.code);
    }
    if (typeof body.notes !== 'string') {
      return sendActionError(reply, 400, 'note_required');
    }

    // Deliberately NOT gated on `dispositionRefusal`. Notes are accepted while
    // the attempt is live — before `bridged_at` exists on a call the agent is
    // already typing into — and on an auto-closed one, where what the agent
    // wrote is the only record of the conversation left.
    const updated = await agencyAttemptRepository.saveNotes(attempt.id, body.notes);
    if (!updated) return reply.code(404).send({ error: 'Not Found', message: 'Attempt not found' });

    const response: AgencyNotesResponse = {
      attempt_id: updated.id,
      notes: updated.notes ?? '',
      updated_at: updated.updated_at.toISOString(),
    };
    return reply.send(response);
  });
}
