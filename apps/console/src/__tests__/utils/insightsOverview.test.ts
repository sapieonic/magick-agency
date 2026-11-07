import { describe, it, expect } from 'vitest';
import {
  agentsTeaser,
  callsTeaser,
  campaignAttention,
  healthTeaser,
} from '../../utils/agency/insights/overview';
import { activity, allocation, allocationRow, health, summary } from '../helpers/insights';

/**
 * The Overview tab's rules (decision IN13): what makes the "Needs your
 * attention" list, in what order, and the two lines each detail tab's card says.
 */

const ids = (input: Parameters<typeof campaignAttention>[0]) => campaignAttention(input).items.map((i) => i.id);

describe('needs your attention', () => {
  it('ranks danger before warning before info, whatever order the rules ran in', () => {
    const items = campaignAttention({ summary: summary('running'), allocation: allocation(), health: health() }).items;
    const tones = items.map((i) => i.tone);
    expect(tones).toEqual([...tones].sort((a, b) => ['danger', 'warning', 'info'].indexOf(a) - ['danger', 'warning', 'info'].indexOf(b)));
    expect(items[0]?.id).toBe('callbacks-overdue');
  });

  it('says how many overdue callbacks have no owner, and how many belong to someone away', () => {
    const item = campaignAttention({ summary: summary('running'), allocation: allocation(), health: null }).items.find((i) => i.id === 'callbacks-overdue');
    expect(item?.title).toBe('2 callbacks overdue');
    // The fixture: 2 overdue, 2 in the pool, 2 with an owner who is away.
    expect(item?.body).toBe('None of them has an owner. 2 belong to an agent who is away. Customers were promised these calls.');
    expect(item?.tab).toBe('callbacks');
  });

  it('raises nothing for callbacks when none is overdue', () => {
    const none = allocation();
    none.totals.callbacks_overdue = 0;
    expect(ids({ summary: summary('running'), allocation: none, health: null })).not.toContain('callbacks-overdue');
  });

  it('warns when nobody assigned is on the floor of a running campaign, and only then', () => {
    const offline = allocation({ agents: [allocationRow({ state: 'offline' })] });
    expect(ids({ summary: summary('running'), allocation: offline, health: null })).toContain('no-agents');
    // Paused dials nothing until it is resumed, agents or none: an empty floor is not the problem.
    expect(ids({ summary: summary('paused'), allocation: offline, health: null })).not.toContain('no-agents');
    // A finished campaign needs nobody.
    expect(ids({ summary: summary('completed'), allocation: offline, health: null })).not.toContain('no-agents');
    // Someone on the floor.
    expect(ids({ summary: summary('running'), allocation: allocation(), health: null })).not.toContain('no-agents');
  });

  it('names the one assigned agent rather than counting "1 assigned agent"', () => {
    const one = allocation({ agents: [allocationRow({ state: 'offline' })] });
    const body = (a: typeof one) => campaignAttention({ summary: summary('running'), allocation: a, health: null }).items.find((i) => i.id === 'no-agents')?.body;
    expect(body(one)).toBe('The one assigned agent is not on the floor. Nothing dials until they join.');
    const two = allocation({ agents: [allocationRow({ state: 'offline' }), allocationRow({ agent_user_id: 'u-2', state: 'offline' })] });
    expect(body(two)).toBe('None of the 2 assigned agents is on the floor. Nothing dials until one joins.');
  });

  it('marks abandonment over the ceiling as danger, near it as a warning, and under it as clear', () => {
    const at = (abandoned: number) => campaignAttention({
      summary: summary('running'),
      allocation: null,
      health: health({ abandonment: { rolling_24h: { abandoned, answered: 1000 }, ceiling_pct: 3, auto_pauses: [] } }),
    });
    expect(at(35).items.find((i) => i.id === 'abandonment')?.tone).toBe('danger');
    expect(at(25).items.find((i) => i.id === 'abandonment')?.tone).toBe('warning');
    expect(at(10).items.find((i) => i.id === 'abandonment')).toBeUndefined();
    expect(at(10).clear).toContain('abandonment 1% (ceiling 3%)');
  });

  it('claims no pass on abandonment when too few calls were answered to measure it', () => {
    const { items, clear } = campaignAttention({
      summary: summary('running'),
      allocation: null,
      health: health({ abandonment: { rolling_24h: { abandoned: 0, answered: 3 }, ceiling_pct: 3, auto_pauses: [] } }),
    });
    expect(items.find((i) => i.id === 'abandonment')).toBeUndefined();
    expect(clear.join(' ')).not.toMatch(/abandonment/);
  });

  it('leaves a stall going on now to the health strip, which reads it as of now on every tab', () => {
    // The health read's episodes cover the range: one open now is missing from a past range.
    const open = health({
      stalls: {
        ...health().stalls,
        episodes: [{ reason: 'no_agents', started_at: '2026-11-04T10:00:00.000Z', ended_at: null, minutes: 12 }],
      },
    });
    const { items } = campaignAttention({ summary: summary('running'), allocation: null, health: open });
    expect(items.map((i) => i.title).join(' ')).not.toMatch(/Not dialling/);
  });

  it('counts carrier failures and missing recordings over the range, and says so when clear', () => {
    const { items, clear } = campaignAttention({ summary: summary('running'), allocation: null, health: health() });
    expect(items.find((i) => i.id === 'carrier-failures')?.title).toBe('60 dials failed at the carrier');
    expect(items.find((i) => i.id === 'recordings-missing')?.title).toBe('4 connected calls with no recording');
    // While it runs the latest recordings are still landing: a note, not a warning.
    expect(items.find((i) => i.id === 'recordings-missing')?.tone).toBe('info');
    expect(items.find((i) => i.id === 'recordings-missing')?.body).toMatch(/can take a few minutes/);
    const done = campaignAttention({ summary: summary('completed'), allocation: null, health: health() });
    expect(done.items.find((i) => i.id === 'recordings-missing')?.tone).toBe('warning');
    expect(done.items.find((i) => i.id === 'recordings-missing')?.body).not.toMatch(/can take a few minutes/);

    const tidy = campaignAttention({
      summary: summary('running'),
      allocation: null,
      health: health({ carrier_failures: 0, carrier_failures_by_code: [], recording: { connected: 400, recorded: 400 } }),
    });
    expect(tidy.clear).toEqual(expect.arrayContaining(['no carrier failures', 'every connected call recorded']));
  });

  it('keeps saying the calling hours were never set while the campaign can dial', () => {
    expect(ids({ summary: summary('running'), allocation: null, health: null })).toContain('calling-hours-default');
    expect(ids({ summary: summary('stopped'), allocation: null, health: null })).not.toContain('calling-hours-default');
    const set = summary('running');
    set.settings.calling_hours_default = false;
    expect(ids({ summary: set, allocation: null, health: null })).not.toContain('calling-hours-default');
  });

  it('claims nothing it has not read: no allocation and no health is no callbacks, agents or health items', () => {
    const set = summary('running');
    set.settings.calling_hours_default = false;
    expect(campaignAttention({ summary: set, allocation: null, health: null })).toEqual({ items: [], clear: [] });
  });
});

