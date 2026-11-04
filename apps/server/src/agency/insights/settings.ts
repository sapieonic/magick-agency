/**
 * The summary's `settings` block: the campaign row as the page shows it. Part of
 * `src/agency/insights/` (docs/insights.md "API").
 */
import { AGENCY_WRAPUP_REDIAL_LIMIT } from '@magick-agency/contracts/agency';
import type { AgencyInsightsSettings } from '@magick-agency/contracts/api/agency/insights';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { DEFAULT_RETRY_POLICY } from '../retry-policy.js';

/**
 * The calling-hours column defaults (0001: `calling_window_start` 09:00, `calling_window_end`
 * 20:00, `calling_days` `{1,2,3,4,5}`). A campaign still on all three has never had its hours set:
 * the launch checklist warns (decision IN7) and `calling_hours_default` is true.
 */
export const CALLING_HOURS_DEFAULT = { start: '09:00', end: '20:00', days: [1, 2, 3, 4, 5] } as const;

/** `HH:MM` of a Postgres `TIME` (`09:00:00`), `24:00` kept. */
export function hhmm(time: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : time;
}

/** Whether the window and days are still the column defaults. */
export function callingHoursDefault(campaign: Pick<AgencyCampaignRecord, 'calling_window_start' | 'calling_window_end' | 'calling_days'>): boolean {
  const days = [...new Set((campaign.calling_days ?? []).map(Number))].sort((a, b) => a - b);
  return hhmm(campaign.calling_window_start) === CALLING_HOURS_DEFAULT.start
    && hhmm(campaign.calling_window_end) === CALLING_HOURS_DEFAULT.end
    && days.length === CALLING_HOURS_DEFAULT.days.length
    && days.every((d, i) => d === CALLING_HOURS_DEFAULT.days[i]);
}

/**
 * The outcomes a customer's not answering is charged to (`attempt_count`). `max_attempts` on the
 * page is the most dials any of them allows, each resolved per key against
 * `DEFAULT_RETRY_POLICY` as the retry engine does (`resolveRetryDecision`).
 */
const CUSTOMER_RETRY_OUTCOMES = ['no_answer', 'busy', 'failed', 'abandoned'] as const;

export function maxAttempts(policy: AgencyCampaignRecord['retry_policy'] | null | undefined): number {
  let most = 0;
  for (const outcome of CUSTOMER_RETRY_OUTCOMES) {
    const rule = policy?.[outcome] ?? DEFAULT_RETRY_POLICY[outcome];
    const n = Number(rule?.max_attempts ?? 0);
    if (Number.isFinite(n) && n > most) most = n;
  }
  return most;
}

export function insightsSettings(
  campaign: AgencyCampaignRecord,
  analysisProfile: { id: string; name: string | null } | null,
): AgencyInsightsSettings {
  const catalog = Array.isArray(campaign.disposition_catalog) ? campaign.disposition_catalog : [];
  return {
    timezone: campaign.default_timezone,
    calling_window_start: hhmm(campaign.calling_window_start),
    calling_window_end: hhmm(campaign.calling_window_end),
    calling_days: [...(campaign.calling_days ?? [])].map(Number),
    calling_hours_default: callingHoursDefault(campaign),
    caller_ids: [...(campaign.caller_ids ?? [])],
    max_attempts: maxAttempts(campaign.retry_policy),
    wrapup_seconds: campaign.wrapup_seconds ?? null,
    wrapup_auto_return: campaign.wrapup_auto_return,
    allow_wrapup_redial: campaign.allow_wrapup_redial,
    wrapup_redial_limit: AGENCY_WRAPUP_REDIAL_LIMIT,
    allow_agent_retry: campaign.allow_agent_retry,
    agent_retry_rounds: campaign.agent_retry_rounds,
    agent_retry_cooldown_minutes: campaign.agent_retry_cooldown_minutes,
    override_outcomes: catalog
      .filter((d) => !!d && typeof d === 'object' && d.override && typeof d.override === 'object')
      .map((d) => ({
        code: d.code,
        label: d.label,
        extra_attempts: typeof d.override?.extra_attempts === 'number' ? d.override.extra_attempts : null,
        retry_delay: d.override?.retry_delay === true,
        calling_hours: d.override?.calling_hours === true,
      })),
    record_calls: campaign.record_calls,
    analysis_profile: analysisProfile,
    abandonment_ceiling_pct: campaign.abandonment_ceiling_pct,
    assignment_mode: campaign.assignment_mode,
  };
}
