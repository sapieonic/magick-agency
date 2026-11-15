import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';

/**
 * The soft-phone switch (`SoftphoneService.switchToSoftphone`) and the withdrawal of a queued
 * switch (`returnFromSoftphone`) during a hidden dial (late binding): the agent is `reserved`
 * in Redis for a dial they have not been shown. Both answers say the state as the agent is
 * shown it (`dialer.shownStateFor`), `available`; the `agent_state` frame stays suppressed (it
 * would announce a change that did not happen); the switch is still queued from the real
 * `reserved` (`breakMustWait`), and the audit's from-state is the real one. Under early
 * binding the same requests answer `reserved` and frame it.
 *
 * FALSIFIED: with `state: busy` (switch) or `state` (withdrawal) restored in the answers, the
 * hidden-dial cases red on `reserved`.
 */

const { sessions } = vi.hoisted(() => ({ sessions: { findById: vi.fn() } }));
vi.mock('../../../src/db/repositories/agency.repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/db/repositories/agency.repository.js')>()),
  agencyAgentSessionRepository: sessions,
}));

import { BreakRegistry } from '@magick-agency/domain/break-manager';
import { SoftphoneService } from '../../../src/agency/softphone/softphone-service.js';
import { withShownState } from '../../helpers/shown-state-double.js';

const SESSION = '0b0c5d3e-1f2a-4b6c-8d9e-0f1a2b3c4d5e';
const ACTOR = { tenantId: 't1', accountId: 'a1', userId: 'u1', supervise: false };

function harness(state: AgencyAgentState, unannounced: boolean) {
  const sent: Array<Record<string, unknown>> = [];
  const breaks = new BreakRegistry();
  const dialer = withShownState({ hasUnannouncedAttempt: vi.fn(() => unannounced) });
  const service = new SoftphoneService({
    agents: { get: vi.fn(async () => ({ state, attemptId: 'att-1', since: 1 })), transition: vi.fn(), set: vi.fn() },
    stations: { send: vi.fn((_id: string, frame: Record<string, unknown>) => { sent.push(frame); return true; }) },
    breaks,
    dialer,
    dnc: {}, manual: {}, dedications: {},
  } as never);
  return { service, sent, breaks, dialer };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessions.findById.mockResolvedValue({
    id: SESSION, tenant_id: 't1', account_id: 'a1', agent_user_id: 'u1', kind: 'campaign', campaign_id: 'camp-1',
    state: 'available', break_reason: null, left_at: null,
  });
});

describe('switchToSoftphone behind a reservation', () => {
  it('a hidden dial: queued from the real `reserved`, answered `available`, no frame', async () => {
    const h = harness('reserved', true);
    const res = await h.service.switchToSoftphone(SESSION, ACTOR);
    expect(res).toMatchObject({
      ok: true, queued: true, fromState: 'reserved',
      response: { state: 'available', pending_state: 'break', break_reason: 'soft_phone' },
    });
    expect(h.breaks.peek(SESSION)?.code).toBe('soft_phone');
    expect(h.sent).toEqual([]);
  });

  it('a reservation the agent was shown: answered and framed `reserved`', async () => {
    const h = harness('reserved', false);
    const res = await h.service.switchToSoftphone(SESSION, ACTOR);
    expect(res).toMatchObject({ ok: true, queued: true, response: { state: 'reserved', pending_state: 'break' } });
    expect(h.sent).toEqual([expect.objectContaining({ event: 'agent_state', state: 'reserved', pending_state: 'break' })]);
  });
});

describe('returnFromSoftphone withdrawing a queued switch', () => {
  it('a hidden dial: withdrawn, answered `available`, no frame', async () => {
    const h = harness('reserved', true);
    h.breaks.queue(SESSION, { code: 'soft_phone', label: 'Soft phone' });
    const res = await h.service.returnFromSoftphone(SESSION, ACTOR);
    expect(res).toMatchObject({ ok: true, withdrawn: true, fromState: 'reserved', response: { state: 'available' } });
    expect(h.breaks.peek(SESSION)).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it('a reservation the agent was shown: withdrawn, answered and framed `reserved`', async () => {
    const h = harness('reserved', false);
    h.breaks.queue(SESSION, { code: 'soft_phone', label: 'Soft phone' });
    const res = await h.service.returnFromSoftphone(SESSION, ACTOR);
    expect(res).toMatchObject({ ok: true, withdrawn: true, response: { state: 'reserved' } });
    expect(h.sent).toEqual([expect.objectContaining({ event: 'agent_state', state: 'reserved' })]);
  });
});
