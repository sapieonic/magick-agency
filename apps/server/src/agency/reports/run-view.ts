/**
 * Report rows as the console reads them (`AgencyReportRun`, `AgencyReportSubscription`,
 * `packages/contracts/src/api/agency/reports.ts`), with display names resolved.
 *
 * Names are an improvement on ids, never a precondition (the agency enrichment rule): every
 * lookup here degrades to "no names" on a failure, and the wire then carries `name: null`. A
 * run's subject name comes from the subject's own table by kind (the agent's user, the
 * campaign, the account), resolved in one read per table for a whole page.
 */
import { createChildLogger } from '@magick-agency/observability';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import {
  REPORT_FORMATS,
  type AgencyReportRun,
  type AgencyReportSubscription,
  type ReportFormat,
  type ReportKind,
} from '@magick-agency/contracts/api/agency/reports';
import { agentNamesOrNone } from '../agency-agent-identity.js';
import { reportFailureMessage } from './failure-messages.js';
import { agencyCampaignRepository } from '../../db/repositories/agency.repository.js';
import type { ReportRunRecord } from '../../db/repositories/agency.repository.js';
import type { ReportSubscriptionRecord } from '../../db/repositories/agency.repository.js';

const log = createChildLogger({ component: 'agency-reports' });

/** Display names for one page of runs or subscriptions. */
export interface ReportNames {
  users: Map<string, string | null>;
  campaigns: Map<string, string>;
  accounts: Map<string, string>;
}

/** What a name lookup needs from a run or a subscription. */
export interface ReportNameRef {
  kind: ReportKind;
  subject_id: string;
  account_id: string | null;
  /** Users named beside the subject: the requester, the creator, the recipients. */
  userIds?: ReadonlyArray<string | null>;
}

async function orEmpty<T>(what: string, read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, `${what}: name lookup failed; names served as null`);
    return empty;
  }
}

/** Resolve every name a set of runs or subscriptions of one tenant shows. */
export async function resolveReportNames(tenantId: string, refs: readonly ReportNameRef[]): Promise<ReportNames> {
  const userIds = new Set<string>();
  const campaignsByAccount = new Map<string, Set<string>>();
  const accountIds = new Set<string>();
  for (const ref of refs) {
    for (const id of ref.userIds ?? []) if (id) userIds.add(id);
    if (ref.kind === 'agent') userIds.add(ref.subject_id);
    if (ref.kind === 'account') accountIds.add(ref.subject_id);
    if (ref.kind === 'campaign' && ref.account_id) {
      const set = campaignsByAccount.get(ref.account_id) ?? new Set<string>();
      set.add(ref.subject_id);
      campaignsByAccount.set(ref.account_id, set);
    }
  }
  const [users, campaigns, accounts] = await Promise.all([
    agentNamesOrNone(userIds, tenantId, 'reports'),
    orEmpty('reports campaigns', async () => {
      const out = new Map<string, string>();
      for (const [accountId, ids] of campaignsByAccount) {
        for (const row of await agencyCampaignRepository.findOwnedSummaries([...ids], tenantId, accountId)) {
          out.set(row.id, row.name);
        }
      }
      return out;
    }, new Map<string, string>()),
    orEmpty('reports accounts', async () => {
      if (accountIds.size === 0) return new Map<string, string>();
      const rows = await accountRepository.findByIds([...accountIds], tenantId);
      return new Map(rows.map((row) => [row.id, row.name]));
    }, new Map<string, string>()),
  ]);
  return { users, campaigns, accounts };
}

/** The subject's display name by kind, or null when it no longer resolves. */
export function reportSubjectName(names: ReportNames, kind: ReportKind, subjectId: string): string | null {
  switch (kind) {
    case 'agent':
      return names.users.get(subjectId) ?? null;
    case 'campaign':
      return names.campaigns.get(subjectId) ?? null;
    case 'account':
      return names.accounts.get(subjectId) ?? null;
  }
}

/** Formats in {@link REPORT_FORMATS} order, de-duplicated. */
export function orderedFormats(formats: readonly ReportFormat[]): ReportFormat[] {
  return REPORT_FORMATS.filter((f) => formats.includes(f));
}

const iso = (d: Date | null): string | null => (d === null ? null : new Date(d).toISOString());

/** One run on the wire. */
export function toReportRunWire(run: ReportRunRecord, names: ReportNames): AgencyReportRun {
  return {
    id: run.id,
    kind: run.kind,
    subject: { id: run.subject_id, name: reportSubjectName(names, run.kind, run.subject_id) },
    account_id: run.account_id,
    range: { from: run.local_from, to: run.local_to, timezone: run.timezone },
    formats: orderedFormats(run.formats),
    audience: run.audience,
    status: run.status,
    requested_by: run.requested_by === null
      ? null
      : { user_id: run.requested_by, name: names.users.get(run.requested_by) ?? null },
    subscription_id: run.subscription_id,
    created_at: new Date(run.created_at).toISOString(),
    finished_at: iso(run.finished_at),
    expires_at: iso(run.expires_at),
    files: orderedFormats(run.files.map((f) => f.format)).map((format) => ({
      format,
      bytes: run.files.find((f) => f.format === format)!.bytes,
    })),
    truncated: run.truncated,
    error: run.status === 'failed' && run.error_code !== null
      // From the code, never the stored text (`failure-messages.ts`).
      ? { code: run.error_code, message: reportFailureMessage(run.error_code) }
      : null,
  };
}

/** The names a run shows. */
export function runNameRef(run: ReportRunRecord): ReportNameRef {
  return { kind: run.kind, subject_id: run.subject_id, account_id: run.account_id, userIds: [run.requested_by] };
}

/** The names a subscription shows. */
export function subscriptionNameRef(sub: ReportSubscriptionRecord): ReportNameRef {
  return {
    kind: sub.kind,
    subject_id: sub.subject_id,
    account_id: sub.account_id,
    userIds: [sub.created_by, ...sub.recipient_user_ids],
  };
}

/** One subscription on the wire. */
export function toReportSubscriptionWire(sub: ReportSubscriptionRecord, names: ReportNames): AgencyReportSubscription {
  return {
    id: sub.id,
    kind: sub.kind,
    subject: { id: sub.subject_id, name: reportSubjectName(names, sub.kind, sub.subject_id) },
    account_id: sub.account_id,
    cadence: sub.cadence,
    send_local_time: sub.send_local_time,
    send_weekday: sub.send_weekday,
    send_monthday: sub.send_monthday,
    timezone: sub.timezone,
    formats: orderedFormats(sub.formats),
    recipients: sub.recipient_user_ids.map((userId) => ({ user_id: userId, name: names.users.get(userId) ?? null })),
    enabled: sub.enabled,
    next_run_at: iso(sub.next_run_at),
    last_run: sub.last_run,
    created_by: { user_id: sub.created_by, name: names.users.get(sub.created_by) ?? null },
    created_at: new Date(sub.created_at).toISOString(),
  };
}
