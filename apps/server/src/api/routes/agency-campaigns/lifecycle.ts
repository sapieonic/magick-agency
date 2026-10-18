/*
 * The four lifecycle transitions (start, pause, resume, stop), and the actor-column
 * widths the retry create shares. Part of `agency-campaigns.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getOriginator } from '../../middleware/auth.middleware.js';
import { auditLogger } from '../../../audit/audit-logger.js';
import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import type { AgencyCampaignActor } from '@magick-agency/contracts/agency';
// The two `last_transition_by_*` columns folded into the one wire object. Every
// route here that serves a campaign row goes through it, so the fold has one
// definition — see its header for why it is derived from the record rather than
// an allow-list.
import { formatAgencyCampaignResponse } from '../../responses/agency-campaign.response.js';
import { campaignOf, ownedCampaign } from './guards.js';

const log = createChildLogger({ component: 'agency-campaign-routes' });

/**
 * Column widths for the lifecycle actor, so the route can handle
 * an over-long value rather than letting Postgres raise `22001 value too long`.
 *
 * That error would fail the TRANSITION — a supervisor losing the Stop button
 * because a string was long — so neither value may reach the column unchecked.
 * `readTransitionActor` truncates the NAME and drops the ID; see its docstring for
 * why the two are handled differently. Note this is a different trade from
 * `MAX_AGENT_USER_ID_LENGTH` in `agency-agents.routes.ts`, which 400s: there the
 * over-long value is the whole subject of the request, so there is nothing left to
 * answer.
 */
export const ACTOR_USER_ID_MAX = 100;
export const ACTOR_NAME_MAX = 255;

