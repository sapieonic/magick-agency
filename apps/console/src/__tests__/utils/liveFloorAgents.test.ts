import { describe, expect, it } from 'vitest';
import type { AgencyFloorAgent, AgencyFloorResponse } from '@magick-agency/contracts/api/agency/floor';
import type { AgencyPromisesSummaryResponse } from '@magick-agency/contracts/api/agency/promises';
import {
  BREAK_OVERRUN_STEP_MINUTES,
  FLOOR_CARD_LABELS,
  breakOverrunItems,
  callsTodayText,
  cardsFor,
  cardsInState,
  breakOverrunDetail,
  floorAgentsWorking,
  floorBadges,
  floorCard,
  floorCardState,
  floorNowLine,
  floorRowsFor,
  floorStateCounts,
  floorTimerAnchor,
  disconnectedFor,
  disconnectedItems,
  disconnectedWords,
  helpDetail,
  helpItems,
  liveCallOf,
  offersMakeAvailable,
  rankFloorCards,
  sameFloorRow,
  stripeTone,
  supervisorAgentOf,
  willPayByCampaign,
  willPayFor,
  willPayLine,
} from '../../utils/agency/liveFloorAgents';
import { statusChangeLine } from '../../utils/agency/liveFloor';
import { formatAmountShort, sumPromiseAmounts } from '../../utils/format/promise';
import { sortByRank, homeBadgeCount, homeRank } from '../../utils/agency/home';
import { ackOf, stillAcknowledged } from '../../utils/agency/homeAcks';
import { AGENCY_FLOOR_STATE_LABELS } from '../../utils/agencyAgentFloor';
import { listenRefusalMessage, notListenableCopy } from '../../utils/listen/listenCopy';
import { listenTargetFor } from '../../utils/listen/liveCallsTable';
import { campaign, floorRow } from '../helpers/home';

/**
 * Live floor's agents (B28b): the floor row on the campaign floor's rules, the cards' order, the
 * chips, break overruns in Needs you now, Agents working from the floor, and Will pay's exact sums.
 */

const NOW = Date.parse('2026-11-18T14:00:00Z');
const ago = (minutes: number, seconds = 0) => new Date(NOW - minutes * 60_000 - seconds * 1000).toISOString();

const HELP = (raisedAt = ago(1), callId: string | null = 'call-1') => ({ raised_at: raisedAt, call_id: callId });

const CALL = (over: Partial<NonNullable<AgencyFloorAgent['call']>> = {}): NonNullable<AgencyFloorAgent['call']> => ({
  call_id: 'call-1',
  origin: 'campaign',
  correlation_id: 'att-1',
  customer_name: 'Ramesh Goud',
  connected_at: ago(3),
  aht_seconds: 120,
  listenable: true,
  not_listenable_reason: null,
  ...over,
});

