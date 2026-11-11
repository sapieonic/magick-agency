/*
 * Working the Missed inbound list beyond reading and marking it (docs/inbound.md §7, §8.4, §11),
 * on the internal handler instance under `/api/v1/agency` (decision B16), part of
 * `agency.routes.ts`:
 *
 *  - `GET  /inbound/missed/count`: the nav badge, the open rows of the caller's scope (the list's
 *    `assignee` rule, IQ57: an agent's own, or the unassigned ones; with `agency.supervise` the
 *    account's, or `me`) and whether the scope has any row at all; `since` narrows to rows that
 *    arrived at or after it (IQ50);
 *  - `POST /inbound/missed/:id/claim`: an agent takes an unassigned open row (IQ49);
 *  - `POST /inbound/missed/:id/assign`: a supervisor gives an open row to a member of the account,
 *    or to the account;
 *  - `GET  /inbound/summary`: the account's inbound calls over a date range, for supervisors.
 *
 * The public routes (`../proxy-agency-inbound/missed-work.ts`) own RBAC, the actor, names, the
 * departed-member flag and the audit row; these handlers own validation, the account scope and the
 * reads and writes. The actor arrives on the query (`./inbound.ts` `queryActor`), never the body.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AGENCY_INBOUND_SUMMARY_MAX_DAYS,
  type AgencyInboundMissedCountResponse,
  type AgencyInboundSummary,
} from '@magick-agency/contracts/api/agency/inbound';
import {
  agencyInboundAnswerRepository,
  agencyInboundCallRepository,
  agencyInboundReportRepository,
} from '../../../db/repositories/agency.repository.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { replyValidationFailed } from '../helpers/parse-or-400.js';
import { inboundMissedCountQuerySchema, missedAssigneeScope } from '../helpers/inbound-missed-query.js';
import {
  inboundMissedToWire,
  sendInboundRefusal,
  type InboundCallClaimedAudit,
  type InboundCallReassignedAudit,
  type InboundCoreAnswer,
} from './inbound-answer.js';
import { queryActor } from './inbound.js';

/** `POST /inbound/missed/:id/assign`'s body: a member's id, or null for the account. */
export const inboundMissedAssignSchema = z.object({
  assignee_user_id: z.string().uuid().nullable(),
}).strict();

const DAY_MS = 86_400_000;

/** `GET /inbound/summary`'s query: two instants, `from < to`, at most the contract's span apart. */
export const inboundSummaryQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
}).superRefine((q, ctx) => {
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (!(from < to)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to must be after from.' });
  else if (to - from > AGENCY_INBOUND_SUMMARY_MAX_DAYS * DAY_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `The range can be at most ${AGENCY_INBOUND_SUMMARY_MAX_DAYS} days.` });
  }
});

