import { abandonmentBreachesCeiling } from '@magick-agency/domain/abandonment-predicate';
import type { AgencyCampaign, AgencyCampaignStats } from '../../types/agency-campaign';
import { formatCount, pct } from '../format/number';
import { formatDayMonthYear } from '../format/date';
import { ceilingPctText, rateOverCeilingText } from './abandonmentCeiling';
import { clockTime, dayMonth, sameDay } from './stationFormat';

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
 *  - `unchecked` (AW1): the Resume preflight could not re-read the campaign, so why it is paused
 *    is not known (Live floor's card holds only the board's status). Asked rather than resumed
 *    silently: a guardrail pause must not go through unasked because a read failed.
 *
 * "Over" is the guardrail's rule (`abandonmentBreachesCeiling`, the server's `breachedRows`
 * rule), not the Insights sample floor: the copy promises a pause, so it follows what pauses.
 * The copy names what pauses a campaign "the dialler" and its ceiling "the 3% limit", as the
 * health strip's diagnosis does.
 */
export type ResumeWarningKind = 'abandonment_pause' | 'over_ceiling' | 'unchecked';

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
const PAUSED_AGAIN = 'the dialler will pause the campaign again within about a minute';

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

/**
 * "3.8% (12 abandoned out of 316 answered calls)". A rate over the ceiling is said on as many
 * decimals as it takes to read as over it (`rateOverCeilingText`).
 */
function rateWithSample(rate: RateNow, ceilingPct: number | null): string {
  const text = rate.over ? rateOverCeilingText(rate.pct, ceilingPct) : pct(rate.pct);
  return `${text} (${formatCount(rate.abandoned)} abandoned out of ${formatCount(rate.answered)} answered calls)`;
}

/** "the 3% limit", or "the limit" when no ceiling is carried. */
function limitText(ceilingPct: number | null): string {
  return ceilingPct === null ? 'the limit' : `the ${ceilingPctText(ceilingPct)} limit`;
}

/** The campaign's ceiling: the row's, else the one its stats carry. */
function ceilingOf(campaign: Partial<ResumeWarningCampaign>, stats: ResumeWarningStats | null): number | null {
  if (typeof campaign.abandonment_ceiling_pct === 'number') return campaign.abandonment_ceiling_pct;
  return typeof stats?.abandonment_ceiling_pct === 'number' ? stats.abandonment_ceiling_pct : null;
}

/**
 * The warning Resume shows for this campaign, or null when Resume should go straight through.
 * Only a `paused` campaign is ever warned about (Resume is offered on nothing else).
 *
 * `campaignRead: false` says the preflight could not re-read the campaign: `campaign` is only
 * what the caller held (on Live floor, the board's status), so why it is paused is not known.
 * It then asks anyway (`unchecked`), unless the rate is over the ceiling now, which
 * `over_ceiling` says whatever paused it.
 */
export function resumeWarning(
  campaign: Partial<ResumeWarningCampaign> & Pick<ResumeWarningCampaign, 'status'>,
  stats: ResumeWarningStats | null,
  { campaignRead = true }: { campaignRead?: boolean } = {},
): ResumeWarning | null {
  if (campaign.status !== 'paused') return null;
  const ceiling = ceilingOf(campaign, stats);
  const now = rateNow(stats, ceiling);

  if (campaignRead && campaign.pause_reason === 'abandonment_ceiling') {
    const atPause = campaign.pause_abandonment_rate_pct;
    const why = typeof atPause === 'number'
      ? `The dialler paused this campaign automatically: its abandonment rate over the last 24 hours reached ${rateOverCeilingText(atPause, ceiling)}, over ${limitText(ceiling)}.`
      : `The dialler paused this campaign automatically: its abandonment rate over the last 24 hours went over ${limitText(ceiling)}.`;
    let nowLine: string;
    if (now?.over) {
      nowLine = `The rate now is ${rateWithSample(now, ceiling)}, still over the limit. If you resume now, ${PAUSED_AGAIN}.`;
    } else if (now) {
      nowLine = `The rate now is ${rateWithSample(now, ceiling)}. If the rate goes over the limit again, `
        + 'the dialler will pause the campaign within about a minute.';
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
        `This campaign’s abandonment rate over the last 24 hours is ${rateWithSample(now, ceiling)}, over ${limitText(ceiling)}. `
        + `If you resume now, ${PAUSED_AGAIN}. ${MORE_AGENTS}`,
      confirmLabel: RESUME_ANYWAY_LABEL,
    };
  }

  if (!campaignRead) {
    return {
      kind: 'unchecked',
      title: 'Could not check this campaign',
      message: now
        ? 'The console could not check why this campaign is paused. Its abandonment rate over the last '
          + `24 hours is ${rateWithSample(now, ceiling)}, within ${limitText(ceiling)}.`
        : 'The console could not check why this campaign is paused or what its abandonment rate is now. '
          + `If the dialler paused it because the rate went over the limit, and the rate is still over, ${PAUSED_AGAIN}.`,
      confirmLabel: RESUME_ANYWAY_LABEL,
    };
  }
  return null;
}

/**
 * When a pause happened, as part of a sentence: " at 5:33 AM" on `now`'s day, " on 23 Nov at
 * 5:33 AM" before it, with the year once it is not this one. Empty for a time that does not parse.
 */
function pausedWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  if (sameDay(at, now)) return ` at ${clockTime(at)}`;
  const day = at.getFullYear() === now.getFullYear() ? dayMonth(at) : formatDayMonthYear(at);
  return ` on ${day} at ${clockTime(at)}`;
}

/**
 * The header's line on a campaign the guardrail paused, from the campaign row alone, for a screen
 * whose health strip does not already say it (Settings reads no stats; after a failed stats read
 * the strip has no diagnosis): "Paused automatically at 11:03 AM: abandonment over the last 24
 * hours reached 4.2%, over the 3% limit." Null on any other campaign.
 */
export function abandonmentPauseLine(
  campaign: ResumeWarningCampaign,
  now: Date,
): string | null {
  if (campaign.status !== 'paused' || campaign.pause_reason !== 'abandonment_ceiling') return null;
  const at = campaign.paused_at ? pausedWhen(campaign.paused_at, now) : '';
  const ceiling = typeof campaign.abandonment_ceiling_pct === 'number' ? campaign.abandonment_ceiling_pct : null;
  const atPause = campaign.pause_abandonment_rate_pct;
  const what = typeof atPause === 'number'
    ? `abandonment over the last 24 hours reached ${rateOverCeilingText(atPause, ceiling)}, over ${limitText(ceiling)}`
    : `abandonment over the last 24 hours went over ${limitText(ceiling)}`;
  return `Paused automatically${at}: ${what}.`;
}
