import { describe, it, expect } from 'vitest';
import {
  abandonmentRate,
  average,
  averageAttempts,
  averageHandleSeconds,
  connectRate,
  finishedCount,
  insightsRate,
  NOT_ENOUGH_CALLS,
  occupancy,
  penetrationRate,
  rateText,
  rateValue,
  timeShare,
} from '../../utils/agency/insights/rates';
import {
  agentLink,
  attemptsLink,
  contactsLink,
  rosterBucketLink,
} from '../../utils/agency/insights/links';
import { campaignAttemptFiltersFromParams } from '../../utils/agencyCampaignAttemptParams';
import { rosterFiltersFromParams } from '../../utils/agencyRosterFilters';
import { csvFromColumns, insightsCsvFilename, toCsv } from '../../utils/agency/insights/csv';
import { insightsShouldPoll } from '../../utils/agency/insights/polling';
import { longDuration, readinessDetail, readinessFix, actorName } from '../../utils/agency/insights/copy';
import { AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR } from '../../types/agency-insights';
import { headlineFor, readiness, roster } from '../helpers/insights';

describe('insights rates (decision IN5)', () => {
  it('is none on a zero denominator, never 0%', () => {
    expect(insightsRate(0, 0)).toEqual({ kind: 'none' });
    expect(rateText(insightsRate(0, 0))).toBe('—');
    expect(rateValue(insightsRate(5, 0))).toBeNull();
  });

  it('withholds below the one floor of 25, and publishes at it', () => {
    expect(AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR).toBe(25);
    expect(insightsRate(10, 24)).toEqual({ kind: 'withheld', denominator: 24 });
    expect(rateText(insightsRate(10, 24))).toBe(NOT_ENOUGH_CALLS);
    expect(rateText(insightsRate(10, 24), 'contacts')).toBe('Not enough contacts yet');
    expect(rateText(insightsRate(10, 25))).toBe('40%');
    expect(rateValue(insightsRate(1, 3, 1))).toBeCloseTo(33.333, 2);
  });

  it('derives the named rates from the counts the wire carries', () => {
    expect(rateText(connectRate({ dials: 1240, connected: 400 }))).toBe('32.3%');
    expect(rateText(abandonmentRate({ abandoned: 21, answered: 1000 }))).toBe('2.1%');
    expect(rateText(penetrationRate(roster()), 'contacts')).toBe('62%');
    expect(finishedCount(roster())).toBe(545);
    expect(averageAttempts(roster())).toBe(2);
    expect(averageAttempts({ dials_placed: 0, attempted: 0 })).toBeNull();
  });

  it('averages handle time over connected calls and wrap-up over the measured ones', () => {
    const h = averageHandleSeconds({ talk_seconds: 4000, connected: 20, wrapup_seconds: 300, wrapup_measured: 10 });
    expect(h).toEqual({ talk: 200, wrapup: 30, handle: 230 });
    expect(averageHandleSeconds({ talk_seconds: 0, connected: 0, wrapup_seconds: 0, wrapup_measured: 0 }).handle).toBeNull();
  });

  it('applies no sample floor to a time ratio, only the zero rule', () => {
    expect(timeShare(5, 10)).toBe(50);
    expect(timeShare(5, 0)).toBeNull();
    expect(occupancy({ online_seconds: 100, state_seconds: { available: 40, on_call: 50, wrapup: 10, break_by_reason: {} } })).toBe(60);
    expect(average(10, 0)).toBeNull();
  });
});

