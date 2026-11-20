import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Floor assist's service (`src/agency/floor-assist.ts`, LF4, LF5) over a faked repository: what each
 * Need help transition sends the station and writes to the audit log, once, for exactly the rows its
 * statement returned; the expired-first rule; messages (no station, delivered, refused by the
 * socket); the pure rules (the message text, the station's `ready.help`). The statements themselves
 * are pinned on Postgres (`test/integration/agency/floor-assist-repository.test.ts`) and the whole
 * path end to end (`floor-assist-e2e.test.ts`).
 */

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const metrics = vi.hoisted(() => ({ raised: vi.fn(), cleared: vi.fn(), message: vi.fn(), markFailed: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/agency', () => ({
  trackHelpRaised: metrics.raised, trackHelpCleared: metrics.cleared, trackSupervisorMessage: metrics.message,
  trackSupervisorMessageMarkFailed: metrics.markFailed,
}));

import {
  FloorAssistService,
  FLOOR_ASSIST_REFUSAL_MESSAGES,
  normaliseMessageText,
  senderNameForFrame,
  SENDER_NAME_MAX_CHARS,
  type FloorAssistDeps,
} from '../../../src/agency/floor-assist.js';
import { AGENCY_HELP_EXPIRY_MS, AGENCY_FLOOR_ASSIST_ERROR_CODES } from '@magick-agency/contracts/agency';

const SESSION = {
  id: '11111111-1111-4111-8111-111111111111', tenant_id: 't-1', account_id: 'a-1', campaign_id: 'c-1', agent_user_id: 'agent-1',
};
const RAISED = new Date('2026-11-19T10:00:00.000Z');
const ended = (over: Record<string, unknown> = {}) => ({
  session_id: SESSION.id, tenant_id: 't-1', account_id: 'a-1', campaign_id: 'c-1', agent_user_id: 'agent-1',
  raised_at: RAISED, call_id: 'call-1', ...over,
});

let deps: FloorAssistDeps & { frames: Array<[string, Record<string, unknown>]>; audits: Array<Record<string, unknown>> };
let repo: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  repo = {
    raise: vi.fn(async () => ({ raised: true, help: { session_id: SESSION.id, raised_at: RAISED, call_id: 'call-1', state: 'on_call' }, expired: null })),
    cancel: vi.fn(async () => ended({ expired: false })),
    answer: vi.fn(async () => ({ ...ended(), expired: false, answered_at: new Date(RAISED.getTime() + 42_000) })),
    endWithSession: vi.fn(async () => ended({ expired: false })),
    expireDue: vi.fn(async () => []),
    openForSession: vi.fn(async () => null),
    insertMessage: vi.fn(async () => ({ id: 'msg-1', sent_at: new Date('2026-11-19T10:01:00.000Z') })),
    markDelivered: vi.fn(async () => undefined),
  };
  const frames: Array<[string, Record<string, unknown>]> = [];
  const audits: Array<Record<string, unknown>> = [];
  deps = {
    repo: repo as never,
    frames,
    audits,
    send: vi.fn((sessionId: string, frame: unknown) => { frames.push([sessionId, frame as Record<string, unknown>]); return true; }),
    canReceive: vi.fn(() => true),
    names: vi.fn(async () => new Map([['sup-1', 'Anitha N']])),
    audit: vi.fn((entry) => { audits.push(entry as never); }),
  };
});

const service = () => new FloorAssistService(deps);
const events = () => deps.frames.map(([, f]) => f);