describe('the floor row on the campaign floor’s rules', () => {
  it('counts a call being connected as on a call, and has a state for each chip', () => {
    expect(floorCardState(floorRow('a', { state: 'reserved' }))).toBe('on_call');
    expect(floorCardState(floorRow('a', { state: 'on_call' }))).toBe('on_call');
    expect(floorCardState(floorRow('a', { state: 'wrapup' }))).toBe('wrapup');
    expect(floorCardState(floorRow('a', { state: 'offline' }))).toBe('offline');
    expect(FLOOR_CARD_LABELS).toEqual({
      on_call: 'On a call', available: 'Ready', wrapup: 'Choosing outcome', softphone: 'On soft phone', break: 'Break', offline: 'Offline',
    });
    // Choosing outcome is Live floor's word alone.
    expect(AGENCY_FLOOR_STATE_LABELS.wrapup).toBe('Wrapping up');
  });

  it('puts a soft-phone session on a call while it has one, and on the soft phone (never a break) while it has none', () => {
    const manual = floorRow('a', { state: 'break', break_reason: 'soft_phone', state_since: ago(50), call: CALL({ origin: 'manual', connected_at: ago(2) }) });
    expect(floorCardState(manual)).toBe('on_call');
    expect(floorNowLine(manual, String)).toBe('Ramesh Goud');
    expect(floorTimerAnchor(manual)).toBe(ago(2));
    expect(floorBadges(manual).softphone).toBe(true);
    const idle = floorRow('b', { state: 'break', break_reason: 'soft_phone', state_since: ago(50) });
    expect(floorCardState(idle)).toBe('softphone');
    expect(floorNowLine(idle, String)).toBe('Taking calls by hand');
    expect(floorBadges(idle).softphone).toBe(false);
    expect(floorStateCounts([manual, idle, floorRow('c', { state: 'break', state_since: ago(5) })]).counts).toMatchObject({ on_call: 1, softphone: 1, break: 1 });
    // Neither is a long break.
    expect(breakOverrunItems(rankFloorCards([manual, idle], NOW), [])).toEqual([]);
  });

  it('maps a row onto the campaign floor’s row, a no-session row with an id no session has', () => {
    const mapped = supervisorAgentOf(floorRow('a', { calls_today: 7, client_kind: 'mobile' }));
    expect(mapped).toMatchObject({ session_id: 's-a', calls_handled: 7, client_kind: 'mobile', can_take_inbound: null });
    const absent = supervisorAgentOf(floorRow('b', { session_id: null, state: 'offline', state_since: null, connected: null, client_kind: null }));
    expect(absent).toMatchObject({ session_id: 'no-session:b', state_since: '', client_kind: 'web' });
  });

  it('measures each row against its own campaign’s wrap-up window and handle time', () => {
    // 60 s window + 60 s grace: past at 2:01, not at 1:59.
    expect(floorCard(floorRow('a', { state: 'wrapup', state_since: ago(2, 1) }), NOW).risk).toBe('wrapup_overrun');
    expect(floorCard(floorRow('a', { state: 'wrapup', state_since: ago(1, 59) }), NOW).risk).toBe('none');
    expect(floorCard(floorRow('a', { state: 'wrapup', state_since: ago(10), wrapup_window_seconds: null }), NOW).risk).toBe('none');
    // 120 s AHT: past twice it at 4:01.
    expect(floorCard(floorRow('a', { state: 'on_call', state_since: ago(4, 1), call: CALL() }), NOW).risk).toBe('call_overrun');
    expect(floorCard(floorRow('a', { state: 'on_call', state_since: ago(4, 1), call: CALL({ aht_seconds: null }) }), NOW).risk).toBe('none');
    expect(floorCard(floorRow('a', { state: 'break', state_since: ago(31) }), NOW).risk).toBe('long_break');
    expect(floorCard(floorRow('a', { state: 'break', break_reason: 'soft_phone', state_since: ago(90) }), NOW).risk).toBe('none');
    expect(floorCard(floorRow('a', { connected: false }), NOW).risk).toBe('disconnected');
    // `null` is a read that failed, never a lost connection.
    expect(floorCard(floorRow('a', { connected: null }), NOW).risk).toBe('none');
  });

  it('clocks a call from when the customer was connected, else from the last state change, and nothing for an absent agent', () => {
    const onCall = floorRow('a', { state: 'on_call', state_since: ago(5), call: CALL({ connected_at: ago(3) }) });
    expect(floorTimerAnchor(onCall)).toBe(ago(3));
    expect(floorCard(onCall, NOW).elapsedMs).toBe(3 * 60_000);
    expect(floorTimerAnchor(floorRow('a', { state: 'break', state_since: ago(7) }))).toBe(ago(7));
    const absent = floorRow('b', { session_id: null, state: 'offline', state_since: null });
    expect(floorTimerAnchor(absent)).toBeNull();
    expect(floorCard(absent, NOW).elapsedMs).toBeNull();
  });
});

