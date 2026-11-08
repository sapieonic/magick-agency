/*
 * Report subscriptions (supervisors only, RP4, RP5, RP14): list, create, change, delete, and run
 * now. Part of `proxy-agency-reports.routes.ts` (guards and order in its header).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  REPORT_CADENCES,
  REPORT_FORMATS,
  REPORT_KINDS,
  REPORT_SUBSCRIPTION_MAX_RECIPIENTS,
  type AgencyReportSubscriptionList,
  type ReportCadence,
} from '@magick-agency/contracts/api/agency/reports';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { UUID_RE } from '../../../utils/uuid.js';
import type {
  ReportSubscriptionPatch,
  ReportSubscriptionRecord,
} from '../../../db/repositories/agency.repository.js';
import { nextRunAt, periodFor, type ReportSchedule } from '../../../agency/reports/schedule.js';
import {
  orderedFormats,
  subscriptionNameRef,
  toReportSubscriptionWire,
} from '../../../agency/reports/run-view.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import {
  auditReport,
  isReportTimezone,
  reportsGate,
  resolveReportTarget,
  sendReportRefusal,
  type ReportRouteDeps,
} from './shared.js';
import { createAdHocRun } from './runs.js';

const uuid = z.string().regex(UUID_RE, 'must be a UUID');
const distinct = <T>(items: readonly T[]) => new Set(items).size === items.length;

/** The schedule and delivery fields of a create; a PATCH takes any subset of them. */
const scheduleFields = {
  cadence: z.enum(REPORT_CADENCES),
  send_local_time: z.string().max(16),
  send_weekday: z.number().int().nullable().optional(),
  send_monthday: z.number().int().nullable().optional(),
  timezone: z.string().max(64).optional(),
  formats: z.array(z.enum(REPORT_FORMATS)).min(1).max(REPORT_FORMATS.length).refine(distinct, 'formats must be distinct'),
  // The cap (20) is the family's own refusal (`report_recipient_invalid`), not the schema's.
  recipient_user_ids: z.array(uuid).min(1).max(1000).refine(distinct, 'recipient_user_ids must be distinct'),
  enabled: z.boolean().optional(),
};

const createBody = z.object({ kind: z.enum(REPORT_KINDS), subject_id: uuid, ...scheduleFields }).strict();
const patchBody = z.object({
  cadence: scheduleFields.cadence.optional(),
  send_local_time: scheduleFields.send_local_time.optional(),
  send_weekday: scheduleFields.send_weekday,
  send_monthday: scheduleFields.send_monthday,
  timezone: scheduleFields.timezone,
  formats: scheduleFields.formats.optional(),
  recipient_user_ids: scheduleFields.recipient_user_ids.optional(),
  enabled: scheduleFields.enabled,
}).strict();

type IdParams = { Params: { id: string } };

const SEND_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The day fields agree with the cadence and the time is `HH:MM`; else the refusal reason. */
function scheduleProblem(s: {
  cadence: ReportCadence;
  send_local_time: string;
  send_weekday: number | null;
  send_monthday: number | null;
}): string | null {
  if (!SEND_TIME_RE.test(s.send_local_time)) return 'send_local_time must be HH:MM (24-hour).';
  if (s.cadence === 'weekly') {
    if (s.send_weekday === null || s.send_weekday < 1 || s.send_weekday > 7) return 'A weekly schedule needs send_weekday 1–7.';
  } else if (s.send_weekday !== null) {
    return 'send_weekday is for a weekly schedule only.';
  }
  if (s.cadence === 'monthly') {
    if (s.send_monthday === null || s.send_monthday < 1 || s.send_monthday > 28) return 'A monthly schedule needs send_monthday 1–28.';
  } else if (s.send_monthday !== null) {
    return 'send_monthday is for a monthly schedule only.';
  }
  return null;
}