/** A percentage to one decimal, or null with nothing to divide by. */
export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/** Seconds to one decimal, or null. */
function seconds(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export async function registerInboundMissedWorkRoutes(sub: FastifyInstance): Promise<void> {
  // ── GET /inbound/missed/count — the nav badge ──────────────────────────────
  sub.get('/inbound/missed/count', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    const parsed = inboundMissedCountQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return replyValidationFailed(reply, parsed.error.flatten());
    // The list's rule (§8.4, IQ57): without `agency.supervise` the caller's own rows, or the
    // unassigned ones; with it, what was asked (absent: the account's).
    const assignee = missedAssigneeScope(actor, parsed.data.assignee);
    const counted = await agencyInboundCallRepository.countMissed({
      tenantId: actor.tenantId,
      accountId: actor.accountId,
      ...(assignee ? { assignee } : {}),
      ...(parsed.data.since ? { since: new Date(parsed.data.since) } : {}),
    });
    const body: AgencyInboundMissedCountResponse = { open: counted.open, open_capped: counted.capped, has_rows: counted.hasRows };
    return reply.send(body);
  });

  // ── POST /inbound/missed/:id/claim — take an unassigned row (IQ49) ─────────
  // Any caller with the list (the public route's `agency.inbound.read`): the row must be the
  // account's, open, and assigned to nobody; it becomes the caller's. Already theirs: as it is.
  sub.post<{ Params: { id: string } }>('/inbound/missed/:id/claim', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    if (!UUID_RE.test(request.params.id)) return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    const result = await agencyInboundCallRepository.claimMissed({
      tenantId: actor.tenantId, accountId: actor.accountId, id: request.params.id, userId: actor.userId,
    });
    if (!result) return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    if (result.outcome === 'handled') return sendInboundRefusal(reply, { code: 'inbound_missed_call_handled' });
    if (result.outcome === 'taken') return sendInboundRefusal(reply, { code: 'inbound_missed_call_claimed' });
    const audit: InboundCallClaimedAudit = { call_id: result.call.id, changed: result.changed };
    const envelope: InboundCoreAnswer<{ call: ReturnType<typeof inboundMissedToWire> }, InboundCallClaimedAudit> = {
      answer: { call: inboundMissedToWire(result.call) },
      audit,
    };
    return reply.send(envelope);
  });

  // ── POST /inbound/missed/:id/assign — a supervisor's reassign ──────────────
  sub.post<{ Params: { id: string } }>('/inbound/missed/:id/assign', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    // The public route requires `agency.supervise`; an actor without it reads no other row.
    if (!actor.supervise || !UUID_RE.test(request.params.id)) return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    const parsed = inboundMissedAssignSchema.safeParse(request.body ?? {});
    if (!parsed.success) return replyValidationFailed(reply, parsed.error.flatten());
    const assignee = parsed.data.assignee_user_id?.toLowerCase() ?? null;
    if (assignee !== null) {
      // Someone who can open the row: an active user with an active membership at tenant level or in this account.
      const members = await agencyInboundAnswerRepository.filterAccountMembers(actor.tenantId, actor.accountId, [assignee]);
      if (!members.has(assignee)) return sendInboundRefusal(reply, { code: 'inbound_assignee_invalid' });
    }
    const result = await agencyInboundCallRepository.reassignMissed({
      tenantId: actor.tenantId, accountId: actor.accountId, id: request.params.id, assigneeUserId: assignee,
    });
    if (!result) return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    if (result.outcome === 'handled') return sendInboundRefusal(reply, { code: 'inbound_missed_call_handled' });
    const audit: InboundCallReassignedAudit = {
      call_id: result.call.id, changed: result.changed, from: result.previousAssigneeUserId, to: assignee,
    };
    const envelope: InboundCoreAnswer<{ call: ReturnType<typeof inboundMissedToWire> }, InboundCallReassignedAudit> = {
      answer: { call: inboundMissedToWire(result.call) },
      audit,
    };
    return reply.send(envelope);
  });

  // ── GET /inbound/summary — the account's inbound calls over a range ────────
  sub.get('/inbound/summary', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    if (!actor.supervise) return reply.code(403).send({ error: 'Forbidden', message: 'The inbound summary is for supervisors.' });
    const parsed = inboundSummaryQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return replyValidationFailed(reply, parsed.error.flatten());
    const range = {
      tenantId: actor.tenantId, accountId: actor.accountId, from: new Date(parsed.data.from), to: new Date(parsed.data.to),
    };
    const [t, agents] = await Promise.all([
      agencyInboundReportRepository.summaryTotals(range),
      agencyInboundReportRepository.summaryAgents(range),
    ]);
    const body: AgencyInboundSummary = {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      calls: t.calls,
      open_hours_calls: t.open_hours,
      after_hours: t.after_hours,
      switched_off: t.switched_off,
      no_route: t.no_route,
      answered: t.answered,
      answer_rate_pct: pct(t.answered, t.open_hours),
      abandoned: t.abandoned,
      abandon_rate_pct: pct(t.abandoned, t.open_hours),
      avg_answer_seconds: seconds(t.avg_answer_seconds),
      p90_answer_seconds: seconds(t.p90_answer_seconds),
      voicemails: t.voicemails,
      overflow: t.nobody_free + t.lines_busy,
      nobody_free: t.nobody_free,
      lines_busy: t.lines_busy,
      // An inactive credential is a line not in service: our side could not serve the call.
      not_served: t.failed + t.refused + t.credential_inactive,
      sticky_calls: t.sticky_calls,
      sticky_answered: t.sticky_answered,
      sticky_hit_rate_pct: pct(t.sticky_answered, t.sticky_calls),
      missed: t.missed,
      missed_handled: t.missed_handled,
      agents: agents.map((a) => ({ user_id: a.user_id, name: null, answered: a.answered, talk_seconds: a.talk_seconds })),
    };
    return reply.send(body);
  });
}
