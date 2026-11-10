/**
 * The draft "Ready to launch?" checklist (`GET …/insights/readiness`, and the draft headline's
 * `ready`). Part of `src/agency/insights/` (docs/insights.md "API", where the `detail` keys of
 * each check are listed).
 *
 * A check is `fail` when the campaign cannot dial as configured, `warn` when it can but something
 * is likely wrong, `pass` otherwise; `ready` is "no `fail`".
 */
import {
  AGENCY_READINESS_CHECK_CODES,
  type AgencyInsightsReadiness,
  type AgencyReadinessCheck,
  type AgencyReadinessCheckCode,
} from '@magick-agency/contracts/api/agency/insights';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { announcementRepository } from '@magick-agency/db/repositories/announcement.repository';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { agencyInsightsReadRepository, type RosterCounts } from '../../db/repositories/agency.repository.js';
import { readRoster } from './roster.js';
import { callingHoursDefault, hhmm } from './settings.js';

type Check = Omit<AgencyReadinessCheck, 'code'>;

/** What the checks read, gathered first so the checks themselves are pure. */
export interface ReadinessFacts {
  roster: Pick<RosterCounts, 'total' | 'unassigned_open'>;
  lastUpload: { rejected: number; duplicates: number; dedupe_columns: string[]; phone_column: string | null } | null;
  staffed: number;
  onDnc: number;
  clipPresent: boolean;
}

/** Every check, in the contract's order, from the facts. Pure. */
export function readinessChecks(campaign: AgencyCampaignRecord, f: ReadinessFacts): AgencyReadinessCheck[] {
  const catalog = Array.isArray(campaign.disposition_catalog) ? campaign.disposition_catalog : [];
  const callerIds = (campaign.caller_ids ?? []).filter((c) => typeof c === 'string' && c.trim().length > 0);
  const mode = campaign.assignment_mode;
  const checks: Record<AgencyReadinessCheckCode, Check> = {
    roster_uploaded: {
      result: f.roster.total > 0 ? 'pass' : 'fail',
      count: f.roster.total,
      detail: {
        rejected: f.lastUpload?.rejected ?? null,
        duplicates: f.lastUpload?.duplicates ?? null,
        // `detail` holds scalars: the key's columns as one label, `Loan No + Branch`.
        dedupe_column: f.lastUpload && f.lastUpload.dedupe_columns.length > 0 ? f.lastUpload.dedupe_columns.join(' + ') : null,
      },
    },
    // Implied by any committed upload, or by a roster at all (a retry campaign's is seeded from
    // its parent's contacts, each of which has a phone): there is nothing to map without one.
    phone_column_mapped: {
      result: f.lastUpload !== null || f.roster.total > 0 ? 'pass' : 'fail',
      count: null,
      detail: { phone_column: f.lastUpload?.phone_column ?? null },
    },
    outcomes_configured: {
      result: catalog.length > 0 ? 'pass' : 'fail',
      count: catalog.length,
      detail: { overrides: catalog.filter((d) => !!d?.override).length },
    },
    caller_ids_present: {
      result: callerIds.length > 0 ? 'pass' : 'fail',
      count: callerIds.length,
      detail: {},
    },
    calling_hours_set: {
      result: callingHoursDefault(campaign) ? 'warn' : 'pass',
      count: null,
      detail: {
        window: `${hhmm(campaign.calling_window_start)}–${hhmm(campaign.calling_window_end)}`,
        timezone: campaign.default_timezone,
      },
    },
    agents_staffed: {
      result: f.staffed > 0 ? 'pass' : 'fail',
      count: f.staffed,
      detail: {},
    },
    // Pool mode dials every open contact whoever owns it; strict never dials an unowned one
    // (fail); preferred dials them from the shared pool (warn).
    contacts_allocated: mode === 'pool'
      ? { result: 'pass', count: null, detail: {} }
      : {
          result: f.roster.unassigned_open === 0 ? 'pass' : mode === 'strict' ? 'fail' : 'warn',
          count: f.roster.unassigned_open,
          detail: {},
        },
    abandonment_clip: {
      result: f.clipPresent ? 'pass' : 'warn',
      count: null,
      detail: {},
    },
    contacts_on_dnc: {
      result: f.onDnc > 0 ? 'warn' : 'pass',
      count: f.onDnc,
      detail: {},
    },
  };
  return AGENCY_READINESS_CHECK_CODES.map((code) => ({ code, ...checks[code] }));
}

/** Read the facts for `campaign`. `roster` may be passed when the caller already read it. */
export async function readinessFacts(campaign: AgencyCampaignRecord, roster?: RosterCounts): Promise<ReadinessFacts> {
  const clipId = campaign.abandon_announcement_id;
  const [counts, upload, staffing, onDnc, clip] = await Promise.all([
    roster ? Promise.resolve(roster) : readRoster(campaign),
    agencyInsightsReadRepository.latestCompletedUpload(campaign.tenant_id, campaign.id),
    agencyCampaignAgentRepository.listActiveForCampaign(campaign.id, campaign.tenant_id),
    agencyInsightsReadRepository.contactsOnDnc({
      campaignId: campaign.id, tenantId: campaign.tenant_id, accountId: campaign.account_id,
    }),
    // The abandonment clip's own resolution (`abandon-clip.ts`): a dangling or retired id plays
    // nothing, the same as none.
    clipId ? announcementRepository.findActiveByIdScoped(clipId, campaign.tenant_id, campaign.account_id) : Promise.resolve(null),
  ]);
  return {
    roster: counts,
    lastUpload: upload
      ? { rejected: upload.rejected, duplicates: upload.duplicates, dedupe_columns: upload.dedupe_columns, phone_column: upload.phone_column }
      : null,
    staffed: staffing.length,
    onDnc,
    clipPresent: clip !== null,
  };
}

export async function computeReadiness(campaign: AgencyCampaignRecord, roster?: RosterCounts): Promise<AgencyInsightsReadiness> {
  const checks = readinessChecks(campaign, await readinessFacts(campaign, roster));
  return {
    campaign_id: campaign.id,
    ready: checks.every((c) => c.result !== 'fail'),
    checks,
    generated_at: new Date().toISOString(),
  };
}