/** Recipients: at most 20, each a member with `agency.supervise` on the account (RP4). Null when fine. */
async function recipientsProblem(
  deps: ReportRouteDeps,
  request: FastifyRequest,
  recipients: readonly string[],
): Promise<string | null> {
  if (recipients.length > REPORT_SUBSCRIPTION_MAX_RECIPIENTS) {
    return `A scheduled report has at most ${REPORT_SUBSCRIPTION_MAX_RECIPIENTS} recipients.`;
  }
  const allowed = await deps.supervisorsAmong(recipients.map((r) => r.toLowerCase()), request.tenantId!, request.accountId!.toLowerCase());
  return recipients.every((r) => allowed.has(r.toLowerCase()))
    ? null
    : 'Every recipient must be a supervisor on this account.';
}

/** The fields whose change moves `next_run_at`. */
const SCHEDULE_FIELDS: ReadonlySet<string> = new Set([
  'cadence', 'send_local_time', 'send_weekday', 'send_monthday', 'timezone', 'enabled',
]);

/** What a PATCH would store, field by field. */
interface SubscriptionValues {
  cadence: ReportCadence;
  send_local_time: string;
  send_weekday: number | null;
  send_monthday: number | null;
  timezone: string;
  formats: readonly string[];
  recipient_user_ids: readonly string[];
  enabled: boolean;
}

/** The fields whose value differs from the stored row, sorted (recipients compared as a set). */
export function changedSubscriptionFields(existing: ReportSubscriptionRecord, next: SubscriptionValues): string[] {
  const sameList = (a: readonly string[], b: readonly string[], asSet: boolean) => {
    if (a.length !== b.length) return false;
    const x = asSet ? [...a].map((v) => v.toLowerCase()).sort() : [...a];
    const y = asSet ? [...b].map((v) => v.toLowerCase()).sort() : [...b];
    return x.every((v, i) => v === y[i]);
  };
  const changed: string[] = [];
  if (next.cadence !== existing.cadence) changed.push('cadence');
  if (next.send_local_time !== existing.send_local_time) changed.push('send_local_time');
  if (next.send_weekday !== existing.send_weekday) changed.push('send_weekday');
  if (next.send_monthday !== existing.send_monthday) changed.push('send_monthday');
  if (next.timezone !== existing.timezone) changed.push('timezone');
  if (!sameList(next.formats, orderedFormats(existing.formats), false)) changed.push('formats');
  if (!sameList(next.recipient_user_ids, existing.recipient_user_ids, true)) changed.push('recipient_user_ids');
  if (next.enabled !== existing.enabled) changed.push('enabled');
  return changed.sort();
}

/** A subscription of the request's tenant AND account, or null. */
async function findAccountSubscription(
  deps: ReportRouteDeps,
  request: FastifyRequest,
  id: string,
): Promise<ReportSubscriptionRecord | null> {
  if (!UUID_RE.test(id) || !request.accountId) return null;
  const sub = await deps.subscriptions.findById(request.tenantId!, id.toLowerCase());
  return sub && sub.account_id === request.accountId.toLowerCase() ? sub : null;
}

async function sendSubscription(deps: ReportRouteDeps, request: FastifyRequest, reply: FastifyReply, sub: ReportSubscriptionRecord, status: number) {
  const names = await deps.names(request.tenantId!, [subscriptionNameRef(sub)]);
  return reply.code(status).send(toReportSubscriptionWire(sub, names));
}

