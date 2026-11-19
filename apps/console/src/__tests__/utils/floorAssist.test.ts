import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import {
  MESSAGE_MAX_CHARS,
  helpAgo,
  helpKey,
  helpKeys,
  messageFits,
  messageLength,
  messageRefusal,
  newHelpKeys,
  readHelpChimeOn,
  reminderText,
  writeHelpChimeOn,
} from '../../utils/agency/floorAssist';
import { playHelpChime, setHelpChimeContextFactoryForTests, unlockHelpChime, type ChimeAudioContext } from '../../utils/agency/helpChime';
import {
  LATE_CALLBACKS_POOL_COPY,
  lateCallbacksQuestion,
  lateCallbacksReceivers,
  lateCallbacksResultText,
  offersHandOff,
} from '../../utils/agency/lateCallbacks';
import {
  CALLBACK_SOURCE_LABELS,
  appendCallbackRows,
  callbackContactHref,
  callbackCustomer,
  callbackDueText,
  callbackOwner,
  callbacksDueOf,
  callbacksEmptyText,
  callbacksErrorText,
} from '../../utils/agency/accountCallbacks';
import { CALLBACKS_ERROR, CALLBACKS_REFUSED } from '../../utils/agency/liveFloor';

/**
 * The Live floor's Phase 3 rules (LF4–LF7, LF28–LF33): messages and their refusals, Send reminder's
 * words, telling Need help requests apart for the chime, the chime's setting and its silence where
 * the browser refuses sound, the hand-off's offer and words, and the Callbacks page's words.
 */

const refused = (status: number, code?: string) => new ApiError(status, code ? { error: 'x', code, message: 'server words' } : { error: 'x' });

describe('a message (LF5, LF17)', () => {
  it('counts what the reader sees, trimmed: an emoji is one character', () => {
    expect(messageLength('  hi  ')).toBe(2);
    expect(messageLength('👍🏽')).toBe(2);
    expect(messageLength('నమస్తే')).toBe([...'నమస్తే'].length);
    expect(messageFits('   ')).toBe(false);
    expect(messageFits('a')).toBe(true);
    expect(messageFits('a'.repeat(MESSAGE_MAX_CHARS))).toBe(true);
    expect(messageFits(` ${'a'.repeat(MESSAGE_MAX_CHARS)} `)).toBe(true);
    expect(messageFits('a'.repeat(MESSAGE_MAX_CHARS + 1))).toBe(false);
    expect(MESSAGE_MAX_CHARS).toBe(500);
  });

  it('is refused in the console’s words, naming the agent', () => {
    expect(messageRefusal(refused(409, 'agent_not_live'), 'Priya')).toBe('Priya isn’t on a station that can receive messages right now.');
    expect(messageRefusal(refused(400, 'message_invalid'), 'Priya')).toBe('Write a message of 1 to 500 characters.');
    expect(messageRefusal(refused(403, 'floor_assist_disabled'), 'Priya')).toBe('Messages to agents are turned off for this account.');
    expect(messageRefusal(refused(404), 'Priya')).toBe('Priya’s session has ended.');
    expect(messageRefusal(new Error('network down'), 'Priya')).toBe('network down');
    expect(messageRefusal(null, 'Priya')).toBe('Your message wasn’t sent to Priya. Try again.');
  });

  it('prefills Send reminder with friendly words naming the break and its length', () => {
    expect(reminderText('Tea', 15)).toBe('Hi, your Tea break (15 minutes) is over. Please come back to your station when you can. Thank you!');
    expect(reminderText('Lunch', null)).toBe('Hi, your Lunch break has gone past 30 minutes. Please come back to your station when you can. Thank you!');
    expect(reminderText(null, undefined)).toBe('Hi, your break has gone past 30 minutes. Please come back to your station when you can. Thank you!');
  });
});

describe('telling Need help requests apart (LF31)', () => {
  const at = '2026-11-19T09:00:00.000Z';

  it('keys a request by its agent and when it was raised', () => {
    expect(helpKey({ agent_user_id: 'r', help: { raised_at: at, call_id: null } })).toBe(`r@${at}`);
    expect(helpKey({ agent_user_id: 'r', help: null })).toBeNull();
    expect(helpKeys([{ agent_user_id: 'a', help: null }, { agent_user_id: 'r', help: { raised_at: at, call_id: 'c' } }])).toEqual([`r@${at}`]);
  });

  it('is new only after the first read, and only when not seen before', () => {
    expect(newHelpKeys(null, ['r@1'])).toEqual([]);
    expect(newHelpKeys(new Set(['r@1']), ['r@1'])).toEqual([]);
    expect(newHelpKeys(new Set(['r@1']), ['r@1', 'p@2'])).toEqual(['p@2']);
    // Raised again after an answer: a new request.
    expect(newHelpKeys(new Set(['r@1']), ['r@3'])).toEqual(['r@3']);
  });

  it('says how long ago on the floor’s clock', () => {
    const now = Date.parse(at);
    expect(helpAgo(new Date(now - 42_000).toISOString(), now)).toBe('under a minute ago');
    expect(helpAgo(new Date(now - 3 * 60_000 - 5_000).toISOString(), now)).toBe('3 min ago');
    // A viewer's clock behind the anchor never says "-1 min".
    expect(helpAgo(new Date(now + 9_000).toISOString(), now)).toBe('under a minute ago');
    expect(helpAgo('not a time', now)).toBe('');
  });
});

