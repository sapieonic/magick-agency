import { abandonmentBreachesCeiling } from '@magick-agency/domain/abandonment-predicate';
import type { AgencyCampaign, AgencyCampaignStats } from '../../types/agency-campaign';
import { formatCount, pct } from '../format/number';
import { formatTimeOrDate, upperDayPeriod } from '../format/date';
import { ceilingPctText } from './abandonmentCeiling';

/**
 * The warning before Resume (decisions AW1–AW3).
 *
 * On 23 Nov the abandonment guardrail paused two Staging campaigns 87 times over their ceilings,
 * and each time a supervisor pressed Resume within a minute: the console offered Resume for the
 * guardrail's pause like any other and never said the campaign would only be paused again. So
 * Resume now asks first, with the numbers. It is a warning, never a block: the supervisor can
 * always resume (the server's `/resume` does not read the rate either).
 *
 *  - `abandonment_pause` (AW1): the guardrail paused it (`pause_reason = 'abandonment_ceiling'`).
 *    Asked every time, whatever the rate is now: the supervisor is undoing a compliance stop.
 *  - `over_ceiling` (AW2): paused for any other reason (a supervisor, the carrier account) while
 *    the rolling 24-hour rate is over the ceiling by the guardrail's own rule, so resuming would
 *    be paused again within about a minute.
 *
 * "Over" is the guardrail's rule (`abandonmentBreachesCeiling`, the server's `breachedRows`
 * rule), not the Insights sample floor: the copy promises a pause, so it follows what pauses.
 */
export type ResumeWarningKind = 'abandonment_pause' | 'over_ceiling';

export interface ResumeWarning {
  kind: ResumeWarningKind;
  title: string;
  message: string;
  confirmLabel: string;
}

/** The campaign fields the warning reads: the row the Resume preflight has just re-read. */
export type ResumeWarningCampaign = Pick<
  AgencyCampaign,
  'status' | 'pause_reason' | 'paused_at' | 'pause_abandonment_rate_pct' | 'abandonment_ceiling_pct'
>;

/** The rolling 24-hour pair from `/stats`, read with the preflight; null when that read failed. */
export type ResumeWarningStats = Pick<AgencyCampaignStats, 'abandoned_24h' | 'answered_24h' | 'abandonment_ceiling_pct'>;

export const RESUME_ANYWAY_LABEL = 'Resume anyway';

/** Said on both warnings: the one thing that brings the rate down. */
const MORE_AGENTS = 'Get more agents on shift before you resume, so fewer answered calls are left waiting.';

/** The guardrail runs once a minute (the metrics refresh), so a breach is acted on within about one. */
const PAUSED_AGAIN = 'it will be paused again within about a minute';

interface RateNow {
  pct: number;
  abandoned: number;
  answered: number;
  /** Over the ceiling by the guardrail's rule: resuming is paused again. */
  over: boolean;
}

function rateNow(stats: ResumeWarningStats | null, ceilingPct: number | null): RateNow | null {
  if (!stats || typeof stats.abandoned_24h !== 'number' || typeof stats.answered_24h !== 'number') return null;
  if (stats.answered_24h <= 0) return null;
  const sample = { abandoned: stats.abandoned_24h, answered: stats.answered_24h };
  return {
    pct: (sample.abandoned / sample.answered) * 100,
    ...sample,
    over: ceilingPct !== null && abandonmentBreachesCeiling(sample, ceilingPct),
  };
}

/** "3.8% (12 of 316 answered calls)". */
function rateWithSample(rate: RateNow): string {
  return `${pct(rate.pct)} (${formatCount(rate.abandoned)} of ${formatCount(rate.answered)} answered calls)`;
}

/**
 * The warning Resume shows for this campaign, or null when Resume should go straight through.
 * Only a `paused` campaign is ever warned about (Resume is offered on nothing else).
 */
export function resumeWarning(
  campaign: ResumeWarningCampaign,
  stats: ResumeWarningStats | null,
): ResumeWarning | null {
  if (campaign.status !== 'paused') return null;
  const ceiling = typeof campaign.abandonment_ceiling_pct === 'number'
    ? campaign.abandonment_ceiling_pct
    : typeof stats?.abandonment_ceiling_pct === 'number' ? stats.abandonment_ceiling_pct : null;
  const limit = ceiling === null ? 'its limit' : `its ${ceilingPctText(ceiling)} limit`;
  const now = rateNow(stats, ceiling);

  if (campaign.pause_reason === 'abandonment_ceiling') {
    const atPause = campaign.pause_abandonment_rate_pct;
    const why = typeof atPause === 'number'
      ? `The dialler paused this campaign automatically: its abandonment rate over the last 24 hours reached ${pct(atPause)}, over ${limit}.`
      : `The dialler paused this campaign automatically: its abandonment rate over the last 24 hours went over ${limit}.`;
    let nowLine: string;
    if (now?.over) {
      nowLine = `It is ${rateWithSample(now)} now, still over the limit. If you resume now, ${PAUSED_AGAIN}.`;
    } else if (now) {
      nowLine = `It is ${rateWithSample(now)} now. If it goes over the limit again, ${PAUSED_AGAIN}.`;
    } else {
      nowLine = `If the rate is still over the limit when you resume, ${PAUSED_AGAIN}.`;
    }
    return {
      kind: 'abandonment_pause',
      title: 'Resume after an automatic pause?',
      message: `${why} ${nowLine} ${MORE_AGENTS}`,
      confirmLabel: RESUME_ANYWAY_LABEL,
    };
  }

  if (now?.over && ceiling !== null) {
    return {
      kind: 'over_ceiling',
      title: 'Abandonment is over the limit',
      message:
        `This campaign’s abandonment rate over the last 24 hours is ${rateWithSample(now)}, over ${limit}. `
        + `If you resume now, the dialler will pause it again within about a minute. ${MORE_AGENTS}`,
      confirmLabel: RESUME_ANYWAY_LABEL,
    };
  }
  return null;
}

/**
 * The header's line on a campaign the guardrail paused, from the campaign row alone, for a screen
 * whose health strip does not already say it (Settings reads no stats; a failed stats read shows
 * no strip): "Paused automatically at 11:03 AM: abandonment over the last 24 hours reached 4.2%,
 * over the 3% limit." Null on any other campaign.
 */
export function abandonmentPauseLine(
  campaign: ResumeWarningCampaign,
  now: Date,
): string | null {
  if (campaign.status !== 'paused' || campaign.pause_reason !== 'abandonment_ceiling') return null;
  const at = campaign.paused_at ? ` at ${upperDayPeriod(formatTimeOrDate(campaign.paused_at, now))}` : '';
  const ceiling = typeof campaign.abandonment_ceiling_pct === 'number'
    ? `the ${ceilingPctText(campaign.abandonment_ceiling_pct)} limit`
    : 'its limit';
  const atPause = campaign.pause_abandonment_rate_pct;
  const what = typeof atPause === 'number'
    ? `abandonment over the last 24 hours reached ${pct(atPause)}, over ${ceiling}`
    : `abandonment over the last 24 hours went over ${ceiling}`;
  return `Paused automatically${at}: ${what}.`;
}