describe('the cards’ order', () => {
  it('puts risk first (longest first within one), then the chips’ order of states, then the name', () => {
    const rows = [
      floorRow('off', { session_id: null, state: 'offline', state_since: null, connected: null, client_kind: null }),
      floorRow('brk', { state: 'break', state_since: ago(5) }),
      floorRow('rdy', { agent_name: 'Zara' }),
      floorRow('rd2', { agent_name: 'Anil' }),
      floorRow('cal', { state: 'on_call', call: CALL({ aht_seconds: null }) }),
      floorRow('wr1', { state: 'wrapup', state_since: ago(5) }),
      floorRow('wr2', { state: 'wrapup', state_since: ago(9) }),
      floorRow('lng', { state: 'break', state_since: ago(40) }),
      floorRow('cho', { state: 'wrapup', state_since: ago(0, 20) }),
    ];
    const before = rows.map((r) => r.agent_user_id);
    expect(rankFloorCards(rows, NOW).map((c) => c.row.agent_user_id)).toEqual([
      'wr2', 'wr1', 'lng', 'cal', 'rd2', 'rdy', 'cho', 'brk', 'off',
    ]);
    expect(rows.map((r) => r.agent_user_id)).toEqual(before);
  });

  it('filters by the chips, counting each state from the rows', () => {
    const rows = [floorRow('a'), floorRow('b', { state: 'reserved' }), floorRow('c', { state: 'on_call', call: CALL() }), floorRow('d', { session_id: null, state: 'offline', state_since: null })];
    expect(floorStateCounts(rows)).toEqual({ total: 4, help: 0, counts: { on_call: 2, available: 1, wrapup: 0, softphone: 0, break: 0, offline: 1 } });
    const cards = rankFloorCards(rows, NOW);
    expect(cardsInState(cards, 'on_call').map((c) => c.row.agent_user_id)).toEqual(['b', 'c']);
    expect(cardsInState(cards, 'all')).toHaveLength(4);
  });

  it('counts the agents asking for help beside their state, and filters to them (LF4)', () => {
    const rows = [floorRow('a'), floorRow('c', { state: 'on_call', call: CALL(), help: HELP() }), floorRow('w', { state: 'wrapup', help: HELP(ago(2)) })];
    expect(floorStateCounts(rows)).toEqual({ total: 3, help: 2, counts: { on_call: 1, available: 1, wrapup: 1, softphone: 0, break: 0, offline: 0 } });
    expect(cardsInState(rankFloorCards(rows, NOW), 'help').map((c) => c.row.agent_user_id)).toEqual(['w', 'c']);
  });

  it('puts an agent asking for help first, the longest waiting first, over every risk (LF28)', () => {
    const rows = [
      floorRow('stuck', { state: 'wrapup', state_since: ago(10), wrapup_window_seconds: 30 }),
      floorRow('new', { state: 'on_call', call: CALL(), help: HELP(ago(1)) }),
      floorRow('ready'),
      floorRow('old', { state: 'wrapup', state_since: ago(3), help: HELP(ago(3)) }),
    ];
    expect(rankFloorCards(rows, NOW).map((c) => c.row.agent_user_id)).toEqual(['old', 'new', 'stuck', 'ready']);
  });

  it('narrows to a campaign’s sessions: soft-phone sessions and absent agents name none', () => {
    const rows = [floorRow('a'), floorRow('b', { campaign_id: 'c2' }), floorRow('c', { campaign_id: null })];
    expect(floorRowsFor(rows, 'c1').map((r) => r.agent_user_id)).toEqual(['a']);
    expect(floorRowsFor(rows, null)).toHaveLength(3);
    // The ranked cards narrow by the same rule, keeping their order.
    const cards = rankFloorCards([...rows, floorRow('d', { state: 'break', state_since: ago(40) })], NOW);
    expect(cardsFor(cards, 'c1').map((c) => c.row.agent_user_id)).toEqual(['d', 'a']);
    expect(cardsFor(cards, null)).toBe(cards);
  });
});