describe('drill-down links', () => {
  it('uses the contacts tab’s own filter names where they exist', () => {
    expect(contactsLink('c 1', { state: ['suppressed'], suppressed_reason: ['dnc'] })).toBe(
      '/agency/campaigns/c%201/contacts?state=suppressed&suppressed_reason=dnc',
    );
    expect(contactsLink('c1', { assigned_to: null })).toBe('/agency/campaigns/c1/contacts?assigned_to=unassigned');
    expect(contactsLink('c1', { assigned_to: 'usr_a', last_disposition: 'ptp' })).toBe(
      '/agency/campaigns/c1/contacts?last_disposition=ptp&assigned_to=usr_a',
    );
  });

  it('uses the list pages’ final names: waiting/attempted, and the attempts filters', () => {
    expect(contactsLink('c1', { state: ['pending'], waiting: 'callback', attempted: false })).toBe(
      '/agency/campaigns/c1/contacts?state=pending&waiting=callback&attempted=0',
    );
    expect(
      attemptsLink('c1', {
        outcome: ['no_answer', 'busy'],
        disposition: 'ptp',
        agent_user_id: 'usr_a',
        caller_id: '+9120',
        redial: true,
        agent_manual: true,
        agent_reopened: true,
        from: '2026-11-03T18:30:00.000Z',
        to: '2026-11-04T18:30:00.000Z',
      }),
    ).toBe(
      '/agency/campaigns/c1/attempts?outcome=no_answer&outcome=busy&disposition_code=ptp&agent_user_id=usr_a'
      + '&caller_id=%2B9120&redial=1&agent_manual=1&agent_reopened=1&placed=1'
      + '&dialed_from=2026-11-03T18%3A30%3A00.000Z&dialed_to=2026-11-04T18%3A30%3A00.000Z',
    );
  });

  it('sends the range as the half-open dialled window, never the list’s inclusive created_at from/to', () => {
    const url = new URL(attemptsLink('c1', { from: '2026-11-03T18:30:00.000Z', to: '2026-11-04T18:30:00.000Z' }), 'http://x');
    expect(url.searchParams.get('dialed_from')).toBe('2026-11-03T18:30:00.000Z');
    expect(url.searchParams.get('dialed_to')).toBe('2026-11-04T18:30:00.000Z');
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
  });

  it('marks every attempts link placed-only, so a lifetime number lists placed dials', () => {
    expect(attemptsLink('c1')).toBe('/agency/campaigns/c1/attempts?placed=1');
  });

  it('round-trips: what a link writes is what the list page reads', () => {
    const attempts = new URL(attemptsLink('c1', {
      outcome: 'connected', disposition: 'ptp', agent_user_id: 'usr_a', caller_id: '+9120', redial: true,
      agent_manual: true, agent_reopened: true, from: '2026-11-03T18:30:00.000Z', to: '2026-11-04T18:30:00.000Z',
    }), 'http://x');
    expect(campaignAttemptFiltersFromParams(attempts.searchParams)).toEqual({
      outcome: ['connected'], disposition_code: ['ptp'], agent_user_id: 'usr_a', caller_id: '+9120',
      redial: '1', agent_manual: '1', agent_reopened: '1', placed: '1',
      dialed_from: '2026-11-03T18:30:00.000Z', dialed_to: '2026-11-04T18:30:00.000Z',
    });
    const contacts = new URL(contactsLink('c1', {
      state: ['pending'], waiting: 'retry', assigned_to: null, attempted: true,
    }), 'http://x');
    expect(rosterFiltersFromParams(contacts.searchParams)).toEqual({
      state: ['pending'], waiting: 'retry', assigned_to: ['unassigned'], attempted: '1',
    });
  });

  it('maps every roster bucket to the contacts that make it up', () => {
    expect(rosterBucketLink('c1', 'total')).toBe('/agency/campaigns/c1/contacts');
    expect(rosterBucketLink('c1', 'waiting_due_now')).toBe('/agency/campaigns/c1/contacts?state=pending&waiting=due_now');
    expect(rosterBucketLink('c1', 'in_wrapup')).toBe('/agency/campaigns/c1/contacts?state=connected');
    expect(rosterBucketLink('c1', 'suppressed_other')).toBe(
      '/agency/campaigns/c1/contacts?state=suppressed&suppressed_reason=max_attempts&suppressed_reason=manual',
    );
    expect(rosterBucketLink('c1', 'never_attempted')).toBe('/agency/campaigns/c1/contacts?attempted=0');
  });

  it('sends an agent row to the Agents tab, since a performance view has no URL', () => {
    expect(agentLink('c1', 'usr_a')).toBe('/agency/campaigns/c1/agents');
  });
});

