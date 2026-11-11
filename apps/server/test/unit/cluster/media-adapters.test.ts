import { beforeAll, describe, expect, it, vi } from 'vitest';
import { StationDirectory } from '../../../src/cluster/station-directory.js';
import { DialGrants, DispatchRefusedError, IpcDialDispatcher } from '../../../src/cluster/ipc-dial-dispatcher.js';
import { IpcRequestError, type IpcChannel } from '../../../src/cluster/ipc-channel.js';
import { decodeDialCommand, decodeManualCallRecord } from '../../../src/cluster/record-codecs.js';

/*
 * The primary's media-worker adapters (docs/scaling.md §3.1, §5.2): the station directory
 * pacing reads, the IPC dial dispatcher's outcome rules, the worker's synchronous grants,
 * and the record codecs that carry a dial command across.
 */

vi.mock('../../../src/agency/pre-dial-gates.js', () => ({
  rejectClearance: (clearance: { contactId?: string } | undefined, contactId: string) =>
    clearance && clearance.contactId === contactId ? null : 'wrong_contact',
}));

describe('StationDirectory', () => {
  function dir(owner: string | null = null) {
    const broadcast = vi.fn();
    const sendToWorker = vi.fn((_slot: number, _sessionId: string, _frame: unknown) => true);
    const d = new StationDirectory({ readOwner: async () => owner, broadcastToWorkers: broadcast, sendToWorker });
    return { d, broadcast, sendToWorker };
  }

  it('an agent is dialable only while attached to a live worker; a worker going down drops all of its agents', () => {
    const { d } = dir();
    d.workerUp(0, 'h:mw0:1');
    d.attached(0, 's1', 'c1', 'h:mw0:1');
    expect(d.isLocallyOwned('s1')).toBe(true);
    expect(d.get('s1')).toEqual({ campaignId: 'c1', canTakeInbound: false }); // IB8: never held back for an inbound caller
    d.workerDown(0);
    expect(d.isLocallyOwned('s1')).toBe(false);
    expect(d.get('s1')).toBeUndefined();
  });

  it('ignores a late event from a dead incarnation of the slot', () => {
    const { d } = dir();
    d.workerUp(0, 'h:mw0:1');
    d.workerUp(0, 'h:mw0:2'); // restarted
    d.attached(0, 's1', 'c1', 'h:mw0:1');
    expect(d.isLocallyOwned('s1')).toBe(false);
    d.attached(0, 's1', 'c1', 'h:mw0:2');
    expect(d.isLocallyOwned('s1')).toBe(true);
  });

  it('a snapshot replaces what the worker holds', () => {
    const { d } = dir();
    d.workerUp(1, 'r1');
    d.attached(1, 's1', 'c1', 'r1');
    d.snapshot(1, 'r1', [{ sessionId: 's2', campaignId: null }]);
    expect(d.isLocallyOwned('s1')).toBe(false);
    expect(d.isLocallyOwned('s2')).toBe(true);
    expect(d.countForSlot(1)).toBe(1);
  });

  it("ownerOf trusts the Redis key only when it names a live replica (a crashed worker's key is no owner)", async () => {
    const live = dir('r-live');
    live.d.workerUp(0, 'r-live');
    expect(await live.d.ownerOf('s1')).toBe('r-live');
    const dead = dir('r-dead');
    dead.d.workerUp(0, 'r-live');
    expect(await dead.d.ownerOf('s1')).toBeNull();
  });

  it('a broadcast goes to every worker and returns the attached count for the campaign', () => {
    const { d, broadcast } = dir();
    d.workerUp(0, 'r0');
    d.attached(0, 's1', 'c1', 'r0');
    d.attached(0, 's2', 'c2', 'r0');
    const frame = { event: 'campaign_state' } as never;
    expect(d.broadcast('c1', frame)).toBe(1);
    expect(broadcast).toHaveBeenCalledWith('c1', frame);
  });

  it("a session's frame goes to the worker holding its station, and nowhere when no live worker does", () => {
    const { d, sendToWorker } = dir();
    d.workerUp(2, 'r2');
    d.attached(2, 's1', 'c1', 'r2');
    const frame = { event: 'queue', campaign_id: 'c1', due: true, reason: null, next_due_at: null } as never;
    expect(d.send('s1', frame)).toBe(true);
    expect(sendToWorker).toHaveBeenCalledWith(2, 's1', frame);
    expect(d.send('s-unknown', frame)).toBe(false);
    d.workerDown(2);
    expect(d.send('s1', frame)).toBe(false);
    expect(sendToWorker).toHaveBeenCalledTimes(1);
  });
});