describe('a card', () => {
  const fmt = (iso: string) => `T${iso.slice(11, 16)}`;

  it('names the customer on a call, never a number, and says where everyone else is', () => {
    expect(floorNowLine(floorRow('a', { state: 'on_call', call: CALL() }), fmt)).toBe('Ramesh Goud');
    expect(floorNowLine(floorRow('a', { state: 'on_call', call: CALL({ customer_name: null }) }), fmt)).toBe('No name');
    expect(floorNowLine(floorRow('a', { state: 'on_call', call: CALL({ customer_name: null, origin: 'inbound' }) }), fmt)).toBe('Unknown caller');
    expect(floorNowLine(floorRow('a'), fmt)).toBe('Waiting for a call');
    expect(floorNowLine(floorRow('a', { state: 'break', break_label: 'Tea' }), fmt)).toBe('Tea');
    expect(floorNowLine(floorRow('a', { state: 'wrapup' }), fmt)).toBe('After the call');
    expect(floorNowLine(floorRow('a', { session_id: null, state: 'offline', state_since: null, left_at: '2026-11-18T08:10:00Z' }), fmt)).toBe('Left at T08:10');
    expect(floorNowLine(floorRow('a', { session_id: null, state: 'offline', state_since: null }), fmt)).toBe('Not signed in today');
    // Conversations, never "calls": the Calls today tile counts dials.
    expect(callsTodayText(1)).toBe('1 conversation today');
    expect(callsTodayText(1284)).toBe('1,284 conversations today');
  });

  it('carries the campaign floor’s badges, a lost connection only on a read that said so', () => {
    expect(floorBadges(floorRow('a', { client_kind: 'mobile', on_inbound_call: true, connected: false }))).toEqual({
      mobile: true, inbound: true, softphone: false, connectionLost: true,
    });
    expect(floorBadges(floorRow('a', { state: 'break', break_reason: 'soft_phone', connected: null, call: CALL({ origin: 'manual' }) })).softphone).toBe(true);
    expect(floorBadges(floorRow('a', { connected: null })).connectionLost).toBe(false);
  });

  it('offers Make available only when stuck: a wrap-up past its window, or an inbound outcome owed off wrap-up', () => {
    expect(offersMakeAvailable(floorCard(floorRow('a', { state: 'wrapup', state_since: ago(5) }), NOW))).toBe(true);
    expect(offersMakeAvailable(floorCard(floorRow('a', { state: 'wrapup', state_since: ago(0, 30) }), NOW))).toBe(false);
    // An ordinary inbound wrap-up owes its outcome from the call's end: not stuck until past its window.
    expect(offersMakeAvailable(floorCard(floorRow('a', { state: 'wrapup', inbound_outcome_owed: true, state_since: ago(0, 5) }), NOW))).toBe(false);
    expect(offersMakeAvailable(floorCard(floorRow('a', { state: 'wrapup', inbound_outcome_owed: true, state_since: ago(5) }), NOW))).toBe(true);
    // Rehydrated onto a break with the outcome still owed: nothing else will close it.
    expect(offersMakeAvailable(floorCard(floorRow('a', { state: 'break', inbound_outcome_owed: true }), NOW))).toBe(true);
    expect(offersMakeAvailable(floorCard(floorRow('a', { session_id: null, state: 'offline', state_since: null }), NOW))).toBe(false);
  });

  it('colours its stripe by a warning before its state', () => {
    expect(stripeTone(floorCard(floorRow('a', { state: 'break', state_since: ago(40) }), NOW))).toBe('risk');
    expect(stripeTone(floorCard(floorRow('a', { connected: false }), NOW))).toBe('lost');
    expect(stripeTone(floorCard(floorRow('a'), NOW))).toBe('available');
  });

  it('starts Listen with what a listen reads, and nothing the floor does not carry', () => {
    const call = liveCallOf(floorRow('a', { agent_name: 'Asha K', campaign_name: 'Q4', state: 'on_call', call: CALL() }))!;
    expect(call).toEqual({
      call_id: 'call-1',
      origin: 'campaign',
      correlation_id: 'att-1',
      campaign_id: 'c1',
      campaign_name: 'Q4',
      agent_user_id: 'a',
      agent_name: 'Asha K',
      customer_name: 'Ramesh Goud',
      connected_at: call.connected_at,
      listenable: true,
      not_listenable_reason: null,
    });
    // No number on the floor (LF3): the listening bar names the customer instead.
    expect(listenTargetFor(call, 0)).toMatchObject({ callId: 'call-1', campaignLabel: 'Q4', agentName: 'Asha K', customerMasked: 'Ramesh Goud' });
    expect(liveCallOf(floorRow('a'))).toBeNull();
    // With no listener list, a full call's copy needs no count, on the card and on a refused start.
    const full = liveCallOf(floorRow('a', { state: 'on_call', call: CALL({ listenable: false, not_listenable_reason: 'listen_limit_call' }) }))!;
    expect(notListenableCopy(full.not_listenable_reason, full.listeners?.length)).toBe('This call has reached its listening limit');
    expect(listenRefusalMessage({ status: 409, code: 'listen_limit_call' }, full.listeners?.length)).toBe('That call has reached its listening limit.');
  });
});

describe('a row read again (sameFloorRow)', () => {
  it('is the same when every field and the call’s fields are, whatever the objects', () => {
    const row = floorRow('a', { state: 'on_call', call: CALL() });
    expect(sameFloorRow(row, structuredClone(row))).toBe(true);
    expect(sameFloorRow(floorRow('a'), structuredClone(floorRow('a')))).toBe(true);
    expect(sameFloorRow(row, { ...row, calls_today: row.calls_today + 1 })).toBe(false);
    expect(sameFloorRow(row, { ...row, call: { ...row.call!, listenable: false } })).toBe(false);
    expect(sameFloorRow(row, { ...row, call: null })).toBe(false);
    expect(sameFloorRow({ ...row, call: null }, { ...row, call: null })).toBe(true);
  });

  it('compares Need help field by field too, so an open request alone renders no card again (LF4)', () => {
    const row = floorRow('a', { state: 'on_call', call: CALL(), help: HELP() });
    expect(sameFloorRow(row, structuredClone(row))).toBe(true);
    expect(sameFloorRow(row, { ...row, help: null })).toBe(false);
    expect(sameFloorRow({ ...row, help: null }, row)).toBe(false);
    expect(sameFloorRow(row, { ...row, help: { ...row.help!, raised_at: ago(4) } })).toBe(false);
    expect(sameFloorRow(row, { ...row, help: { ...row.help!, call_id: null } })).toBe(false);
  });
});