describe('CSV (RFC 4180)', () => {
  it('writes a header, CRLF records and unformatted numbers', () => {
    expect(toCsv(['Agent', 'Dials'], [['Priya', 12345], ['Vikram', 0]])).toBe('Agent,Dials\r\nPriya,12345\r\nVikram,0\r\n');
  });

  it('quotes commas, quotes and line breaks, doubling an inner quote', () => {
    expect(toCsv(['File'], [['october, cycle "B".csv'], ['two\nlines'], ['cr\rhere']])).toBe(
      'File\r\n"october, cycle ""B"".csv"\r\n"two\nlines"\r\n"cr\rhere"\r\n',
    );
  });

  it('leaves a null, an absent or a non-finite value empty, never 0', () => {
    expect(toCsv(['a', 'b', 'c', 'd'], [[null, undefined, Number.NaN, true]])).toBe('a,b,c,d\r\n,,,true\r\n');
  });

  it('builds from column definitions', () => {
    const csv = csvFromColumns([{ header: 'n', value: (r: { n: number }) => r.n }], [{ n: 1 }, { n: 2 }]);
    expect(csv).toBe('n\r\n1\r\n2\r\n');
  });

  it('names the file after the section and a sanitised campaign name', () => {
    expect(insightsCsvFilename('EMI: Pune/Oct', 'allocation', 'c1')).toBe('insights-allocation-EMI- Pune-Oct.csv');
    expect(insightsCsvFilename(null, 'roster', 'c1')).toBe('insights-roster-c1.csv');
  });
});

describe('polling rule', () => {
  it('polls running and stopping, and paused only while calls finish', () => {
    expect(insightsShouldPoll({ status: 'running', headline: headlineFor('running') })).toBe(true);
    expect(insightsShouldPoll({ status: 'stopping', headline: headlineFor('stopping') })).toBe(true);
    expect(insightsShouldPoll({ status: 'paused', headline: headlineFor('paused') })).toBe(true);
    const drained = headlineFor('paused');
    drained.paused = { ...drained.paused!, calls_finishing: 0 };
    expect(insightsShouldPoll({ status: 'paused', headline: drained })).toBe(false);
  });

  it('never polls a draft, a final state, or before the first answer', () => {
    for (const status of ['draft', 'stopped', 'completed'] as const) {
      expect(insightsShouldPoll({ status, headline: headlineFor(status) })).toBe(false);
    }
    expect(insightsShouldPoll(null)).toBe(false);
  });
});

describe('copy', () => {
  it('says days past a day, and words below it', () => {
    expect(longDuration(3 * 86_400 + 3600)).toBe('3d 1h');
    expect(longDuration(2 * 86_400)).toBe('2d');
    expect(longDuration(5820)).toBe('1h 37m');
  });

  it('names a missing user as such, and the system as the dialler', () => {
    expect(actorName(null)).toBe('The dialler');
    expect(actorName({ user_id: 'u', name: null })).toBe('A former user');
  });

  it('words each readiness check from its count and detail', () => {
    const byCode = Object.fromEntries(readiness().checks.map((c) => [c.code, c]));
    expect(readinessDetail(byCode['roster_uploaded']!, 'strict')).toBe('1,000 contacts · last upload: 212 rejected, 96 duplicates on Loan No');
    expect(readinessDetail(byCode['calling_hours_set']!, 'strict')).toBe('Still on the 09:00–20:00 default');
    // The server's detail for a set window: `window` and the campaign's `timezone`.
    expect(readinessDetail({ code: 'calling_hours_set', result: 'pass', count: null, detail: { window: '08:00–17:30', timezone: 'Asia/Kolkata' } }, 'strict'))
      .toBe('Set to 08:00–17:30 (Asia/Kolkata)');
    expect(readinessDetail({ code: 'calling_hours_set', result: 'pass', count: null, detail: { window: '08:00–17:30' } }, 'strict'))
      .toBe('Set to 08:00–17:30');
    expect(readinessDetail(byCode['contacts_allocated']!, 'strict')).toBe('Strict mode: 1,410 unassigned will never be dialled');
    expect(readinessDetail(byCode['contacts_allocated']!, 'pool')).toBe('1,410 unassigned will be dialled from the shared pool');
    expect(readinessDetail(byCode['abandonment_clip']!, 'strict')).toBe('None: abandoned calls hang up silently');
    expect(readinessDetail(byCode['contacts_on_dnc']!, 'strict')).toBe('318 contacts will be skipped');
  });

  it('sends each Fix to the screen that fixes it', () => {
    expect(readinessFix('roster_uploaded', 'c1').to).toBe('/agency/campaigns/c1/contacts/add');
    expect(readinessFix('calling_hours_set', 'c1').to).toBe('/agency/campaigns/c1/settings');
    expect(readinessFix('abandonment_clip', 'c1').to).toBe('/agency/campaigns/c1/settings');
    expect(readinessFix('agents_staffed', 'c1').to).toBe('/agency/campaigns/c1/agents');
    expect(readinessFix('contacts_allocated', 'c1').to).toBe('/agency/campaigns/c1/agents');
  });
});
