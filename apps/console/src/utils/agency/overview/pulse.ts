import type { AgencyCampaignStats } from '../../../types/agency-campaign';
import { formatCount } from '../../format/number';
import { DASH } from './figure';

/*
  The campaigns home's "list worked" ring (`ActiveCampaignCard`): how much of a campaign's list
  nothing will dial again. The rest of the Overview panel this file served (the pulse strip, the
  floor bar) went with the panel when the Insights tab replaced it (IN1).
*/

export const RING_RADIUS = 30;

export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface ListWorkedRing {
  known: boolean;
  /** The share of the list that will never be dialed again, or `null`. */
  percent: number | null;
  /** {@link percent} formatted for the middle of the ring, or `—`. */
  label: string;
  /** `N of M contacts`, or a sentence saying why there is no figure. */
  caption: string;
  /** The arc's `stroke-dasharray`. `0` draws nothing, which is correct. */
  dashArray: string;
}

/**
 * How much of the list is finished with — completed, suppressed or exhausted.
 *
 * Those three and no others: they are the states nothing dials again. `pending`
 * and `in_flight` are both still ahead of the dialer, and counting in-flight
 * calls as worked would make the ring tick backwards when a call ends and its
 * contact returns to the queue for a retry.
 *
 * All three components AND the total are required. A ring drawn from two of
 * three understates the campaign by an unknowable amount while looking exactly
 * as authoritative as a complete one.
 */
export function listWorkedRing(stats: AgencyCampaignStats | null): ListWorkedRing {
  const total = stats?.contacts_total;
  const parts = [stats?.contacts_completed, stats?.contacts_suppressed, stats?.contacts_exhausted];

  const unknown = (caption: string): ListWorkedRing => ({
    known: false,
    percent: null,
    label: DASH,
    caption,
    dashArray: `0 ${RING_CIRCUMFERENCE.toFixed(1)}`,
  });

  if (typeof total !== 'number' || parts.some((p) => typeof p !== 'number')) {
    return unknown('The contact counts didn’t load.');
  }
  if (total <= 0) {
    // Not 0% worked — there is no list to have worked through.
    return unknown('No contacts have been added to this campaign yet.');
  }

  const worked = (parts as number[]).reduce((sum, p) => sum + p, 0);
  /*
    More contacts finished than exist. Not a state the server produces, but a payload
    assembled mid-deploy from two versions is, and the arc was already clamped
    while the number beside it was not — so the ring drew a full circle with
    "160%" in the middle of it and captioned it "16 of 10 contacts".

    Nothing here is salvageable: a percentage over 100 is not a rounding error,
    it means one of the four counts is from a different read, so it says nothing
    rather than a number nobody can act on.
  */
  if (worked > total) {
    return unknown('These counts don’t add up yet — they were read a moment apart.');
  }

  const percent = (worked / total) * 100;
  const dash = (RING_CIRCUMFERENCE * Math.min(Math.max(percent, 0), 100)) / 100;

  return {
    known: true,
    percent,
    label: `${Math.round(percent)}%`,
    caption: `${formatCount(worked)} of ${formatCount(total)} contacts`,
    dashArray: `${dash.toFixed(1)} ${RING_CIRCUMFERENCE.toFixed(1)}`,
  };
}
