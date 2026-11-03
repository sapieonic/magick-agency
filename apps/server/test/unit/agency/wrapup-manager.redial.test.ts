import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Wrap-up redial, the wrap-up manager's half (`takeForRedial` / `finishRedial`).
//
// The acceptance criterion this file holds: with auto-return on, pressing Redial
// stops the wrap-up countdown, and the agent is never returned to the pool while the
// redial rings or talks. Plus `redial_remaining` on the wrap-up frame, and the
// refusals that leave the wrap-up untouched.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: { setState: vi.fn().mockResolvedValue(null) },
    session: { setState: vi.fn().mockResolvedValue(undefined) },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyAgentSessionRepository: repos.session,
  agencyContactRepository: {},
  agencyCampaignRepository: {},
}));

import { REDIAL_SETUP_MAX_MS, WrapupManager } from '../../../src/agency/wrapup-manager.js';
import type { AgentStateMachine } from '../../../src/agency/agent-state-machine.js';
import type { StationRegistry } from '../../../src/agency/station-registry.js';

function fakeStations() {
  const sent: any[] = [];
  return {
    sent,
    send: vi.fn((_id: string, frame: any) => { sent.push(frame); return true; }),
    frames: (event: string) => sent.filter((f) => f.event === event),
  };
}

function manager() {
  const stations = fakeStations();
  const agents = { set: vi.fn(async () => 'ok') };
  const onReturn = vi.fn(async () => undefined);
  const wrapup = new WrapupManager(
    stations as unknown as StationRegistry,
    agents as unknown as AgentStateMachine,
    onReturn,
  );
  return { wrapup, stations, onReturn };
}

