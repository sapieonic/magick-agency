import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * Harness plumbing: the connection mock targets agency's `@magick-agency/db` (and its
 * `/connection` entry, which packages/db's repositories import); the config stub
 * carries no carrier config.
 */
import { closeTestPool, getTestPool, truncateAll } from '../../setup/test-utils.js';
import { AGENCY_DEFAULT_DISPOSITION_CATALOG } from '@magick-agency/contracts/agency';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('../../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {}, // no carrier config is needed
  },
}));

const { createChaosWorld, attempts } = await import('./harness.js');
const {
  agencyAttemptRepository, agencyContactRepository,
} = await import('../../../../src/db/repositories/agency.repository.js');

type World = Awaited<ReturnType<typeof createChaosWorld>>;

/**
 * ─── A SETTLE WRITE FAILS, AND THE ROWS MUST STILL BE RECOVERABLE ───────────
 *
 * The dialer's `ended` arm makes two durable writes: the attempt row
 * (`state='ended'` with its outcome) and then the contact's fate. Either can throw
 * on a transient database error, and the arm still tells the agent and releases
 * them. What these scenarios pin is what is left behind, and that the reaper
 * actually recovers it — with the agent's station still connected, which is the
 * case the attempt sweep's station-owner arm would otherwise skip forever.
 */

const TRANSIENT = 'Connection terminated unexpectedly';

/** Fail the dialer's own `ended` write (the one carrying an outcome) once. */
function failEndedRowWriteOnce() {
  const real = agencyAttemptRepository.setState.bind(agencyAttemptRepository);
  let failed = false;
  return vi.spyOn(agencyAttemptRepository, 'setState').mockImplementation(async (id, state, patch) => {
    if (!failed && state === 'ended' && patch?.outcome) {
      failed = true;
      throw new Error(TRANSIENT);
    }
    return real(id, state, patch);
  });
}

async function contactRow(id: string) {
  const { rows } = await getTestPool().query<{ state: string; attempt_count: number; last_outcome: string | null }>(
    'SELECT state, attempt_count, last_outcome FROM agency_contacts WHERE id = $1',
    [id],
  );
  return rows[0]!;
}

async function liveAttemptCount(campaignId: string): Promise<number> {
  return agencyAttemptRepository.countLive(campaignId);
}

describe('a failed settle write leaves rows the reaper recovers (chaos)', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(closeTestPool);

  it('a connected call whose ended write fails never enters wrap-up or half-ends the row; the reaper ends it', async () => {
    world = await createChaosWorld({
      agents: 1,
      contacts: 2,
      // A disposition is owed and there is a window, so a recorded call WOULD enter wrap-up.
      campaign: { wrapup_seconds: 30, disposition_catalog: JSON.stringify(AGENCY_DEFAULT_DISPOSITION_CATALOG) },
    });
    const agent = world.agents[0]!;
    world.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', talkTimeSeconds: 20, hold: true });
    await world.bringOnline(agent);
    await world.tick();
    const [live] = await attempts(world.campaignId);
    expect(live?.state).toBe('bridged');

    failEndedRowWriteOnce();
    await world.bridge.endHeld();
    await vi.waitFor(async () => {
      expect((await world.agentState.get(agent.sessionId))?.state).toBe('available');
    });

    // No half-ended row: wrap-up used to write `state='ended'` with no outcome and
    // no `ended_at`, which every sweep then skipped.
    const [after] = await attempts(world.campaignId);
    expect(after!.state, 'wrap-up ended a row the settle never recorded').toBe('bridged');
    expect(after!.outcome).toBeNull();
    expect(world.dialer.activeAttemptIds()).toEqual([]);

    // The station is still connected: the attempt sweep's station-owner arm would
    // skip this row for as long as the agent stays.
    expect(await world.stations.ownerOf(agent.sessionId)).not.toBeNull();

    expect(await world.reaper.sweepOnce()).toBe(1);
    const [reaped] = await attempts(world.campaignId);
    expect(reaped!.state).toBe('ended');
    expect(reaped!.outcome).toBe('orphaned');
    expect(reaped!.ended_at).not.toBeNull();
    expect(await liveAttemptCount(world.campaignId)).toBe(0);
    const contact = await contactRow(live!.contact_id);
    expect(contact.state).toBe('pending');
    expect(contact.attempt_count, 'our failed write spent the customer’s allowance').toBe(0);

    // Recovered once: a second sweep finds nothing left to do.
    expect(await world.reaper.sweepOnce()).toBe(0);
  });

  it('a no-answer whose ended write fails is reaped while the agent is still connected', async () => {
    world = await createChaosWorld({ agents: 1, contacts: 2 });
    const agent = world.agents[0]!;
    world.bridge.setDefaultScript({ answer: false, bridge: false, status: 'no_answer' });
    await world.bringOnline(agent);

    failEndedRowWriteOnce();
    await world.tick();
    await vi.waitFor(async () => {
      expect((await world.agentState.get(agent.sessionId))?.state).toBe('available');
    });
    const [live] = await attempts(world.campaignId);
    expect(live!.state).not.toBe('ended');
    expect(await liveAttemptCount(world.campaignId), 'the leaked attempt holds a dialing slot').toBe(1);
    expect(await world.stations.ownerOf(agent.sessionId)).not.toBeNull();

    expect(await world.reaper.sweepOnce()).toBe(1);
    expect(await liveAttemptCount(world.campaignId)).toBe(0);
    const contact = await contactRow(live!.contact_id);
    expect(contact.state).toBe('pending');
    expect(contact.last_outcome).toBe('orphaned');
  });

  it('a contact left in_flight by a failed contact settlement is requeued by the stranded-contact sweep', async () => {
    world = await createChaosWorld({ agents: 1, contacts: 2 });
    const agent = world.agents[0]!;
    world.bridge.setDefaultScript({ answer: false, bridge: false, status: 'no_answer' });
    await world.bringOnline(agent);

    vi.spyOn(agencyContactRepository, 'chargeAttempt').mockRejectedValueOnce(new Error(TRANSIENT));
    await world.tick();
    await vi.waitFor(async () => {
      expect((await world.agentState.get(agent.sessionId))?.state).toBe('available');
    });
    const [ended] = await attempts(world.campaignId);
    expect(ended!.state).toBe('ended');
    expect(ended!.outcome).toBe('no_answer');
    expect((await contactRow(ended!.contact_id)).state, 'precondition: the contact is stranded').toBe('in_flight');

    // The attempt-side sweeps cannot see it: its attempt is terminal and not
    // `connected`.
    expect(await world.reaper.sweepOnce()).toBe(0);
    expect(await world.reaper.sweepLapsedWrapups()).toBe(0);

    // Not yet: a contact this fresh may still be settling.
    expect(await world.reaper.sweepStrandedContacts()).toBe(0);
    expect((await contactRow(ended!.contact_id)).state).toBe('in_flight');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await world.reaper.sweepStrandedContacts()).toBe(1);
    vi.useRealTimers();

    const contact = await contactRow(ended!.contact_id);
    expect(contact.state).toBe('pending');
    expect(contact.last_outcome).toBe('orphaned');
    expect(contact.attempt_count, 'the failed charge was charged after all').toBe(0);
  });
});