describe('the chime’s setting (LF4: on by default, per browser)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('is on until turned off here, and kept', () => {
    expect(readHelpChimeOn()).toBe(true);
    writeHelpChimeOn(false);
    expect(readHelpChimeOn()).toBe(false);
    writeHelpChimeOn(true);
    expect(readHelpChimeOn()).toBe(true);
  });

  it('reads as on, and writes nothing, where storage throws', () => {
    // Blocked site data: reaching `localStorage` at all throws.
    const blocked = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readHelpChimeOn()).toBe(true);
    expect(() => writeHelpChimeOn(false)).not.toThrow();
    expect(() => writeHelpChimeOn(true)).not.toThrow();
    // It did try: a not.toThrow on storage never touched would pass whatever the code does.
    expect(blocked).toHaveBeenCalledTimes(3);
  });
});

describe('the chime’s sound (fails silently)', () => {
  function context(state: AudioContextState, resume: () => Promise<void> = () => Promise.resolve()) {
    const started: number[] = [];
    const param = { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
    const ctx = {
      state,
      currentTime: 10,
      destination: {} as AudioNode,
      createOscillator: () => ({ type: 'sine', frequency: { value: 0 }, connect: vi.fn(), start: (t: number) => started.push(t), stop: vi.fn() }) as unknown as OscillatorNode,
      createGain: () => ({ gain: param, connect: vi.fn() }) as unknown as GainNode,
      resume: vi.fn(resume),
    } satisfies ChimeAudioContext;
    return { ctx, started };
  }

  afterEach(() => setHelpChimeContextFactoryForTests(() => null));

  it('plays two notes on a running context', () => {
    const { ctx, started } = context('running');
    setHelpChimeContextFactoryForTests(() => ctx);
    playHelpChime();
    expect(started).toHaveLength(2);
  });

  it('plays nothing, and throws nothing, where the browser refuses sound before a gesture', async () => {
    const { ctx, started } = context('suspended', () => Promise.reject(new DOMException('not allowed', 'NotAllowedError')));
    setHelpChimeContextFactoryForTests(() => ctx);
    expect(() => playHelpChime()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.resume).toHaveBeenCalled();
    expect(started).toHaveLength(0);
    expect(() => unlockHelpChime()).not.toThrow();
  });

  it('keeps at most one play waiting on a suspended context: never a stacked burst', async () => {
    let unlock!: () => void;
    const holder: { state: AudioContextState } = { state: 'suspended' };
    const { ctx, started } = context('suspended', () => new Promise<void>((resolve) => {
      unlock = () => {
        holder.state = 'running';
        resolve();
      };
    }));
    Object.defineProperty(ctx, 'state', { get: () => holder.state });
    setHelpChimeContextFactoryForTests(() => ctx);
    playHelpChime();
    playHelpChime();
    playHelpChime();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    unlock();
    await Promise.resolve();
    await Promise.resolve();
    // One chime (two notes), not three on top of each other.
    expect(started).toHaveLength(2);
    // Running now: each new request plays straight away.
    playHelpChime();
    expect(started).toHaveLength(4);
  });

  it('asks again after a refused resume', async () => {
    const { ctx } = context('suspended', () => Promise.reject(new DOMException('not allowed', 'NotAllowedError')));
    setHelpChimeContextFactoryForTests(() => ctx);
    playHelpChime();
    await Promise.resolve();
    await Promise.resolve();
    playHelpChime();
    expect(ctx.resume).toHaveBeenCalledTimes(2);
  });

  it('throws nothing with no audio at all, or a constructor that throws', () => {
    setHelpChimeContextFactoryForTests(() => null);
    expect(() => playHelpChime()).not.toThrow();
    setHelpChimeContextFactoryForTests(() => {
      throw new Error('no audio');
    });
    expect(() => playHelpChime()).not.toThrow();
    expect(() => unlockHelpChime()).not.toThrow();
  });
});

describe('give late callbacks to free agents (LF7, LF30)', () => {
  it('is offered on strict and preferred with assignment on, never on pool or an unknown mode', () => {
    expect(offersHandOff(true, 'strict')).toBe(true);
    expect(offersHandOff(true, 'preferred')).toBe(true);
    expect(offersHandOff(true, 'pool')).toBe(false);
    expect(offersHandOff(true, undefined)).toBe(false);
    expect(offersHandOff(false, 'strict')).toBe(false);
  });

  it('asks with the counts, names the receivers, and says why nothing would move', () => {
    const names: Record<string, string> = { a: 'Arjun T', d: 'Divya S' };
    const name = (id: string) => names[id] ?? id;
    expect(lateCallbacksQuestion({ moving: 4, live_agent_user_ids: ['a', 'd'] })).toBe('Give 4 late callbacks to 2 free agents?');
    expect(lateCallbacksQuestion({ moving: 1, live_agent_user_ids: ['a'] })).toBe('Give 1 late callback to 1 free agent?');
    expect(lateCallbacksQuestion({ moving: 0, live_agent_user_ids: [] })).toMatch(/^No agent is free/);
    expect(lateCallbacksQuestion({ moving: 0, live_agent_user_ids: ['a'] })).toMatch(/^No late callback is waiting/);
    expect(lateCallbacksReceivers({ live_agent_user_ids: ['d', 'a'] }, name)).toEqual(['Divya S', 'Arjun T']);
    expect(lateCallbacksResultText({
      moved: 4,
      per_agent: [{ agent_user_id: 'a', receiving: 2, giving: 0 }, { agent_user_id: 'n', receiving: 0, giving: 4 }, { agent_user_id: 'd', receiving: 2, giving: 0 }],
    }, name)).toBe('Gave 4 late callbacks: Arjun T 2, Divya S 2.');
    expect(lateCallbacksResultText({ moved: 0, per_agent: [] }, name)).toMatch(/^Nothing moved/);
    expect(LATE_CALLBACKS_POOL_COPY).toMatch(/shares one queue/);
  });
});

describe('the Callbacks page’s paging (LF32)', () => {
  it('appends a further page with each callback once, by campaign and contact', () => {
    const r = (campaign: string, contact: string) => ({ campaign_id: campaign, contact_id: contact });
    const held = [r('c1', 'k1'), r('c1', 'k2')];
    expect(appendCallbackRows(held, [r('c1', 'k2'), r('c2', 'k2'), r('c1', 'k3'), r('c1', 'k3')])).toEqual([
      r('c1', 'k1'), r('c1', 'k2'), r('c2', 'k2'), r('c1', 'k3'),
    ]);
    expect(appendCallbackRows(held, [])).toEqual(held);
  });
});

describe('the Callbacks page’s words (LF32)', () => {
  const row = {
    contact_id: 'k1',
    campaign_id: 'c1',
    campaign_name: 'Gold loan',
    assignment_mode: 'strict' as const,
    customer_name: 'Ramesh Goud',
    due_at: '2026-11-19T09:30:00.000Z',
    owner: { user_id: 'n', name: 'Naveen G', live: false },
    source: 'outcome' as const,
  };

  it('reads the tab from the URL, overdue unless it says today', () => {
    expect(callbacksDueOf(null)).toBe('overdue');
    expect(callbacksDueOf('today')).toBe('today');
    expect(callbacksDueOf('tomorrow')).toBe('overdue');
  });

  it('names the customer, never a number, the owner or the shared queue, and the source', () => {
    expect(callbackCustomer(row)).toBe('Ramesh Goud');
    expect(callbackCustomer({ customer_name: '  ' })).toBe('No name on file');
    expect(callbackCustomer({ customer_name: null })).toBe('No name on file');
    expect(callbackOwner(row)).toEqual({ name: 'Naveen G', live: false });
    expect(callbackOwner({ owner: { user_id: 'x', name: null, live: true } })).toEqual({ name: 'Former member', live: true });
    expect(callbackOwner({ owner: null })).toEqual({ name: 'Shared queue', live: null });
    expect(CALLBACK_SOURCE_LABELS).toEqual({ outcome: 'Booked on a call', inbound: 'Missed inbound call' });
  });

  it('says when it is due in the reader’s zone, the date only off today', () => {
    expect(callbackDueText(row.due_at, new Date('2026-11-19T12:00:00Z'))).toMatch(/^\d{2}:\d{2} [ap]m$/);
    expect(callbackDueText(row.due_at, new Date('2026-11-21T12:00:00Z'))).toMatch(/19 Nov/);
  });

  it('links the contact in its campaign, and says what is empty without a wider all-clear', () => {
    expect(callbackContactHref(row)).toBe('/agency/campaigns/c1/contacts/k1');
    expect(callbacksEmptyText('overdue', null)).toBe('No callback is overdue right now.');
    expect(callbacksEmptyText('today', { name: 'Gold loan' })).toBe('No more callbacks are due today on Gold loan.');
    // A campaign asked for whose name is not known here: still that campaign, never account-wide.
    expect(callbacksEmptyText('overdue', { name: null })).toBe('No callback is overdue in this campaign right now.');
    expect(callbacksEmptyText('today', { name: null })).toBe('No more callbacks are due today in this campaign.');
    expect(callbacksErrorText(refused(403))).toBe(CALLBACKS_REFUSED);
    expect(callbacksErrorText(new Error('x'))).toBe(CALLBACKS_ERROR);
  });
});