function enterParams(over: Partial<Parameters<WrapupManager['enter']>[0]> = {}) {
  return {
    sessionId: 's1', attemptId: 'att-1', campaignId: 'camp-1', tenantId: 'ten-1',
    wrapupSeconds: 30, autoReturn: true, requiresDisposition: true, redialRemaining: 2,
    ...over,
  };
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('WrapupManager — wrap-up redial', () => {
  it('announces redial_remaining on the wrapup frame when offered', async () => {
    const { wrapup, stations } = manager();
    await wrapup.enter(enterParams({ redialRemaining: 1 }));
    expect(stations.frames('wrapup').at(-1).wrapup.redial_remaining).toBe(1);
    expect(wrapup.stateFor('s1')?.redial_remaining).toBe(1);
  });

  it('leaves redial_remaining off the frame when not offered (null or absent)', async () => {
    const { wrapup, stations } = manager();
    await wrapup.enter(enterParams({ redialRemaining: null }));
    expect(stations.frames('wrapup').at(-1).wrapup).not.toHaveProperty('redial_remaining');
    await wrapup.enter(enterParams({ sessionId: 's2', redialRemaining: undefined }));
    expect(wrapup.stateFor('s2')).not.toHaveProperty('redial_remaining');
  });

  it('Redial stops the auto-return countdown: the agent is never returned while the redial runs', async () => {
    // The production shape: redial is only offered while an outcome is owed.
    const { wrapup, onReturn, stations } = manager();
    await wrapup.enter(enterParams({ wrapupSeconds: 30, autoReturn: true }));
    expect(wrapup.stateFor('s1')?.ends_at).not.toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    const take = wrapup.takeForRedial('s1', 'att-1');
    expect(take.ok).toBe(true);
    expect(wrapup.stateFor('s1')).toBeNull();
    const framesAtTake = stations.frames('wrapup').length;

    // Well past the window: nothing fires — no return, and no hold pushed for a
    // wrap-up that no longer exists.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onReturn).not.toHaveBeenCalled();
    expect(stations.frames('wrapup')).toHaveLength(framesAtTake);
    expect(wrapup.active()).toBe(0);
  });

  it('marks the redial as being set up from the take until the agent is back in wrap-up', async () => {
    const { wrapup } = manager();
    await wrapup.enter(enterParams());
    expect(wrapup.redialBeingSetUp('s1')).toBe(false);
    expect(wrapup.takeForRedial('s1', 'att-1').ok).toBe(true);
    expect(wrapup.redialBeingSetUp('s1')).toBe(true);
    // Back in wrap-up (a refused redial, or the redial's own end): cleared.
    await wrapup.enter(enterParams({ attemptId: 'att-2' }));
    expect(wrapup.redialBeingSetUp('s1')).toBe(false);
  });

  it('the set-up mark ends when the dialer registers the redial, and goes stale past its bound', async () => {
    const { wrapup } = manager();
    await wrapup.enter(enterParams());
    wrapup.takeForRedial('s1', 'att-1');
    wrapup.endRedialSetup('s1');
    expect(wrapup.redialBeingSetUp('s1')).toBe(false);

    await wrapup.enter(enterParams());
    wrapup.takeForRedial('s1', 'att-1');
    await vi.advanceTimersByTimeAsync(REDIAL_SETUP_MAX_MS + 1);
    expect(wrapup.redialBeingSetUp('s1')).toBe(false);
  });

  it('endTaken records how a taken wrap-up ended and clears the set-up mark, without returning the agent', async () => {
    const { wrapup, onReturn } = manager();
    await wrapup.enter(enterParams());
    const take = wrapup.takeForRedial('s1', 'att-1');
    if (!take.ok) throw new Error('expected the take');
    repos.attempt.setState.mockClear();
    wrapup.endTaken(take.taken, 'disposition_submitted');
    await vi.runAllTimersAsync();
    expect(repos.attempt.setState).toHaveBeenCalledWith('att-1', 'ended', expect.objectContaining({
      wrapup_resolution: 'disposition_submitted',
    }));
    expect(wrapup.redialBeingSetUp('s1')).toBe(false);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('setRedialRemaining withdraws and restores the offer on the live wrap-up for that attempt only', async () => {
    const { wrapup, stations } = manager();
    await wrapup.enter(enterParams({ redialRemaining: 1 }));
    wrapup.setRedialRemaining('s1', 'att-other', null);
    expect(wrapup.stateFor('s1')?.redial_remaining).toBe(1);
    wrapup.setRedialRemaining('s1', 'att-1', null);
    expect(wrapup.stateFor('s1')).not.toHaveProperty('redial_remaining');
    expect(stations.frames('wrapup').at(-1).wrapup).not.toHaveProperty('redial_remaining');
    expect(wrapup.takeForRedial('s1', 'att-1')).toEqual({ ok: false, reason: 'not_offered' });
    wrapup.setRedialRemaining('s1', 'att-1', 1);
    expect(stations.frames('wrapup').at(-1).wrapup.redial_remaining).toBe(1);
  });

  it('a held (outcome-owed) wrap-up can be taken too, and is never returned by a timer afterwards', async () => {
    const { wrapup, onReturn } = manager();
    await wrapup.enter(enterParams({ wrapupSeconds: 5 }));
    await vi.advanceTimersByTimeAsync(6_000); // lapses into the disposition hold
    expect(wrapup.stateFor('s1')?.held_reason).toBe('disposition_required');
    expect(wrapup.takeForRedial('s1', 'att-1').ok).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('finishRedial records the wrap-up as ended by a redial, without returning the agent', async () => {
    const { wrapup, onReturn } = manager();
    await wrapup.enter(enterParams());
    const take = wrapup.takeForRedial('s1', 'att-1');
    if (!take.ok) throw new Error('expected the take');
    repos.attempt.setState.mockClear();
    wrapup.finishRedial(take.taken);
    await vi.runAllTimersAsync();
    expect(repos.attempt.setState).toHaveBeenCalledWith('att-1', 'ended', expect.objectContaining({
      wrapup_resolution: 'redialed',
    }));
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('a refused redial re-enters with a fresh window', async () => {
    const { wrapup, onReturn } = manager();
    await wrapup.enter(enterParams({ wrapupSeconds: 30 }));
    const firstEndsAt = Date.parse(wrapup.stateFor('s1')!.ends_at!);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(wrapup.takeForRedial('s1', 'att-1').ok).toBe(true);
    await wrapup.enter(enterParams({ wrapupSeconds: 30 }));
    // A FRESH deadline: 30 s from the re-entry, 25 s later than the first one.
    expect(Date.parse(wrapup.stateFor('s1')!.ends_at!) - firstEndsAt).toBe(25_000);
    // The old countdown is gone: 10 s later (35 s after the first entry) nothing fired.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wrapup.stateFor('s1')?.held_reason).toBeNull();
    // The new one lapses into the disposition hold — never a return with an outcome owed.
    await vi.advanceTimersByTimeAsync(21_000);
    expect(wrapup.stateFor('s1')?.held_reason).toBe('disposition_required');
    expect(onReturn).not.toHaveBeenCalled();
  });

  describe('refusals leave the wrap-up exactly as it was', () => {
    it('no wrap-up, or a wrap-up for another attempt', async () => {
      const { wrapup } = manager();
      expect(wrapup.takeForRedial('s1', 'att-1')).toEqual({ ok: false, reason: 'not_in_wrapup' });
      await wrapup.enter(enterParams());
      expect(wrapup.takeForRedial('s1', 'att-other')).toEqual({ ok: false, reason: 'not_in_wrapup' });
      expect(wrapup.stateFor('s1')?.attempt_id).toBe('att-1');
    });

    it('not offered', async () => {
      const { wrapup } = manager();
      await wrapup.enter(enterParams({ redialRemaining: null }));
      expect(wrapup.takeForRedial('s1', 'att-1')).toEqual({ ok: false, reason: 'not_offered' });
      expect(wrapup.active()).toBe(1);
    });

    it('limit used up', async () => {
      const { wrapup } = manager();
      await wrapup.enter(enterParams({ redialRemaining: 0 }));
      expect(wrapup.takeForRedial('s1', 'att-1')).toEqual({ ok: false, reason: 'limit_reached' });
      expect(wrapup.active()).toBe(1);
    });

    it('the countdown keeps running after a refusal', async () => {
      const { wrapup, onReturn } = manager();
      await wrapup.enter(enterParams({ redialRemaining: 0, wrapupSeconds: 30 }));
      wrapup.takeForRedial('s1', 'att-1');
      expect(wrapup.redialBeingSetUp('s1')).toBe(false);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(wrapup.stateFor('s1')?.held_reason).toBe('disposition_required');
      expect(onReturn).not.toHaveBeenCalled();
    });
  });
});