/** Registered by `agencyCampaignRoutes` on its own instance, after its `authMiddleware`. */
export async function registerCampaignLifecycleRoutes(app: FastifyInstance): Promise<void> {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  //
  // `start`/`resume`/`pause` are supervisor-owned. `stop` sets `stopping` and the
  // PACING LEADER finalizes to `stopped` once in-flight attempts drain — the
  // leader is the only writer of `running → completed` and `stopping → stopped`,
  // so there is exactly one writer and no race with these controls.

  /**
   * Refuse to start a campaign that has nothing to dial.
   *
   * Without this, `POST /:id/start` on an empty campaign succeeds and answers
   * `running`. What follows is not a stuck campaign — it is worse to diagnose than
   * that: the pacing leader picks the campaign up within one supervise pass, finds
   * `countOutstanding = 0` and finalizes it straight to `completed`. So the operator
   * gets a 200 saying Running, and a dashboard that says Completed a couple of
   * seconds later, having placed no calls and having said nothing about why. The
   * roster upload they forgot is never mentioned.
   *
   * Checked at the route rather than in the engine because this is the only moment
   * a human is present to be told. Returns false only when it has already replied.
   */
  async function rosterRejected(reply: FastifyReply, campaign: AgencyCampaignRecord): Promise<boolean> {
    const roster = await agencyCampaignRepository.rosterCounts(campaign.id);
    if (roster.dialable > 0) return false;
    // The two cases are distinguished because the remedy differs — see
    // `rosterCounts`. Cheap: it is the same single query either way.
    reply.code(409).send(roster.total === 0
      ? {
        error: 'No Contacts',
        code: 'campaign_roster_empty',
        message: 'This campaign has no contacts. Upload a contact roster before starting it.',
      }
      : {
        error: 'No Contacts',
        code: 'campaign_roster_exhausted',
        message: `All ${roster.total} contacts on this campaign have been completed, exhausted or suppressed. Upload a fresh roster before starting it again.`,
      });
    return true;
  }

  /**
   * Who pressed the control, from the optional transition body.
   *
   * ── Optional, and `/stop` is the reason ────────────────────────────────────
   *
   * `checkActor` 400s an attempt-scoped write with no actor, because a disposition
   * IS the record of who said what about a customer. A lifecycle transition is not
   * that: the transition is the fact and the actor is attribution ON it. Refusing
   * the transition for want of attribution would put a 400 in front of **the off
   * button** for any caller that does not send one — the same class of
   * mistake as gating `/stop` behind the dialer flag (see `gate`). So an absent,
   * blank or wrong-typed `actor_user_id` yields `null` and the campaign records an
   * unattributed transition.
   *
   * ⚠️ `null` therefore has two causes — genuinely automatic (the guardrail's
   * auto-pause, the leader's finalization) and "the caller did not say" — and the
   * payload cannot separate them. Accepted: see
   * {@link AgencyCampaignTransitionRequest}. The one thing that must not happen is
   * a fabricated actor, so an id-less body is `null` rather than the originator
   * header, which is an origination LABEL (a client hint) and not a user id.
   *
   * ── The NAME is truncated; the ID is DROPPED. The asymmetry is the point ───
   *
   * Both columns can raise `22001 value too long`, which on this path would fail
   * the TRANSITION — a supervisor losing a control because a string was long — so
   * neither over-long value may reach Postgres. What differs is what to do with it:
   *
   *   * `actor_name` is TRUNCATED. It exists to be read, so losing its tail is a
   *     cosmetic loss and the rest of the name still identifies the person.
   *   * `actor_user_id` is DROPPED — the actor becomes `null`. An id is an
   *     IDENTITY: it resolves back to a user, so a truncated one is not a
   *     shortened answer, it is a DIFFERENT (or nonexistent) user. Storing it would
   *     attribute the transition to the wrong human, which is the one failure the
   *     `null`-means-unknown contract exists to prevent. Better to record that we do
   *     not know who than to record somebody else.
   *
   * Unreachable in practice (user ids are UUIDs, well inside 100), so the
   * warn is the only symptom — which is why there is one: a silent drop on a field
   * whose whole job is attribution would look like a caller that simply did not
   * send it.
   */
  function readTransitionActor(body: unknown): AgencyCampaignActor | null {
    const raw = (body ?? {}) as { actor_user_id?: unknown; actor_name?: unknown };
    const userId = typeof raw.actor_user_id === 'string' ? raw.actor_user_id.trim() : '';
    if (!userId) return null;
    if (userId.length > ACTOR_USER_ID_MAX) {
      // Length only — never the value. An actor id is a user identifier, and
      // logs have no business holding one.
      log.warn(
        { length: userId.length, max: ACTOR_USER_ID_MAX },
        'Campaign transition actor id exceeds the column width — recording the transition unattributed',
      );
      return null;
    }
    const name = typeof raw.actor_name === 'string' ? raw.actor_name.trim() : '';
    return { user_id: userId, name: name ? name.slice(0, ACTOR_NAME_MAX) : null };
  }

  async function transition(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    from: readonly string[],
    to: string,
    patch: { last_transition_by?: AgencyCampaignActor | null } = {},
    opts: { requireRoster?: boolean } = {},
  ) {
    // Gate (or not) and ownership are each route's `ownedCampaign` preHandler.
    const campaign = campaignOf(request);

    if (!from.includes(campaign.status)) {
      return reply.code(409).send({
        error: 'Invalid Transition',
        code: 'invalid_campaign_transition',
        message: `A campaign in '${campaign.status}' cannot move to '${to}'.`,
        current_status: campaign.status,
      });
    }

    // After the transition guard, so a campaign in the wrong status still gets the
    // transition error rather than a roster error it cannot act on yet.
    if (opts.requireRoster && await rosterRejected(reply, campaign)) return reply;

    try {
      const updated = await agencyCampaignRepository.transitionStatus(campaign.id, from, to, patch);
      if (!updated) {
        // The guard matched on read but not on write — something moved underneath
        // us (most likely the pacing leader finalizing). Re-read and report.
        const fresh = await agencyCampaignRepository.findById(campaign.id);
        return reply.code(409).send({
          error: 'Invalid Transition',
          code: 'invalid_campaign_transition',
          message: 'The campaign changed state before this could be applied.',
          current_status: fresh?.status ?? null,
        });
      }
      auditLogger.log({
        tenantId: campaign.tenant_id, accountId: campaign.account_id,
        eventType: `agency_campaign.${to}`, eventCategory: 'call', severity: 'info',
        actor: getOriginator(request) ?? 'system:api',
        eventData: { campaign_id: campaign.id, from: campaign.status, to },
      });
      return reply.send(formatAgencyCampaignResponse(updated));
    } catch (err) {
      // 23505 here is uq_agency_campaign_running: ONE running campaign is permitted
      // per account in v1. Surface it as something the console can explain — a raw
      // unique violation would reach a supervisor as an opaque 500.
      if ((err as { code?: string }).code === '23505') {
        log.info({ campaignId: campaign.id }, 'Refused start — another campaign is already running');
        return reply.code(409).send({
          error: 'Already Running',
          code: 'another_campaign_running',
          message: 'Another campaign is already running for this account. Pause or stop it first.',
        });
      }
      throw err;
    }
  }

  // ── `started_at` is not passed from here, deliberately ─────────────────────
  //
  // The lifecycle stamps are derived from the TARGET STATUS inside the single
  // UPDATE that moves a status, which is why there is nothing to
  // pass. A route that passed `{ started_at: new Date() }` on `/resume` would
  // overwrite the original start, so a campaign that began at 09:00 and resumed
  // after lunch would report 14:05; with no parameter, a fifth route cannot
  // reintroduce that by forgetting one.
  //
  // What IS passed is the actor, and only when the caller supplied one.
  // Deliberately spread rather than always present, so a body-less call (a
  // `curl`, say) produces an empty `{}` patch.
  const actorPatch = (req: FastifyRequest): { last_transition_by?: AgencyCampaignActor } => {
    const actor = readTransitionActor(req.body);
    return actor ? { last_transition_by: actor } : {};
  };

  app.post<{ Params: { id: string } }>('/:id/start', { preHandler: ownedCampaign({ gated: true }) }, (req, reply) =>
    transition(req, reply, ['draft', 'paused'], 'running', actorPatch(req),
      { requireRoster: true }));

  app.post<{ Params: { id: string } }>('/:id/pause', { preHandler: ownedCampaign({ gated: false }) }, (req, reply) =>
    // In-flight attempts are never cancelled by a pause — they complete normally.
    // Ungated: see `gate`. Pausing can only reduce dialing.
    transition(req, reply, ['running'], 'paused', actorPatch(req)));

  // Deliberately NOT roster-gated, unlike `/start`. A resume follows a pause the
  // supervisor themselves issued moments ago, and a campaign that drained while
  // paused is finalized by the leader on its first tick — refusing here would put a
  // 409 in front of a control whose only remaining job is to let that happen.
  app.post<{ Params: { id: string } }>('/:id/resume', { preHandler: ownedCampaign({ gated: true }) }, (req, reply) =>
    transition(req, reply, ['paused'], 'running', actorPatch(req)));

  app.post<{ Params: { id: string } }>('/:id/stop', { preHandler: ownedCampaign({ gated: false }) }, (req, reply) =>
    // 200 means "accepted and draining", NOT "stopped". The leader finalizes to
    // `stopped` on its next idle tick; clients must not assert terminal state
    // from this response.
    //
    // **Ungated — this is the off button** (see `gate`).
    //
    // **`draft` is deliberately NOT a source**, and not because stopping would
    // brick it. `stopping` is left only by `maybeFinalize`, and if the drain were
    // measured in roster rows every status would be condemned alike (a campaign
    // stopped at row 100 of 50 000 leaves 49 900 `pending` rows behind, which
    // nothing clears), as would every status with the dialer flag off and no
    // leader to run `maybeFinalize`. `PacingEngine` handles both — a `stopping`
    // campaign is led whatever the flag says, and its drain is measured in live
    // attempts rather than roster rows — so every source status here reaches
    // `stopped` unaided.
    //
    // `draft` stays refused because a draft has nothing to stop: the operator wants
    // delete, or to leave it alone. They get the ordinary
    // `invalid_campaign_transition` 409 naming `draft`, which is readable, whereas a
    // 200 for a campaign that was never dialing is not.
    transition(req, reply, ['running', 'paused'], 'stopping', actorPatch(req)));
}