describe('Need help, in Needs you now (LF4, LF28)', () => {
  const campaigns = [campaign('c1', 'running', 'Q4 collections')];

  it('is a danger row ranked first, naming the agent, how long ago and what they were on, with no “Got it”', () => {
    const cards = rankFloorCards([
      floorRow('r', { agent_name: 'Ravi Kumar', state: 'on_call', call: CALL(), help: HELP(ago(2.5)) }),
      floorRow('d', { agent_name: 'Divya S', state: 'wrapup', help: HELP(ago(0.5), null) }),
      floorRow('x'),
    ], NOW);
    const items = helpItems(cards, campaigns, NOW);
    expect(items.map((i) => i.title)).toEqual(['Ravi Kumar pressed Need help 2 min ago', 'Divya S pressed Need help under a minute ago']);
    const [ravi, divya] = items;
    expect(ravi).toMatchObject({
      id: 'help:r',
      tone: 'danger',
      detail: 'on a call with Ramesh Goud',
      campaign: { id: 'c1', name: 'Q4 collections' },
      ackable: false,
      kind: `help@${ago(2.5)}`,
      agent: { sessionId: 's-r', name: 'Ravi Kumar' },
    });
    // Listen starts on the call as the card's does; no number.
    expect(ravi!.agent!.call).toMatchObject({ call_id: 'call-1', customer_name: 'Ramesh Goud' });
    expect(ravi!.agent!.reminder).toBeUndefined();
    expect(divya).toMatchObject({ detail: 'after the call', agent: { call: null } });
    expect(homeRank(ravi!)).toBe('help');
    // Above what stopped a campaign, and never on the sidebar badge.
    const stop = { ...ravi!, id: 'stop', kind: 'stall:dnc_unavailable' };
    expect(sortByRank([stop, ravi!]).map((i) => i.id)).toEqual(['help:r', 'stop']);
    expect(homeBadgeCount([ravi!])).toBe(0);
  });

  it('says what the agent was doing when they asked, from the request’s own state (BE-9)', () => {
    const asked = (state: AgencyFloorAgent['state'], over: Partial<AgencyFloorAgent> = {}) => {
      const [card] = rankFloorCards([floorRow('r', { help: { ...HELP(ago(1), null), state_at_raise: state }, ...over })], NOW);
      return { row: helpItems([card!], campaigns, NOW)[0]!.detail, card: helpDetail(card!) };
    };
    expect(asked('available')).toEqual({ row: 'while waiting for a call', card: 'while waiting for a call' });
    expect(asked('break', { state: 'break', break_reason: 'tea', break_label: 'Tea' }).row).toBe('on a break');
    expect(asked('break', { state: 'break', break_reason: 'soft_phone' }).row).toBe('on the soft phone');
    expect(asked('wrapup', { state: 'wrapup' }).row).toBe('after the call');
    expect(asked('reserved').row).toBe('as a call was connecting');
    expect(asked('offline', { state: 'offline' }).row).toBe('before starting calls');
    expect(asked('on_call', { state: 'on_call', call: CALL() }).row).toBe('on a call with Ramesh Goud');
    // Raised on a call that has ended since: still a call, its customer gone from the row.
    expect(asked('on_call', { state: 'wrapup' }).row).toBe('on a call');
    // Raised while Ready, and a call connected since: what they were doing when they asked.
    expect(asked('available', { state: 'on_call', call: CALL() }).row).toBe('while waiting for a call');
    // An older server sends no state: what the row shows now, as before.
    const [old] = rankFloorCards([floorRow('r', { state: 'available', help: HELP(ago(1), null) })], NOW);
    expect(helpDetail(old!)).toBe('on the floor');
  });

  it('is none while the flag is off (the server sends help: null), nor for a row with no session', () => {
    const cards = rankFloorCards([floorRow('r', { state: 'on_call', call: CALL(), help: null }), floorRow('o', { session_id: null, help: HELP() })], NOW);
    expect(helpItems(cards, campaigns, NOW)).toEqual([]);
  });

  it('is a new row for a request raised again, and stale while the floor is', () => {
    const first = helpItems(rankFloorCards([floorRow('r', { help: HELP(ago(3)) })], NOW), campaigns, NOW)[0]!;
    const again = helpItems(rankFloorCards([floorRow('r', { help: HELP(ago(1)) })], NOW), campaigns, NOW, true)[0]!;
    expect(again.kind).not.toBe(first.kind);
    expect(again.stale).toBe(true);
  });

  it('turns the card red (the danger stripe), over any warning', () => {
    const [card] = rankFloorCards([floorRow('w', { state: 'wrapup', state_since: ago(10), wrapup_window_seconds: 30, help: HELP() })], NOW);
    expect(card!.risk).toBe('wrapup_overrun');
    expect(stripeTone(card!)).toBe('help');
  });
});

