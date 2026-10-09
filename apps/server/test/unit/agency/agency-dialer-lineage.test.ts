// PORT NOTE (magick-agency, Phase 6): ported from core
// test/unit/agency/agency-dialer-lineage.test.ts@4850d1d9 (5 cases → 5). Deleted: none.
// Modified (no case changed meaning):
//  - mock/import specifiers follow the path rule (logger → `@magick-agency/observability`;
//    break-manager / timers / abandonment-predicate → `@magick-agency/domain/*`);
//  - the campaign fixture drops `sip_connection_id` (SIP deleted, plan §5; the dialer
//    no longer passes `sipConnectionId`, docs/seams.md §3.1). No assertion read it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The agent panel's history, now scoped to a contact's RETRY LINEAGE.
//
// Retry campaigns COPY contacts rather than sharing them (DR-2 — every piece of
// per-campaign state lives on the row, and sharing one would make
// `uq_agency_attempt_live` a cross-campaign lock), so the previous pass's
// attempts hang off a DIFFERENT `agency_contacts` row. Without the lineage read
// the agent taking a retry call sees an empty history on exactly the calls where
// history matters most.
//
// ── What must NOT change, and is asserted here rather than trusted ─────────
//
// This read is on the dial hot path: `executeDial` gathers everything the panel
// needs, writes the `reserved` frame SYNCHRONOUSLY, and only then dials. The
// existing suite pins the ordering; this file pins the two properties that the
// widening puts at risk — that a failure of a bigger, joined query still costs
// only the history, and that the read is keyed on the chain head rather than on
// the contact.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { vobiz: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/vobiz' } },
  },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
      recordDisposition: vi.fn().mockResolvedValue(null),
      recordAutoDisposition: vi.fn().mockResolvedValue(null),
    },
    contact: {
      unclaim: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(undefined),
      chargeAttempt: vi.fn().mockResolvedValue(1),
    },
    session: { setState: vi.fn().mockResolvedValue(undefined) },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyContactRepository: repos.contact,
  agencyCampaignRepository: {},
  agencyAgentSessionRepository: repos.session,
}));

import { AgencyDialer } from '../../../src/agency/agency-dialer.js';
import { AgentStateMachine } from '../../../src/agency/agent-state-machine.js';
import { StationRegistry } from '../../../src/agency/station-registry.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

const CAMPAIGN = {
  id: 'camp-child', name: 'Q3 Winback — Retry 1', telephony_provider: 'vobiz',
  record_calls: false, analysis_profile_id: null, // PORT NOTE: `sip_connection_id` dropped (SIP deleted)
  disposition_catalog: [], wrapup_seconds: 0, wrapup_auto_return: true,
  retry_policy: {}, abandon_announcement_id: null,
} as any;

/** A contact copied from a parent campaign: its own id, an ancestor's root. */
const COPIED_CONTACT = {
  id: 'contact-child', phone_e164: '+919876543210', context: {}, attempt_count: 0,
  source_contact_id: 'contact-parent', root_contact_id: 'contact-root',
} as any;

function makeCmd(contact: any = COPIED_CONTACT): DialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-child', contactId: contact.id,
    sessionId: 's1', ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign: CAMPAIGN, contact,
  };
}

function fakeWs() {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on() { /* the bridge attaches its own listeners */ },
    off() { /* ditto */ },
    close() { this.readyState = 3; },
  };
}

function fakeBridge() {
  const listeners: Array<(e: any) => void> = [];
  return {
    listeners,
    onLifecycle(fn: (e: any) => void) { listeners.push(fn); return () => { /* noop */ }; },
    createBridgedCall: vi.fn(async () => ({ id: 'call-1' } as any)),
  };
}

function fakeWrapup() {
  return {
    enter: vi.fn(async () => false), cancel: vi.fn(), force: vi.fn(async () => false),
    stateFor: vi.fn(() => null), noteDisposition: vi.fn(async () => false),
    stop: vi.fn(), active: vi.fn(() => 0),
  };
}

function fakeBreaks() {
  return {
    queue: vi.fn(), peek: vi.fn(() => null), take: vi.fn(() => null),
    cancel: vi.fn(), size: vi.fn(() => 0),
  };
}

/**
 * An agent registry that reports the reservation as still held — a bare
 * `AgentStateMachine` with no Redis fails closed and would abort every dial.
 */
function reservedAgents(): AgentStateMachine {
  const agents = new AgentStateMachine(null, '');
  vi.spyOn(agents, 'transition').mockResolvedValue(true);
  return agents;
}

async function dial(contact: any = COPIED_CONTACT) {
  const stations = new StationRegistry(null, '', 'r1');
  const dialer = new AgencyDialer(
    fakeBridge() as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any,
  );
  dialer.start();
  const ws = fakeWs();
  await stations.attach({
    sessionId: 's1', campaignId: 'camp-child', tenantId: 't1', accountId: 'a1',
    agentUserId: 'user-1', ws: ws as any,
  });
  await dialer.executeDial(makeCmd(contact));
  return ws;
}

beforeEach(() => vi.clearAllMocks());