describe('IpcDialDispatcher', () => {
  const cmd = (over: Record<string, unknown> = {}) => ({
    attemptId: 'a1', campaignId: 'c1', contactId: 'k1', sessionId: 's1', ownerReplica: 'r0', tenantId: 't', accountId: 'acc',
    callerId: '+911', attemptNumber: 1, campaign: { id: 'c1' }, contact: { id: 'k1' }, clearance: { contactId: 'k1' }, ...over,
  }) as never;

  function dispatcher(request: (...a: unknown[]) => Promise<unknown>, opts: { channel?: boolean; grant?: number | null } = {}) {
    const channel = { request: vi.fn(request) } as unknown as IpcChannel;
    const d = new IpcDialDispatcher({
      channelForReplica: () => (opts.channel === false ? null : channel),
      grantFor: () => (opts.grant === undefined ? 7 : opts.grant),
    });
    return { d, channel: channel as unknown as { request: ReturnType<typeof vi.fn> } };
  }

  it('sends the command without its clearance, with the grant, and resolves on the answer', async () => {
    const { d, channel } = dispatcher(async () => ({}));
    await d.dispatch(cmd());
    const [type, body] = channel.request.mock.calls[0]!;
    expect(type).toBe('dial.execute');
    expect((body as { grant: number }).grant).toBe(7);
    expect((body as { cmd: Record<string, unknown> }).cmd).not.toHaveProperty('clearance');
  });

  it('refuses a clearance for another contact before sending anything', async () => {
    const { d, channel } = dispatcher(async () => ({}));
    await expect(d.dispatch(cmd({ clearance: { contactId: 'other' } }))).rejects.toThrow(/clearance/);
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('throws (pacing ends the attempt) when nothing was sent: owner down, no grant, not authorised, channel refused', async () => {
    await expect(dispatcher(async () => ({}), { channel: false }).d.dispatch(cmd())).rejects.toBeInstanceOf(DispatchRefusedError);
    await expect(dispatcher(async () => ({}), { grant: null }).d.dispatch(cmd())).rejects.toBeInstanceOf(DispatchRefusedError);
    await expect(dispatcher(async () => ({})).d.dispatch(cmd(), { stillAuthorised: () => false })).rejects.toBeInstanceOf(DispatchRefusedError);
    await expect(dispatcher(async () => { throw new IpcRequestError('refused', 'dial.execute', 'full'); }).d.dispatch(cmd()))
      .rejects.toBeInstanceOf(DispatchRefusedError);
  });

  it('throws the worker\'s own error (executeDial threw)', async () => {
    await expect(dispatcher(async () => { throw new IpcRequestError('handler_error', 'dial.execute', 'boom'); }).d.dispatch(cmd()))
      .rejects.toMatchObject({ code: 'handler_error' });
  });

  it('resolves on timeout or a dead worker: the outcome is the worker\'s or the slot reap\'s, never a second writer', async () => {
    await expect(dispatcher(async () => { throw new IpcRequestError('timeout', 'dial.execute', 'slow'); }).d.dispatch(cmd())).resolves.toBeUndefined();
    await expect(dispatcher(async () => { throw new IpcRequestError('gone', 'dial.execute', 'died'); }).d.dispatch(cmd())).resolves.toBeUndefined();
  });
});

describe('DialGrants (the worker\'s synchronous stillAuthorised)', () => {
  it('a dial is authorised until its campaign is revoked up to its grant, or the engine stops', () => {
    const g = new DialGrants();
    const dial = g.checker('c1', 5);
    expect(dial()).toBe(true);
    g.revoke('c1', 4); // an older leadership
    expect(dial()).toBe(true);
    g.revoke('c2', 9); // another campaign
    expect(dial()).toBe(true);
    g.revoke('c1', 5);
    expect(dial()).toBe(false);
    expect(g.checker('c1', 6)()).toBe(true); // re-led under a new grant
    g.revoke(null, 6);
    expect(g.checker('c1', 6)()).toBe(false);
  });
});

describe('record codecs', () => {
  const at = '2026-11-02T10:00:00.000Z';
  const command = {
    attemptId: 'a1', campaignId: 'c1', contactId: 'k1', sessionId: 's1', ownerReplica: 'r0', tenantId: 't', accountId: 'acc',
    callerId: '+911', attemptNumber: 2,
    campaign: { id: 'c1', tenant_id: 't', account_id: 'acc', paused_at: null, started_at: at, ended_at: null, completed_at: null, created_at: at, updated_at: at },
    contact: { id: 'k1', campaign_id: 'c1', next_attempt_at: at, created_at: at, updated_at: at, phone_e164: '+911' },
    clearance: { forged: true },
  };

  it('revives exactly the date fields, keeps everything else, and drops what is not part of a command', () => {
    const cmd = decodeDialCommand(JSON.parse(JSON.stringify(command)))!;
    expect(cmd.campaign.started_at).toEqual(new Date(at));
    expect(cmd.campaign.paused_at).toBeNull();
    expect(cmd.contact.next_attempt_at).toEqual(new Date(at));
    expect(cmd.contact.phone_e164).toBe('+911');
    expect(cmd).not.toHaveProperty('clearance');
  });

  it('refuses a missing id, a bad attempt number or a date that is not one', () => {
    expect(decodeDialCommand({ ...command, sessionId: '' })).toBeNull();
    expect(decodeDialCommand({ ...command, attemptNumber: 1.5 })).toBeNull();
    expect(decodeDialCommand({ ...command, contact: { ...command.contact, next_attempt_at: 'soon' } })).toBeNull();
    expect(decodeManualCallRecord({ id: 'm1', session_id: 's1', settled_at: 'x' })).toBeNull();
    expect(decodeManualCallRecord({ id: 'm1', session_id: 's1', settled_at: at })!.settled_at).toEqual(new Date(at));
  });
});

describe('warnIfMoreProcessesThanCores', () => {
  // `primary.js` pulls in the agency runtime's module graph: imported once, with a timeout
  // of its own, rather than inside a test's 5 s budget (it hit it under full-suite load).
  let warnIfMoreProcessesThanCores: typeof import('../../../src/cluster/primary.js')['warnIfMoreProcessesThanCores'];
  beforeAll(async () => {
    ({ warnIfMoreProcessesThanCores } = await import('../../../src/cluster/primary.js'));
  }, 60_000);

  it('warns once, with the counts, only when workers are configured and the processes outnumber the cores', () => {
    const warn = vi.fn();
    expect(warnIfMoreProcessesThanCores(0, 0, 1, warn)).toBe(false);
    expect(warnIfMoreProcessesThanCores(1, 0, 2, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(warnIfMoreProcessesThanCores(2, 1, 2, warn)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ cores: 2, processes: 4, mediaWorkers: 2, analysisWorkers: 1 }), expect.any(String));
  });
});