describe('a dropped screen (BE-11)', () => {
  const campaigns = [campaign('c1', 'running', 'Q4 collections')];
  const down = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

  it('hands the drawer since when the screen has been down', () => {
    expect(supervisorAgentOf(floorRow('r', { connected: false, disconnected_since: down(90) })).disconnected_since).toBe(down(90));
    expect(supervisorAgentOf(floorRow('r')).disconnected_since).toBeNull();
  });

  it('says for how long, in words, from disconnected_since', () => {
    expect(disconnectedWords(down(150), NOW)).toBe('Disconnected for 2 min');
    expect(disconnectedWords(down(25), NOW)).toBe('Disconnected for under a minute');
    // Since when is not known (an older server, or after a restart): no time rather than a wrong one.
    expect(disconnectedWords(null, NOW)).toBe('Disconnected');
    expect(disconnectedWords(undefined, NOW)).toBe('Disconnected');
    expect(disconnectedFor('not a time', NOW)).toBeNull();
  });

  it('is a Needs you now row for a working agent down past the alert’s 20 s, as the banner would list it', () => {
    const cards = rankFloorCards([
      floorRow('r', { agent_name: 'Ravi Kumar', state: 'on_call', call: CALL(), connected: false, disconnected_since: down(130) }),
      floorRow('a', { agent_name: 'Asha', connected: false, disconnected_since: down(25) }),
      // A blip the reconnect ladder may still win: not yet.
      floorRow('b', { connected: false, disconnected_since: down(19) }),
      // Not working, or since when unknown, or the read could not tell: never.
      floorRow('c', { state: 'break', break_reason: 'tea', connected: false, disconnected_since: down(300) }),
      floorRow('d', { state: 'offline', connected: false, disconnected_since: down(300) }),
      floorRow('e', { connected: false, disconnected_since: null }),
      floorRow('f', { connected: null }),
      floorRow('g', { connected: false, disconnected_since: down(300), session_id: null }),
    ], NOW);
    const items = disconnectedItems(cards, campaigns, NOW);
    expect(items.map((i) => i.id)).toEqual(['disconnected:r', 'disconnected:a']);
    const [ravi, asha] = items;
    expect(ravi).toMatchObject({
      tone: 'danger',
      title: 'Ravi Kumar is disconnected for 2 min',
      detail: 'Lost the connection on a call with Ramesh Goud.',
      campaign: { id: 'c1', name: 'Q4 collections' },
      kind: `disconnected@${down(130)}`,
      ackable: false,
    });
    expect(ravi!.agent).toBeUndefined();
    expect(asha).toMatchObject({ title: 'Asha is disconnected for under a minute', detail: 'Lost the connection while waiting for a call.' });
    // Ranked below what stopped a campaign, above a break; never on the sidebar badge.
    expect(homeRank(ravi!)).toBe('disconnected');
    const stop = { ...ravi!, id: 'stop', kind: 'stall:dnc_unavailable' };
    const brk = { ...ravi!, id: 'brk', tone: 'warning' as const, kind: 'break-overrun@x' };
    expect(sortByRank([brk, ravi!, stop]).map((i) => i.id)).toEqual(['stop', 'disconnected:r', 'brk']);
    expect(homeBadgeCount([ravi!])).toBe(0);
    expect(disconnectedItems(cards, campaigns, NOW, true)[0]!.stale).toBe(true);
  });
});

