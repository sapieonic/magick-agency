import { describe, expect, it } from 'vitest';
import { catalogForCall, recentCallWhen } from '../../utils/softphone/callLabels';
import { formatClockTime } from '../../utils/format/date';
import { BOOTSTRAP, CAMPAIGN, manualCall } from '../helpers/softphone';

/**
 * The recent-calls list's "when": a day as well as a time, so a call from last
 * week does not read as one from this morning. This project pins `TZ=UTC`.
 */
describe('recentCallWhen', () => {
  const now = new Date('2026-10-30T15:00:00Z');
  const at = (iso: string) => new Date(iso);

  it('says Today for a call earlier today', () => {
    const call = at('2026-10-30T00:05:00Z');
    expect(recentCallWhen(call, now)).toBe(`Today, ${formatClockTime(call)}`);
  });

  it('says Yesterday for one the calendar day before, however few hours ago', () => {
    const call = at('2026-10-29T23:55:00Z');
    expect(recentCallWhen(call, now)).toBe(`Yesterday, ${formatClockTime(call)}`);
  });

  it('gives the date for anything older, and the year once it is not this one', () => {
    expect(recentCallWhen(at('2026-10-28T09:00:00Z'), now)).toMatch(/^28 Oct, /);
    expect(recentCallWhen(at('2025-12-31T09:00:00Z'), now)).toMatch(/^31 Dec 2025, /);
  });

  it('counts calendar days across a month boundary', () => {
    const first = new Date('2026-11-01T08:00:00Z');
    expect(recentCallWhen(at('2026-10-31T22:00:00Z'), first)).toMatch(/^Yesterday, /);
  });
});

/*
 * The catalog a manual call's outcome is read against (`catalogForCall`): the tagged
 * campaign's, else the soft phone's own. A tagged call whose campaign is no longer
 * taggable is still read against that campaign, from bootstrap's `call_campaign`.
 */
describe('catalogForCall', () => {
  const tagged = manualCall({ tag: { campaign_id: CAMPAIGN.campaign_id, campaign_name: CAMPAIGN.campaign_name } });

  it('a taggable campaign\'s catalog for a tagged call; the untagged one otherwise', () => {
    expect(catalogForCall(tagged, BOOTSTRAP)).toBe(CAMPAIGN.disposition_catalog);
    expect(catalogForCall(manualCall(), BOOTSTRAP)).toBe(BOOTSTRAP.untagged.disposition_catalog);
  });

  it('falls back to call_campaign for the call it describes, and to nothing for another', () => {
    const done = { ...CAMPAIGN, status: 'completed' as const };
    const boot = { ...BOOTSTRAP, taggable_campaigns: [], call_campaign: done };
    expect(catalogForCall(tagged, boot)).toBe(done.disposition_catalog);
    const other = manualCall({ tag: { campaign_id: 'camp-9', campaign_name: 'Other' } });
    expect(catalogForCall(other, boot)).toBeUndefined();
  });
});