describe('raise', () => {
  it('raises once: the open request answered with the state it was raised in, one audit row by the agent, one metric; no frame (the HTTP answer says it)', async () => {
    const out = await service().raise(SESSION, 'call-1', 'on_call');
    expect(out).toEqual({ raised_at: RAISED.toISOString(), call_id: 'call-1', state_at_raise: 'on_call' });
    expect(repo['raise']).toHaveBeenCalledWith({
      sessionId: SESSION.id, tenantId: 't-1', accountId: 'a-1', callId: 'call-1', state: 'on_call', expiryMs: AGENCY_HELP_EXPIRY_MS,
    });
    expect(deps.audits).toEqual([expect.objectContaining({
      action: 'agency_session.help_raised', actor_type: 'human', user_id: 'agent-1', resource_type: 'agency_session',
      resource_id: SESSION.id, tenant_id: 't-1', account_id: 'a-1', campaign_id: 'c-1',
      details: { raised_at: RAISED.toISOString(), call_id: 'call-1', state: 'on_call', campaign_id: 'c-1' },
    })]);
    expect(metrics.raised).toHaveBeenCalledTimes(1);
    expect(metrics.raised).toHaveBeenCalledWith('on_call');
    expect(events()).toEqual([]);
  });

  it('BE-9: raised while Ready (no call), the state recorded; a request raised before the state was recorded has no state_at_raise', async () => {
    repo['raise']!.mockResolvedValue({ raised: true, help: { session_id: SESSION.id, raised_at: RAISED, call_id: null, state: 'available' }, expired: null });
    expect(await service().raise(SESSION, null, 'available')).toEqual({ raised_at: RAISED.toISOString(), call_id: null, state_at_raise: 'available' });
    expect(metrics.raised).toHaveBeenCalledWith('available');
    repo['raise']!.mockResolvedValue({ raised: false, help: { session_id: SESSION.id, raised_at: RAISED, call_id: null, state: null }, expired: null });
    expect(await service().raise(SESSION, null, 'break')).toEqual({ raised_at: RAISED.toISOString(), call_id: null });
  });

  it('raising again while one is open is idempotent: the open one answered, no audit row, no metric', async () => {
    repo['raise']!.mockResolvedValue({ raised: false, help: { session_id: SESSION.id, raised_at: RAISED, call_id: null, state: 'wrapup' }, expired: null });
    expect(await service().raise(SESSION, 'call-2', 'on_call')).toEqual({ raised_at: RAISED.toISOString(), call_id: null, state_at_raise: 'wrapup' });
    expect(deps.audits).toEqual([]);
    expect(metrics.raised).not.toHaveBeenCalled();
  });

  it('a request past its 15 minutes, expired by the raise\'s statement: help_cleared expired, audited by the system, before the new one\'s row', async () => {
    const old = new Date('2026-11-19T09:40:00.000Z');
    repo['raise']!.mockResolvedValue({
      raised: true, help: { session_id: SESSION.id, raised_at: RAISED, call_id: null }, expired: ended({ raised_at: old }),
    });
    await service().raise(SESSION, null, 'wrapup');
    expect(events()).toEqual([{ event: 'help_cleared', raised_at: old.toISOString(), reason: 'expired' }]);
    expect(deps.audits.map((a) => [a['action'], a['actor_type']])).toEqual([
      ['agency_session.help_expired', 'system'], ['agency_session.help_raised', 'human'],
    ]);
    expect(metrics.cleared).toHaveBeenCalledWith('expired');
  });

  it('a session that left meanwhile: no help, nothing written', async () => {
    repo['raise']!.mockResolvedValue({ raised: false, help: null, expired: null });
    expect(await service().raise(SESSION, null, 'available')).toBeNull();
    expect(deps.audits).toEqual([]);
  });
});