describe('the panel reads the CHAIN, not the contact row', () => {
  it('keys the history read on root_contact_id', async () => {
    // Keying on `contactId` here would show an agent taking a generation-2 call
    // an empty history, on a screen where "no prior attempts" and "we could not
    // find them" render identically.
    await dial();
    expect(repos.attempt.findPriorForContactLineage)
      .toHaveBeenCalledWith('contact-root', 'att-1');
  });

  it('falls back to the contact\'s own id when root_contact_id is not populated', async () => {
    // Unreachable in practice — migrations run in the container entrypoint before
    // the app boots, so 113's backfill has run — but a `null` would reach
    // `WHERE root_contact_id = $1` and match nothing, because NULL is never equal
    // to anything. The fallback degrades to "this contact's own history" rather
    // than silently to "no history".
    await dial({ ...COPIED_CONTACT, root_contact_id: null });
    expect(repos.attempt.findPriorForContactLineage)
      .toHaveBeenCalledWith('contact-child', 'att-1');
  });

  it('carries campaign_id, campaign_name and dialed_at onto every prior attempt', async () => {
    // "Attempt 2" means nothing once attempts come from two campaigns, and
    // `attempt_number` RESETS in each retry campaign (DR-2) so it is no longer a
    // global ordering. `dialed_at` is the fallback time for a row whose `ended_at`
    // is null because it never ended.
    repos.attempt.findPriorForContactLineage.mockResolvedValueOnce([
      {
        attempt_number: 1, outcome: 'no_answer', disposition_code: null, notes: null,
        ended_at: new Date('2026-08-20T10:00:00Z'), dialed_at: new Date('2026-08-20T09:59:00Z'),
        campaign_id: 'camp-parent', campaign_name: 'Q3 Winback',
      },
      {
        attempt_number: 2, outcome: null, disposition_code: 'voicemail', notes: 'left message',
        ended_at: null, dialed_at: null,
        campaign_id: 'camp-parent', campaign_name: 'Q3 Winback',
      },
    ]);

    const ws = await dial();

    const priors = ws.sent.find((f) => f.event === 'reserved')!.attempt.prior_attempts;
    expect(priors).toEqual([
      {
        attempt_number: 1, outcome: 'no_answer', disposition_code: null, notes: null,
        ended_at: '2026-08-20T10:00:00.000Z', dialed_at: '2026-08-20T09:59:00.000Z',
        campaign_id: 'camp-parent', campaign_name: 'Q3 Winback',
      },
      {
        attempt_number: 2, outcome: null, disposition_code: 'voicemail', notes: 'left message',
        ended_at: null, dialed_at: null,
        campaign_id: 'camp-parent', campaign_name: 'Q3 Winback',
      },
    ]);
  });

  it('preserves the repository\'s ordering rather than re-sorting in process', async () => {
    // The order is `ended_at DESC NULLS LAST`, decided in SQL. Re-sorting here on
    // `attempt_number` — the field that looks like the ordering — would interleave
    // two passes into nonsense, which is the whole reason the ORDER BY moved.
    repos.attempt.findPriorForContactLineage.mockResolvedValueOnce([
      { attempt_number: 1, outcome: null, disposition_code: null, notes: null, ended_at: new Date('2026-08-20T10:00:00Z'), dialed_at: null, campaign_id: 'c2', campaign_name: 'Retry 1' },
      { attempt_number: 3, outcome: null, disposition_code: null, notes: null, ended_at: new Date('2026-08-01T10:00:00Z'), dialed_at: null, campaign_id: 'c1', campaign_name: 'Q3 Winback' },
    ]);
    const ws = await dial();
    const priors = ws.sent.find((f) => f.event === 'reserved')!.attempt.prior_attempts;
    expect(priors.map((p: { campaign_name: string }) => p.campaign_name)).toEqual(['Retry 1', 'Q3 Winback']);
  });
});

describe('a failed lineage read still costs only the history', () => {
  it('sends the panel and places the dial when the query throws', async () => {
    // The guard that matters most, and it matters MORE now than it did: the read
    // is a three-table join across a lineage rather than a single-table lookup, so
    // it is a bigger thing to fail. History is nice-to-have; the customer is
    // dialled either way.
    repos.attempt.findPriorForContactLineage.mockRejectedValueOnce(new Error('db down'));

    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(
      bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any,
    );
    dialer.start();
    const ws = fakeWs();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-child', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: ws as any,
    });

    // Frames present at the moment the dial is placed — the ordering guarantee,
    // measured rather than assumed, with the history read failing.
    let framesAtDialTime: string[] = [];
    bridge.createBridgedCall.mockImplementation(async () => {
      framesAtDialTime = ws.sent.map((f) => f.event);
      return { id: 'call-1' } as any;
    });

    await dialer.executeDial(makeCmd());

    expect(framesAtDialTime).toEqual(['reserved']);
    expect(bridge.createBridgedCall).toHaveBeenCalledTimes(1);
    const reserved = ws.sent.find((f) => f.event === 'reserved');
    expect(reserved.attempt.prior_attempts).toEqual([]);
  });
});