export async function registerReportSubscriptionRoutes(app: FastifyInstance, deps: ReportRouteDeps): Promise<void> {
  const supervise = { preHandler: requirePermission('agency.supervise') };

  /** GET /report-subscriptions — the account's subscriptions, newest first. */
  app.get('/report-subscriptions', supervise, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    if (!request.accountId) return reply.code(200).send({ subscriptions: [] } satisfies AgencyReportSubscriptionList);
    const subs = await deps.subscriptions.list(request.tenantId!, request.accountId.toLowerCase());
    const names = await deps.names(request.tenantId!, subs.map(subscriptionNameRef));
    const body: AgencyReportSubscriptionList = { subscriptions: subs.map((s) => toReportSubscriptionWire(s, names)) };
    return reply.code(200).send(body);
  });

  /** POST /report-subscriptions — create one (201). */
  app.post('/report-subscriptions', supervise, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    const parsed = parseOr400(createBody, request.body, reply, 'agency');
    if (!parsed) return reply;
    const body = parsed.data;
    const schedule = {
      cadence: body.cadence,
      send_local_time: body.send_local_time,
      send_weekday: body.send_weekday ?? null,
      send_monthday: body.send_monthday ?? null,
    };
    const problem = scheduleProblem(schedule);
    if (problem) return sendReportRefusal(reply, 'report_subscription_invalid', problem);

    const target = await resolveReportTarget(deps, request, reply, { kind: body.kind, subjectId: body.subject_id, supervisorOnly: true });
    if (!target) return reply;
    const timezone = target.campaignTimezone ?? body.timezone;
    if (!isReportTimezone(timezone)) return sendReportRefusal(reply, 'report_timezone_invalid');

    const recipientIssue = await recipientsProblem(deps, request, body.recipient_user_ids);
    if (recipientIssue) return sendReportRefusal(reply, 'report_recipient_invalid', recipientIssue);

    const enabled = body.enabled ?? true;
    const sub = await deps.subscriptions.create({
      tenantId: request.tenantId!,
      accountId: request.accountId!.toLowerCase(),
      kind: target.kind,
      subjectId: target.subjectId,
      cadence: schedule.cadence,
      sendLocalTime: schedule.send_local_time,
      sendWeekday: schedule.send_weekday,
      sendMonthday: schedule.send_monthday,
      timezone,
      formats: orderedFormats(body.formats),
      recipientUserIds: body.recipient_user_ids.map((r) => r.toLowerCase()),
      enabled,
      nextRunAt: enabled ? nextRunAt({ ...schedule, timezone }, deps.now()) : null,
      createdBy: request.user!.id,
    });
    auditReport(deps, request, {
      action: 'agency_report_subscription.created',
      resource_type: 'agency_report_subscription',
      resource_id: sub.id,
      details: {
        kind: sub.kind, subject_id: sub.subject_id, cadence: sub.cadence, timezone: sub.timezone,
        formats: sub.formats, recipients: sub.recipient_user_ids.length, enabled: sub.enabled,
      },
    });
    return sendSubscription(deps, request, reply, sub, 201);
  });

  /** PATCH /report-subscriptions/:id — any subset; the day fields are checked against the resulting cadence. */
  app.patch<IdParams>('/report-subscriptions/:id', supervise, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    const existing = await findAccountSubscription(deps, request, request.params.id);
    if (!existing) return sendReportRefusal(reply, 'report_subscription_not_found');
    const parsed = parseOr400(patchBody, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const patch = parsed.data;

    const cadence = patch.cadence ?? existing.cadence;
    // A day field the PATCH leaves out is kept only while the cadence still uses it.
    const weekday = patch.send_weekday !== undefined
      ? patch.send_weekday
      : (cadence === 'weekly' ? existing.send_weekday : null);
    const monthday = patch.send_monthday !== undefined
      ? patch.send_monthday
      : (cadence === 'monthly' ? existing.send_monthday : null);
    const schedule = {
      cadence,
      send_local_time: patch.send_local_time ?? existing.send_local_time,
      send_weekday: weekday,
      send_monthday: monthday,
    };
    const problem = scheduleProblem(schedule);
    if (problem) return sendReportRefusal(reply, 'report_subscription_invalid', problem);

    // A campaign subscription keeps the campaign's zone (RP3): a `timezone` in the PATCH is ignored.
    let timezone = existing.timezone;
    if (existing.kind !== 'campaign' && patch.timezone !== undefined) {
      if (!isReportTimezone(patch.timezone)) return sendReportRefusal(reply, 'report_timezone_invalid');
      timezone = patch.timezone;
    }
    if (patch.recipient_user_ids) {
      const recipientIssue = await recipientsProblem(deps, request, patch.recipient_user_ids);
      if (recipientIssue) return sendReportRefusal(reply, 'report_recipient_invalid', recipientIssue);
    }

    const enabled = patch.enabled ?? existing.enabled;
    const formats = patch.formats ? orderedFormats(patch.formats) : existing.formats;
    const recipients = patch.recipient_user_ids ? patch.recipient_user_ids.map((r) => r.toLowerCase()) : existing.recipient_user_ids;
    // By VALUE against the stored row, not by presence: the console sends the whole schedule on
    // every edit, so a field merely present must not count as a change.
    const changed = changedSubscriptionFields(existing, {
      cadence,
      send_local_time: schedule.send_local_time,
      send_weekday: weekday,
      send_monthday: monthday,
      timezone,
      formats,
      recipient_user_ids: recipients,
      enabled,
    });
    const scheduleChanged = changed.some((field) => SCHEDULE_FIELDS.has(field));
    const fullSchedule: ReportSchedule = { ...schedule, timezone };
    const update: ReportSubscriptionPatch = {
      cadence,
      sendLocalTime: schedule.send_local_time,
      sendWeekday: weekday,
      sendMonthday: monthday,
      timezone,
      enabled,
      ...(patch.formats ? { formats } : {}),
      ...(patch.recipient_user_ids ? { recipientUserIds: recipients } : {}),
      // Recomputed only when a schedule field or `enabled` actually changed (null while disabled);
      // otherwise kept, so an edit to formats or recipients (or a re-sent, unchanged schedule)
      // never skips a due send.
      ...(scheduleChanged ? { nextRunAt: enabled ? nextRunAt(fullSchedule, deps.now()) : null } : {}),
    };
    const sub = await deps.subscriptions.update(request.tenantId!, existing.id, update);
    if (!sub) return sendReportRefusal(reply, 'report_subscription_not_found');
    auditReport(deps, request, {
      action: 'agency_report_subscription.updated',
      resource_type: 'agency_report_subscription',
      resource_id: sub.id,
      details: { fields: changed, enabled: sub.enabled },
    });
    return sendSubscription(deps, request, reply, sub, 200);
  });

  /** DELETE /report-subscriptions/:id — remove it (204); its runs are kept. */
  app.delete<IdParams>('/report-subscriptions/:id', supervise, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    const existing = await findAccountSubscription(deps, request, request.params.id);
    if (!existing || !(await deps.subscriptions.delete(request.tenantId!, existing.id))) {
      return sendReportRefusal(reply, 'report_subscription_not_found');
    }
    auditReport(deps, request, {
      action: 'agency_report_subscription.deleted',
      resource_type: 'agency_report_subscription',
      resource_id: existing.id,
      details: { kind: existing.kind, subject_id: existing.subject_id, cadence: existing.cadence },
    });
    return reply.code(204).send();
  });

  /**
   * POST /report-subscriptions/:id/run-now — an AD HOC run (requested by the caller, emailed to
   * them, `supervisor` audience) for the subscription's most recent complete period. Not a
   * subscription run, so it never takes the scheduled period's place (202).
   */
  app.post<IdParams>('/report-subscriptions/:id/run-now', supervise, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    const sub = await findAccountSubscription(deps, request, request.params.id);
    if (!sub) return sendReportRefusal(reply, 'report_subscription_not_found');
    const period = periodFor(sub.cadence, deps.now(), sub.timezone);
    return createAdHocRun(deps, request, reply, {
      kind: sub.kind,
      subjectId: sub.subject_id,
      from: period.from,
      to: period.to,
      timezone: sub.timezone,
      formats: sub.formats,
      campaignIds: null,
      emailMe: true,
      via: 'run_now',
      subscriptionId: sub.id,
      supervisorOnly: true,
    });
  });
}