describe('every clearing path: the frames, one audit row, one metric', () => {
  it('cancel: help_cleared cancelled, audited by the agent', async () => {
    expect(await service().cancel(SESSION)).toBe(true);
    expect(events()).toEqual([{ event: 'help_cleared', raised_at: RAISED.toISOString(), reason: 'cancelled' }]);
    expect(deps.audits).toEqual([expect.objectContaining({
      action: 'agency_session.help_cancelled', actor_type: 'human', user_id: 'agent-1',
      details: { raised_at: RAISED.toISOString(), call_id: 'call-1', campaign_id: 'c-1' },
    })]);
    expect(metrics.cleared).toHaveBeenCalledWith('cancelled');
  });

  it('cancel with none open: nothing sent, nothing written', async () => {
    repo['cancel']!.mockResolvedValue(null);
    expect(await service().cancel(SESSION)).toBe(false);
    expect(events()).toEqual([]);
    expect(deps.audits).toEqual([]);
  });

  it('answered by a listen: help_answered (who, how) then help_cleared answered, audited by the supervisor, with the wait', async () => {
    expect(await service().answer({ sessionId: SESSION.id, tenantId: 't-1', byUserId: 'sup-1', how: 'listen' })).toBe(true);
    expect(repo['answer']).toHaveBeenCalledWith(SESSION.id, 't-1', 'sup-1', AGENCY_HELP_EXPIRY_MS);
    expect(events()).toEqual([
      { event: 'help_answered', raised_at: RAISED.toISOString(), by_name: 'Anitha N', how: 'listen' },
      { event: 'help_cleared', raised_at: RAISED.toISOString(), reason: 'answered' },
    ]);
    expect(deps.audits).toEqual([expect.objectContaining({
      action: 'agency_session.help_answered', actor_type: 'human', user_id: 'sup-1',
      details: { raised_at: RAISED.toISOString(), how: 'listen', answered_by: 'sup-1', call_id: 'call-1', campaign_id: 'c-1' },
    })]);
    expect(metrics.cleared).toHaveBeenCalledWith('answered', 42);
  });

  it('an answer with none open (already answered, cleared or expired) sends and writes nothing; a failing read never throws', async () => {
    repo['answer']!.mockResolvedValue(null);
    expect(await service().answer({ sessionId: SESSION.id, tenantId: 't-1', byUserId: 'sup-1', how: 'message' })).toBe(false);
    repo['answer']!.mockRejectedValue(new Error('db down'));
    expect(await service().answer({ sessionId: SESSION.id, tenantId: 't-1', byUserId: 'sup-1', how: 'message' })).toBe(false);
    expect(events()).toEqual([]);
    expect(deps.audits).toEqual([]);
  });

  it('a listen\'s answerer name, read here, is trimmed and cut as a message\'s from_name is; a blank one is null', async () => {
    const long = `  ${'Anitha '.repeat(60)}  `;
    (deps.names as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['sup-1', long]]));
    await service().answer({ sessionId: SESSION.id, tenantId: 't-1', byUserId: 'sup-1', how: 'listen' });
    const byName = events()[0]!['by_name'] as string;
    expect(byName).toBe(senderNameForFrame(long));
    expect([...byName].length).toBeLessThanOrEqual(SENDER_NAME_MAX_CHARS);
    expect(byName.startsWith('Anitha') && byName.endsWith('…')).toBe(true);
    (deps.names as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['sup-1', '  Anitha N  ']]));
    await service().answer({ sessionId: SESSION.id, tenantId: 't-1', byUserId: 'sup-1', how: 'listen' });
    (deps.names as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['sup-1', '   ']]));
    await service().answer({ sessionId: SESSION.id, tenantId: 't-1', byUserId: 'sup-1', how: 'listen' });
    expect(events().filter((f) => f['event'] === 'help_answered').map((f) => f['by_name']).slice(1)).toEqual(['Anitha N', null]);
  });

  it('an answerer whose name cannot be read is sent as null', async () => {
    (deps.names as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    await service().answer({ sessionId: SESSION.id, tenantId: 't-1', byUserId: 'sup-2', how: 'listen' });
    expect(events()[0]).toMatchObject({ event: 'help_answered', by_name: null });
  });

  it('the session ended: help_cleared session_ended, audited by the system; never throws', async () => {
    await service().endWithSession(SESSION.id);
    expect(events()).toEqual([{ event: 'help_cleared', raised_at: RAISED.toISOString(), reason: 'session_ended' }]);
    expect(deps.audits.map((a) => [a['action'], a['actor_type']])).toEqual([['agency_session.help_session_ended', 'system']]);
    repo['endWithSession']!.mockRejectedValue(new Error('db down'));
    await expect(service().endWithSession(SESSION.id)).resolves.toBeUndefined();
  });

  it('a cancel, an answer or the session ending that found the request past its 15 minutes: help_cleared expired, audited by the system, and nothing else', async () => {
    const s = service();
    const ways: Array<[string, () => Promise<unknown>]> = [
      ['cancel', () => s.cancel(SESSION)],
      ['answer', () => s.answer({ sessionId: SESSION.id, tenantId: 't-1', byUserId: 'sup-1', how: 'listen' })],
      ['endWithSession', () => s.endWithSession(SESSION.id)],
    ];
    for (const [method, run] of ways) {
      deps.frames.length = 0;
      deps.audits.length = 0;
      metrics.cleared.mockClear();
      repo[method]!.mockResolvedValueOnce(ended({ expired: true }));
      expect(await run(), method).toBe(method === 'endWithSession' ? undefined : false);
      expect(events(), method).toEqual([{ event: 'help_cleared', raised_at: RAISED.toISOString(), reason: 'expired' }]);
      expect(deps.audits.map((a) => [a['action'], a['actor_type']]), method).toEqual([['agency_session.help_expired', 'system']]);
      expect(metrics.cleared.mock.calls, method).toEqual([['expired']]);
    }
  });

  it('the sweep: each expired request once, help_cleared expired, audited by the system; a failing pass never throws', async () => {
    const other = ended({ session_id: '22222222-2222-4222-8222-222222222222', campaign_id: null, call_id: null });
    repo['expireDue']!.mockResolvedValueOnce([ended(), other]);
    expect(await service().sweep()).toBe(2);
    expect(repo['expireDue']).toHaveBeenCalledWith(AGENCY_HELP_EXPIRY_MS);
    expect(deps.frames.map(([id, f]) => [id, f['reason']])).toEqual([[SESSION.id, 'expired'], [other.session_id, 'expired']]);
    // A soft-phone session's row carries no campaign.
    expect(deps.audits[1]).not.toHaveProperty('campaign_id');
    expect(deps.audits[1]!['details']).toEqual({ raised_at: RAISED.toISOString() });
    repo['expireDue']!.mockRejectedValueOnce(new Error('db down'));
    expect(await service().sweep()).toBe(0);
  });

  it('a frame or an audit that throws never fails the transition', async () => {
    (deps.send as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('socket'); });
    (deps.audit as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('buffer'); });
    expect(await service().cancel(SESSION)).toBe(true);
  });

  it('startSweep runs the sweep on its timer, once armed; stopSweep disarms it', async () => {
    vi.useFakeTimers();
    try {
      const s = service();
      s.startSweep(1_000);
      s.startSweep(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(repo['expireDue']).toHaveBeenCalledTimes(3);
      await s.stopSweep();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(repo['expireDue']).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openHelp (the station\'s ready.help)', () => {
  it('reads the repository\'s open request with the service\'s expiry (the database clock), in the wire shape; null when none', async () => {
    repo['openForSession']!.mockResolvedValueOnce({ session_id: SESSION.id, raised_at: RAISED, call_id: 'call-1' });
    expect(await service().openHelp(SESSION)).toEqual({ raised_at: RAISED.toISOString(), call_id: 'call-1' });
    expect(repo['openForSession']).toHaveBeenCalledWith(SESSION.id, 't-1', 'a-1', AGENCY_HELP_EXPIRY_MS);
    expect(await service().openHelp(SESSION)).toBeNull();
  });
});

describe('sendMessage', () => {
  const send = (over: Partial<Parameters<FloorAssistService['sendMessage']>[0]> = {}) =>
    service().sendMessage({ session: SESSION, senderUserId: 'sup-1', fromName: 'Anitha N', text: 'Offer the 3-month plan', ...over });

  it('no station here that can receive it: agent_not_live, nothing stored, sent or audited', async () => {
    (deps.canReceive as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(await send()).toEqual({ ok: false, code: 'agent_not_live' });
    expect(repo['insertMessage']).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    expect(deps.audits).toEqual([]);
    expect(metrics.message).toHaveBeenCalledWith('agent_not_live');
  });

  it('delivered: stored, the frame sent, marked delivered, one audit row (never the text), then an open request answered by message', async () => {
    const out = await send();
    expect(out).toEqual({ ok: true, id: 'msg-1', sent_at: new Date('2026-11-19T10:01:00.000Z') });
    expect(repo['insertMessage']).toHaveBeenCalledWith({
      tenantId: 't-1', accountId: 'a-1', sessionId: SESSION.id, agentUserId: 'agent-1', senderUserId: 'sup-1', text: 'Offer the 3-month plan',
    });
    expect(repo['markDelivered']).toHaveBeenCalledWith('msg-1');
    expect(events()).toEqual([
      { event: 'supervisor_message', id: 'msg-1', text: 'Offer the 3-month plan', from_name: 'Anitha N', sent_at: '2026-11-19T10:01:00.000Z' },
      { event: 'help_answered', raised_at: RAISED.toISOString(), by_name: 'Anitha N', how: 'message' },
      { event: 'help_cleared', raised_at: RAISED.toISOString(), reason: 'answered' },
    ]);
    expect(deps.audits.map((a) => a['action'])).toEqual(['agency_session.message_sent', 'agency_session.help_answered']);
    expect(deps.audits[0]).toMatchObject({
      actor_type: 'human', user_id: 'sup-1', resource_id: SESSION.id,
      details: { message_id: 'msg-1', agent_user_id: 'agent-1', delivered: true, length: 22, campaign_id: 'c-1' },
    });
    expect(JSON.stringify(deps.audits)).not.toContain('3-month');
    expect(metrics.message).toHaveBeenCalledWith('delivered');
    // The answer names the sender the message already carried: no second read of the name.
    expect(deps.names).not.toHaveBeenCalled();
  });

  it('the delivered mark and the help answer run together: neither waits for the other', async () => {
    // FALSIFIED: run one after the other, the mark never settles (it waits for the answer) and this times out.
    let answering!: () => void;
    const answerStarted = new Promise<void>((resolve) => { answering = resolve; });
    repo['answer']!.mockImplementation(async () => { answering(); return { ...ended(), expired: false, answered_at: new Date(RAISED.getTime() + 1_000) }; });
    repo['markDelivered']!.mockImplementation(async () => { await answerStarted; });
    expect(await send()).toMatchObject({ ok: true });
    expect(events().map((f) => f['event'])).toEqual(['supervisor_message', 'help_answered', 'help_cleared']);
  });

  it('the socket refused the frame after the check: the row stays undelivered, audited so, agent_not_live, no help answered', async () => {
    (deps.send as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(await send()).toEqual({ ok: false, code: 'agent_not_live' });
    expect(repo['markDelivered']).not.toHaveBeenCalled();
    expect(repo['answer']).not.toHaveBeenCalled();
    expect(deps.audits).toEqual([expect.objectContaining({ action: 'agency_session.message_sent', details: expect.objectContaining({ delivered: false }) })]);
  });

  it('the mark fails once: tried again, marked, nothing counted as a failure', async () => {
    repo['markDelivered']!.mockRejectedValueOnce(new Error('connection reset'));
    expect(await send()).toMatchObject({ ok: true, id: 'msg-1' });
    expect(repo['markDelivered']).toHaveBeenCalledTimes(2);
    expect(metrics.markFailed).not.toHaveBeenCalled();
  });

  it('the mark fails twice: still delivered (the agent has it), counted, and the metric, audit row and help answer all still happen', async () => {
    // FALSIFIED: with the mark awaited bare again (no catch) this reds: the send rejects, which the
    // route turned into a 500 for a message the agent had been shown.
    repo['markDelivered']!.mockRejectedValue(new Error('pool exhausted'));
    expect(await send()).toEqual({ ok: true, id: 'msg-1', sent_at: new Date('2026-11-19T10:01:00.000Z') });
    expect(repo['markDelivered']).toHaveBeenCalledTimes(2);
    expect(metrics.markFailed).toHaveBeenCalledTimes(1);
    expect(metrics.message).toHaveBeenCalledWith('delivered');
    expect(deps.audits.map((a) => a['action'])).toEqual(['agency_session.message_sent', 'agency_session.help_answered']);
    expect(deps.audits[0]).toMatchObject({ details: expect.objectContaining({ delivered: true }) });
    expect(events().map((f) => f['event'])).toEqual(['supervisor_message', 'help_answered', 'help_cleared']);
  });

  it('each step after delivery is independent: a throwing metric and audit skip neither the answer nor the 201', async () => {
    metrics.message.mockImplementationOnce(() => { throw new Error('meter'); });
    (deps.audit as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('audit'); });
    repo['markDelivered']!.mockRejectedValue(new Error('down'));
    expect(await send()).toMatchObject({ ok: true });
    expect(repo['answer']).toHaveBeenCalledTimes(1);
    expect(events().map((f) => f['event'])).toEqual(['supervisor_message', 'help_answered', 'help_cleared']);
  });

  it('a message to an agent with no open request: delivered, no help frames', async () => {
    repo['answer']!.mockResolvedValue(null);
    await send();
    expect(events().map((f) => f['event'])).toEqual(['supervisor_message']);
  });
});

describe('the rules', () => {
  it('a message is trimmed, then 1 to 500 characters (code points, so a Telugu or emoji message counts what it shows)', () => {
    expect(normaliseMessageText('  Offer the plan \n')).toBe('Offer the plan');
    expect(normaliseMessageText('త'.repeat(500))).toBe('త'.repeat(500));
    expect(normaliseMessageText('😀'.repeat(500))).toBe('😀'.repeat(500));
    for (const bad of ['', '   ', 'x'.repeat(501), '😀'.repeat(501), 42, null, undefined, ['a']]) {
      expect(normaliseMessageText(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('a message holds no control character Postgres or the agent cannot use: NUL and the other C0 controls refused, never stripped (LF17)', () => {
    // FALSIFIED: with the forbidden-character test removed, the NUL cases red (and the route then
    // reached Postgres with a NUL: `22021`, which the agency error handler answers a bare 400
    // "Invalid input" with no `message_invalid` code).
    for (const bad of ['a\u0000b', '\u0000', 'Offer\u0007 the plan', 'x\u001by', 'x\u007fy', 'x\u000by', 'x\ud800y', 'x\udc00']) {
      expect(normaliseMessageText(bad), JSON.stringify(bad)).toBeNull();
    }
    // Tab and line breaks are text; a carriage return becomes a line feed.
    expect(normaliseMessageText('Step 1\tOffer\nStep 2')).toBe('Step 1\tOffer\nStep 2');
    expect(normaliseMessageText('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
    // A well-formed pair is one character, never refused.
    expect(normaliseMessageText('Good 😀')).toBe('Good 😀');
  });

  it('the sender\'s name in the frame: cut to its length (never inside a surrogate pair), never a refusal', () => {
    expect(senderNameForFrame('Anitha N')).toBe('Anitha N');
    expect(senderNameForFrame(null)).toBeNull();
    expect(senderNameForFrame('   ')).toBeNull();
    expect(senderNameForFrame('x'.repeat(SENDER_NAME_MAX_CHARS))).toBe('x'.repeat(SENDER_NAME_MAX_CHARS));
    const long = senderNameForFrame('😀'.repeat(600))!;
    expect([...long]).toHaveLength(SENDER_NAME_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(/\p{Cs}/u.test(long)).toBe(false);
  });

  it('every refusal code has its sentence, in British English', () => {
    expect(Object.keys(FLOOR_ASSIST_REFUSAL_MESSAGES).sort()).toEqual([...AGENCY_FLOOR_ASSIST_ERROR_CODES].sort());
    expect(Object.values(FLOOR_ASSIST_REFUSAL_MESSAGES).join(' ')).not.toMatch(/\b(canceled|dialed|color)\b/);
  });
});