describe('breaks over the limit, in Needs you now', () => {
  const campaigns = [campaign('c1', 'running', 'Q4 collections')];

  it('is a warning ranked as a break overrun, carrying Send reminder’s agent and words, left off the badge', () => {
    const cards = rankFloorCards([floorRow('p', { agent_name: 'Priya M', state: 'break', break_label: 'Tea', state_since: ago(42) }), floorRow('q', { state: 'break', state_since: ago(29) })], NOW);
    const [item, ...rest] = breakOverrunItems(cards, campaigns);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      id: 'break-overrun:p',
      tone: 'warning',
      title: 'Priya M on Tea for 42 min',
      detail: 'It has no limit of its own, so it is flagged after 30 min.',
      campaign: { id: 'c1', name: 'Q4 collections' },
      to: '/agency/campaigns/c1/agents',
      ackable: true,
      // How long the break has run, in seconds; a "Got it" holds for 15 minutes more of it.
      count: 42 * 60,
      worseBy: 15 * 60,
      agent: {
        sessionId: 's-p',
        name: 'Priya M',
        reminder: 'Hi, your Tea break has gone past 30 minutes. Please come back to your station when you can. Thank you!',
      },
    });
    expect(item).not.toHaveProperty('comingSoon');
    expect(homeRank(item!)).toBe('break-overrun');
    expect(homeBadgeCount([item!])).toBe(0);
  });

  it('follows the break reason’s own limit (LF6), naming it, and the 30-minute rule without one', () => {
    const tea = (minutes: number, limit: number | null) => floorRow('p', {
      agent_name: 'Priya M', state: 'break', break_reason: 'tea', break_label: 'Tea', break_limit_minutes: limit, state_since: ago(minutes),
    });
    // Tea's 15 minutes: over at 16, not at 14.
    const [over] = breakOverrunItems(rankFloorCards([tea(16, 15)], NOW), campaigns);
    expect(over).toMatchObject({ title: 'Priya M on Tea for 16 min', detail: 'The limit for Tea is 15 min.' });
    expect(over!.agent!.reminder).toBe('Hi, your Tea break (15 minutes) is over. Please come back to your station when you can. Thank you!');
    expect(breakOverrunItems(rankFloorCards([tea(14, 15)], NOW), campaigns)).toEqual([]);
    // No limit of its own: the floor's 30 minutes, as before.
    expect(breakOverrunItems(rankFloorCards([tea(16, null)], NOW), campaigns)).toEqual([]);
    expect(breakOverrunItems(rankFloorCards([tea(31, null)], NOW), campaigns)).toHaveLength(1);
    // A floor read from before Phase 3 sends no field at all: the 30-minute rule.
    const { break_limit_minutes: _gone, ...older } = tea(16, 15);
    expect(breakOverrunItems(rankFloorCards([older as AgencyFloorAgent], NOW), campaigns)).toEqual([]);
    expect(breakOverrunDetail(null, 45)).toBe('The limit for this break is 45 min.');
  });

  it('never flags the soft phone, whatever limit a row carried', () => {
    const softphone = floorRow('s', { state: 'break', break_reason: 'soft_phone', break_label: 'Soft phone', break_limit_minutes: 1, state_since: ago(90) });
    expect(rankFloorCards([softphone], NOW)[0]!.risk).toBe('none');
    expect(breakOverrunItems(rankFloorCards([softphone], NOW), campaigns)).toEqual([]);
  });

  it('sits after what stopped a campaign and before late callbacks (LF9)', () => {
    const [brk] = breakOverrunItems(rankFloorCards([floorRow('p', { state: 'break', state_since: ago(42) })], NOW), campaigns);
    const late = { ...brk!, id: 'late', kind: 'callbacks-overdue', tone: 'danger' as const };
    const stop = { ...brk!, id: 'stop', kind: 'stall:dnc_unavailable', tone: 'danger' as const };
    const sorted = sortByRank([late, brk!, stop]);
    expect(sorted.map((i) => i.id)).toEqual(['stop', 'break-overrun:p', 'late']);
  });

  it('is stale while the floor is, and counts on against the clock without changing its id or kind', () => {
    const row = floorRow('p', { state: 'break', state_since: ago(42) });
    const now = breakOverrunItems(rankFloorCards([row], NOW), campaigns)[0]!;
    const later = breakOverrunItems(rankFloorCards([row], NOW + 5 * 60_000), campaigns, true)[0]!;
    expect(now.stale).toBe(false);
    expect(later).toMatchObject({ stale: true, id: now.id, kind: now.kind });
    expect(later.title).toMatch(/for 47 min$/);
  });

  it('comes back 15 minutes after “Got it”, whenever in the quarter-hour it was pressed, and a new break is a new row', () => {
    // A break that started 44 minutes before NOW, read `later` minutes on: a minute short of 45.
    const since = ago(44);
    const at = (later: number, start = since) =>
      breakOverrunItems(rankFloorCards([floorRow('p', { state: 'break', state_since: start })], NOW + later * 60_000), campaigns)[0]!;
    const put = ackOf(at(0));
    // 45 minutes in is no reason to bring it back: only 15 more minutes since the "Got it" is.
    expect(stillAcknowledged(at(1), put)).toBe(true);
    expect(stillAcknowledged(at(14.5), put)).toBe(true);
    expect(stillAcknowledged(at(15), put)).toBe(false);
    // Put aside again then, it holds for another 15.
    const again = ackOf(at(15));
    expect(stillAcknowledged(at(29.5), again)).toBe(true);
    expect(stillAcknowledged(at(30), again)).toBe(false);
    // Ended and a new one started: a new kind.
    expect(stillAcknowledged(at(0, ago(41)), put)).toBe(false);
  });

});