describe('the cards that open the other tabs', () => {
  it('Calls: the commonest way a dial ended, and the commonest disposition', () => {
    expect(callsTeaser(activity())).toEqual({
      line1: 'No answer on 40.3% of 1,240 dials.',
      line2: 'Top disposition: Promise to pay, 150 of 400 conversations.',
    });
  });

  it('Calls: below the rate floor gives the count, never "Not enough calls yet" in a sentence', () => {
    const few = activity();
    few.calls.dials = 12;
    few.calls.by_outcome = { no_answer: 7, connected: 5 } as typeof few.calls.by_outcome;
    expect(callsTeaser(few).line1).toBe('No answer on 7 of 12 dials.');
  });

  it('Calls: says so when nothing was dialled', () => {
    const none = activity();
    none.calls.dials = 0;
    expect(callsTeaser(none)).toEqual({ line1: 'No dials in this range.', line2: null });
  });

  it('Agents: who is on the floor now, and who carried the range', () => {
    const teaser = agentsTeaser(activity(), allocation());
    expect(teaser.line1).toBe('1 of 2 assigned agents online now.');
    expect(teaser.line2).toMatch(/made the most dials \(\d[\d,]*\); \d+ agents? with a success\.$/);
  });

  it('Health: the guardrail’s rate, and how long the dialler sat idle and why', () => {
    expect(healthTeaser(health())).toEqual({
      line1: 'Abandonment 2.1% over 24 hours, ceiling 3%.',
      line2: 'Idle 1h 26m in this range, mostly outside calling hours.',
    });
  });
});