describe('the tiles from the floor and the promises', () => {
  const floor: AgencyFloorResponse = {
    agents: [floorRow('a'), floorRow('b', { campaign_id: 'c2' }), floorRow('c', { session_id: null, state: 'offline', state_since: null, campaign_id: null })],
    totals: { on_shift: 2, assigned: 7 },
    as_of: new Date(NOW).toISOString(),
  };

  it('takes Agents working from the floor’s totals, or one campaign’s rows of its staffed agents', () => {
    expect(floorAgentsWorking(floor, floor.agents, null, [])).toEqual({ working: 2, assigned: 7 });
    const reads = [{ campaign: campaign('c1'), stats: null, staffing: { staffed: 4, online: 1 }, allocation: null, today: null, settings: null, stale: false }];
    expect(floorAgentsWorking(floor, floorRowsFor(floor.agents, 'c1'), 'c1', reads)).toEqual({ working: 1, assigned: 4 });
    expect(floorAgentsWorking(floor, floorRowsFor(floor.agents, 'c2'), 'c2', reads)).toEqual({ working: 1, assigned: null });
  });

  const summary = (over: Partial<AgencyPromisesSummaryResponse> = {}): AgencyPromisesSummaryResponse => ({
    campaigns: [
      { campaign_id: 'c1', promises: 70, with_amount: 60, amount_total: '200000.10' },
      { campaign_id: 'c2', promises: 25, with_amount: 25, amount_total: '40000.95' },
      { campaign_id: null, promises: 1, with_amount: 0, amount_total: '0.00' },
    ],
    promise_campaign_ids: ['c1', 'c2'],
    from: '', to: '',
    ...over,
  });

  it('is Will pay only while a shown campaign records promises, summing every row exactly', () => {
    expect(willPayFor(summary(), null)).toEqual({ promises: 96, withAmount: 85, amount: '240001.05' });
    expect(willPayLine(willPayFor(summary(), null)!)).toBe('2.4 lakh promised today');
    expect(willPayFor(summary(), 'c2')).toEqual({ promises: 25, withAmount: 25, amount: '40000.95' });
    expect(willPayFor(summary({ promise_campaign_ids: ['c1'] }), 'c2')).toBeNull();
    expect(willPayFor(summary({ promise_campaign_ids: [] }), null)).toBeNull();
    expect(willPayLine({ promises: 3, withAmount: 0, amount: '0.00' })).toBe('No amounts recorded');
    expect(willPayByCampaign(summary({ promise_campaign_ids: ['c1', 'c3'] }))).toEqual({ c1: 70, c3: 0 });
  });
});

describe('amounts, exactly and in lakh and crore', () => {
  it('sums decimal strings without a float', () => {
    expect(sumPromiseAmounts(['0.10', '0.20'])).toBe('0.30');
    expect(sumPromiseAmounts(['9007199254740993.01', '1.00'])).toBe('9007199254740994.01');
    expect(sumPromiseAmounts(['12', '3.5', 'n/a'])).toBe('15.50');
    expect(sumPromiseAmounts([])).toBe('0.00');
  });

  it('says a total as an Indian reader does, with no currency', () => {
    expect(formatAmountShort('45000.00')).toBe('45,000');
    expect(formatAmountShort('99999.50')).toBe('99,999.50');
    expect(formatAmountShort('100000.00')).toBe('1 lakh');
    expect(formatAmountShort('240000.00')).toBe('2.4 lakh');
    expect(formatAmountShort('245000.00')).toBe('2.5 lakh');
    expect(formatAmountShort('9996000.00')).toBe('1 crore');
    expect(formatAmountShort('123456789.00')).toBe('12.3 crore');
    expect(formatAmountShort('123456789012.00')).toBe('12,345.7 crore');
    expect(formatAmountShort('abc')).toBe('abc');
  });
});

describe('who paused a campaign', () => {
  const fmt = (iso: string) => iso.slice(11, 16);
  const read = (status: 'paused' | 'stopping' | 'running', change: Parameters<typeof statusChangeLine>[0]['statusChanged']) => ({ campaign: campaign('c1', status), statusChanged: change });

  it('names who and when, the guardrail’s own pause as automatic, and nothing while running', () => {
    expect(statusChangeLine(read('paused', { at: '2026-11-18T11:03:00Z', by_user_id: 'u', by_name: 'Anitha', automatic: false }), fmt)).toBe('Paused by Anitha at 11:03');
    expect(statusChangeLine(read('paused', { at: '2026-11-18T11:03:00Z', by_user_id: null, by_name: null, automatic: true }), fmt)).toBe('Paused automatically at 11:03');
    expect(statusChangeLine(read('paused', { at: '2026-11-18T11:03:00Z', by_user_id: null, by_name: null, automatic: false }), fmt)).toBe('Paused at 11:03');
    expect(statusChangeLine(read('stopping', { at: '2026-11-18T11:03:00Z', by_user_id: 'u', by_name: 'Anitha', automatic: false }), fmt)).toBe('Stopping, by Anitha at 11:03');
    expect(statusChangeLine(read('stopping', { at: null, by_user_id: null, by_name: null, automatic: false }), fmt)).toBeNull();
    expect(statusChangeLine(read('running', { at: '2026-11-18T11:03:00Z', by_user_id: 'u', by_name: 'Anitha', automatic: false }), fmt)).toBeNull();
    expect(statusChangeLine(read('paused', null), fmt)).toBeNull();
  });
});
