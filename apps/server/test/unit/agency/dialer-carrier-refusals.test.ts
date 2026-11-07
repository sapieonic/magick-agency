import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The paced dial on a tenant's own carrier account (decisions B18–B20), at the dial site:
//
//  - the dial carries the campaign's carrier and its pinned credential to the bridge;
//  - a carrier 401 (`carrier_auth_rejected`) pauses the campaign `carrier_auth`, with an
//    `agency_campaign.auto_paused` audit row whose reason says so, and returns the contact
//    at once, uncharged;
//  - a calls-per-second refusal (`carrier_rate_limited`) is back-pressure: the contact goes
//    back at once, uncharged, and nothing is paused;
//  - a credential that cannot dial (`telephony_credential_unavailable`: disabled, invalid,
//    revoked or unopenable since the campaign started) pauses the campaign
//    `carrier_account_unavailable`, audited, and returns the contact at once, uncharged,
//    instead of holding it and cycling the roster.
//
// Harness mirrors abandon-reason-telemetry.test.ts (project convention: no shared test
// utilities); the metrics module is left real, with no meter installed.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ isEnabled: async () => false, getValue: async () => 1800 }),
  FLAGS: {
    agency_late_binding: { key: 'agency_late_binding', type: 'boolean', default: false },
    webrtc_max_duration_seconds: { key: 'webrtc_max_duration_seconds', type: 'number', default: 1800 },
  },
}));

const { repos, audit } = vi.hoisted(() => ({
  repos: {
    attempt: {
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
    },
    contact: {
      unclaim: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(true),
      chargeAttempt: vi.fn().mockResolvedValue(1),
      chargeOurFaultAttempt: vi.fn().mockResolvedValue(1),
      requeueOrphaned: vi.fn().mockResolvedValue({ state: 'pending', our_fault_attempts: 1 }),
    },
    campaign: { pauseForCarrierAccount: vi.fn() },
    session: { setState: vi.fn().mockResolvedValue(undefined) },
    insightsPacing: { addToMinute: vi.fn().mockResolvedValue(undefined) },
  },
  audit: { log: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyContactRepository: repos.contact,
  agencyCampaignRepository: repos.campaign,
  agencyAgentSessionRepository: repos.session,
  agencyInsightsPacingRepository: repos.insightsPacing,
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: audit }));

import { AgencyDialer, PRE_CARRIER_FAILURE_REDIAL_DELAY_MS } from '../../../src/agency/agency-dialer.js';
import { WebRtcCallError } from '../../../src/core/webrtc-bridge-manager.js';
import { AgentStateMachine } from '../../../src/agency/agent-state-machine.js';
import { StationRegistry } from '../../../src/agency/station-registry.js';
import {
  CarrierAuthRejectedError, CarrierDialNotSentError, CarrierRateLimitedError, CarrierRequestTimeoutError,
} from '../../../src/telephony/carrier-errors.js';
import { CarrierRefusalBreaker, CARRIER_REFUSAL_BREAKER_THRESHOLD } from '../../../src/agency/carrier-refusal-breaker.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

function fakeWs() {
  return {
    readyState: 1, OPEN: 1, sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on() { /* the bridge attaches its own listeners */ },
    off() { /* ditto */ },
    close() { this.readyState = 3; },
  };
}

function fakeBridge() {
  return {
    onLifecycle() { return () => { /* noop */ }; },
    createBridgedCall: vi.fn(async (_p: any) => ({ id: 'call-1' } as any)),
    createUnboundBridgedCall: vi.fn(async (_p: any) => ({ id: 'call-1' } as any)),
    bindBorrowedBrowserLeg: vi.fn(() => true),
  };
}

const fakeWrapup = () => ({
  enter: vi.fn(async () => false), cancel: vi.fn(), force: vi.fn(async () => false), stateFor: vi.fn(() => null),
  noteDisposition: vi.fn(async () => false), stop: vi.fn(), active: vi.fn(() => 0),
});
const fakeBreaks = () => ({ queue: vi.fn(), peek: vi.fn(() => null), take: vi.fn(() => null), cancel: vi.fn(), size: vi.fn(() => 0) });

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1',
  telephony_provider: 'plivo', telephony_credential_id: 'cred-1', record_calls: true,
  analysis_profile_id: null, caller_ids: ['+14155550100'], disposition_catalog: [], retry_policy: {},
} as any;

function makeCmd(): DialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-1', contactId: 'contact-1',
    sessionId: 's1', ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign: CAMPAIGN, contact: { id: 'contact-1', phone_e164: '+919876543210', context: {}, attempt_count: 0 } as any,
  };
}

async function dialWith(rejection?: unknown, breaker?: CarrierRefusalBreaker, campaign: any = CAMPAIGN) {
  const bridge = fakeBridge();
  if (rejection) bridge.createBridgedCall.mockRejectedValue(rejection);
  const stations = new StationRegistry(null, '', 'r1');
  const agents = new AgentStateMachine(null, '');
  vi.spyOn(agents, 'transition').mockResolvedValue(true);
  const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any, breaker);
  dialer.start();
  await stations.attach({ sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1', agentUserId: 'user-1', ws: fakeWs() as any });
  await dialer.executeDial({ ...makeCmd(), campaign });
  return bridge;
}

function refusal(
  code: 'carrier_auth_rejected' | 'carrier_rate_limited' | 'telephony_credential_unavailable' | 'telephony_init_failed' | 'carrier_dial_not_sent',
  cause: unknown,
) {
  const err = new WebRtcCallError('refused', code, 502);
  err.cause = cause;
  return err;
}

function persistedOutcome(): string | undefined {
  return repos.attempt.setState.mock.calls.filter(([, state]: any[]) => state === 'ended').at(-1)?.[2]?.outcome;
}

function expectUncharged() {
  expect(repos.contact.chargeAttempt).not.toHaveBeenCalled();
  expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
  expect(repos.contact.requeueOrphaned).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  repos.campaign.pauseForCarrierAccount.mockImplementation(async (_id: string, reason: string) => ({ ...CAMPAIGN, status: 'paused', pause_reason: reason }));
});

describe('the paced dial on the campaign`s own carrier account', () => {
  it('hands the bridge the campaign`s carrier and its pinned credential', async () => {
    const bridge = await dialWith();
    expect(bridge.createBridgedCall).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'plivo', telephonyCredentialId: 'cred-1',
    }));
  });

  it('a campaign on the service`s own account dials with no credential', async () => {
    const bridge = fakeBridge();
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(true);
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    await stations.attach({ sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1', agentUserId: 'user-1', ws: fakeWs() as any });
    await dialer.executeDial({ ...makeCmd(), campaign: { ...CAMPAIGN, telephony_provider: 'voicelink', telephony_credential_id: null } });
    expect(bridge.createBridgedCall).toHaveBeenCalledWith(expect.objectContaining({ provider: 'voicelink', telephonyCredentialId: null }));
  });
});

describe('a carrier refusal that placed nothing', () => {
  it('a 401 on the credential pauses the campaign `carrier_auth`, audits it, and returns the contact at once, uncharged', async () => {
    await dialWith(refusal('carrier_auth_rejected', new CarrierAuthRejectedError('plivo', 401)));

    expect(repos.campaign.pauseForCarrierAccount).toHaveBeenCalledWith('camp-1', 'carrier_auth');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'agency_campaign.auto_paused',
      severity: 'error',
      actor: 'system:carrier-auth',
      eventData: expect.objectContaining({ campaign_id: 'camp-1', reason: 'carrier_auth', telephony_credential_id: 'cred-1' }),
    }));
    expect(persistedOutcome()).toBe('failed');
    expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
    expect((repos.contact.unclaim.mock.calls[0]![1] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expectUncharged();
  });

  it('a second 401 racing the first writes no second audit row (the campaign is no longer running)', async () => {
    repos.campaign.pauseForCarrierAccount.mockResolvedValue(null);
    await dialWith(refusal('carrier_auth_rejected', new CarrierAuthRejectedError('plivo', 401)));
    expect(repos.campaign.pauseForCarrierAccount).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
  });

  it('a pause that fails still releases the attempt and returns the contact', async () => {
    repos.campaign.pauseForCarrierAccount.mockRejectedValue(new Error('db down'));
    await dialWith(refusal('carrier_auth_rejected', new CarrierAuthRejectedError('plivo', 401)));
    expect(persistedOutcome()).toBe('failed');
    expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
    expectUncharged();
  });

  it('a calls-per-second refusal returns the contact at once, uncharged, and pauses nothing', async () => {
    await dialWith(refusal('carrier_rate_limited', new CarrierRateLimitedError('plivo', 'local_gate', 5000)));
    expect(persistedOutcome()).toBe('failed');
    expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
    expect((repos.contact.unclaim.mock.calls[0]![1] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(repos.campaign.pauseForCarrierAccount).not.toHaveBeenCalled();
    expectUncharged();
  });

  it('a credential that is no longer active pauses the campaign `carrier_account_unavailable`, audits it, and returns the contact at once, uncharged', async () => {
    await dialWith(refusal('telephony_credential_unavailable', new Error('Telephony credential cred-1 could not be resolved: disabled')));
    expect(repos.campaign.pauseForCarrierAccount).toHaveBeenCalledWith('camp-1', 'carrier_account_unavailable');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'agency_campaign.auto_paused',
      severity: 'error',
      actor: 'system:carrier-account',
      eventData: expect.objectContaining({ campaign_id: 'camp-1', reason: 'carrier_account_unavailable', telephony_credential_id: 'cred-1' }),
    }));
    expect(persistedOutcome()).toBe('failed');
    expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
    // Not held PRE_CARRIER_FAILURE_REDIAL_DELAY_MS: it waits for the resume, not a timer.
    expect((repos.contact.unclaim.mock.calls[0]![1] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expectUncharged();
  });

  it('any other failure before the carrier still holds the contact a minute and pauses nothing', async () => {
    const before = Date.now();
    await dialWith(refusal('telephony_init_failed', new Error('no webhook base')));
    const nextAt = (repos.contact.unclaim.mock.calls[0]![1] as Date).getTime();
    expect(nextAt).toBeGreaterThanOrEqual(before + PRE_CARRIER_FAILURE_REDIAL_DELAY_MS);
    expect(repos.campaign.pauseForCarrierAccount).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The refusal breaker (PL11): a credential-pinned campaign whose carrier refuses its dials
// CARRIER_REFUSAL_BREAKER_THRESHOLD times in a row, with no call placed in between, is paused
// `carrier_refusing_calls`. One breaker is shared across the dials, as the runtime's is.
// ---------------------------------------------------------------------------
describe('the carrier refusal breaker', () => {
  const carrierRefused = () => refusal('telephony_init_failed', new Error('Plivo create call error 403: {"error":"geo"}'));
  const notSentFor = (reason: 'configuration' | 'destination' | 'network') =>
    refusal('carrier_dial_not_sent', new CarrierDialNotSentError('plivo', reason, 'x'));

  it('pauses the campaign `carrier_refusing_calls` on the fifth carrier refusal in a row, audited, and not before', async () => {
    expect(CARRIER_REFUSAL_BREAKER_THRESHOLD).toBe(5);
    const breaker = new CarrierRefusalBreaker(null, '');
    for (let i = 1; i < CARRIER_REFUSAL_BREAKER_THRESHOLD; i++) await dialWith(carrierRefused(), breaker);
    expect(repos.campaign.pauseForCarrierAccount).not.toHaveBeenCalled();
    await dialWith(carrierRefused(), breaker);
    expect(repos.campaign.pauseForCarrierAccount).toHaveBeenCalledTimes(1);
    expect(repos.campaign.pauseForCarrierAccount).toHaveBeenCalledWith('camp-1', 'carrier_refusing_calls');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'agency_campaign.auto_paused',
      actor: 'system:carrier-refusals',
      eventData: expect.objectContaining({ campaign_id: 'camp-1', reason: 'carrier_refusing_calls' }),
    }));
  });

  it('a placed call breaks the streak', async () => {
    const breaker = new CarrierRefusalBreaker(null, '');
    for (let i = 1; i < CARRIER_REFUSAL_BREAKER_THRESHOLD; i++) await dialWith(carrierRefused(), breaker);
    await dialWith(undefined, breaker);
    for (let i = 1; i < CARRIER_REFUSAL_BREAKER_THRESHOLD; i++) await dialWith(carrierRefused(), breaker);
    expect(repos.campaign.pauseForCarrierAccount).not.toHaveBeenCalled();
  });

  it('a dial not sent for the carrier`s configuration counts, uncharged; the one that trips it returns its contact at once', async () => {
    const breaker = new CarrierRefusalBreaker(null, '');
    for (let i = 1; i < CARRIER_REFUSAL_BREAKER_THRESHOLD; i++) await dialWith(notSentFor('configuration'), breaker);
    expect(repos.campaign.pauseForCarrierAccount).not.toHaveBeenCalled();
    expectUncharged();
    repos.contact.unclaim.mockClear();
    await dialWith(notSentFor('configuration'), breaker);
    expect(repos.campaign.pauseForCarrierAccount).toHaveBeenCalledWith('camp-1', 'carrier_refusing_calls');
    expect((repos.contact.unclaim.mock.calls[0]![1] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expectUncharged();
  });

  it.each([
    ['a 401 (paused on its own reason)', () => refusal('carrier_auth_rejected', new CarrierAuthRejectedError('plivo', 401))],
    ['a rate limit', () => refusal('carrier_rate_limited', new CarrierRateLimitedError('plivo', 'carrier', 0))],
    ['an unknown outcome', () => refusal('telephony_init_failed', new CarrierRequestTimeoutError('Plivo create call', 15_000, true))],
    ['the contact`s malformed number', () => notSentFor('destination')],
    ['the API unreachable', () => notSentFor('network')],
  ])('%s does not count', async (_what, make) => {
    const breaker = new CarrierRefusalBreaker(null, '');
    for (let i = 0; i < CARRIER_REFUSAL_BREAKER_THRESHOLD + 1; i++) await dialWith(make(), breaker);
    expect(repos.campaign.pauseForCarrierAccount.mock.calls.filter(([, r]: any[]) => r === 'carrier_refusing_calls')).toEqual([]);
  });

  it('a number the carrier cannot dial suppresses the contact `invalid`, uncharged, instead of holding it a minute for ever', async () => {
    await dialWith(notSentFor('destination'));
    expect(repos.contact.markState).toHaveBeenCalledWith('contact-1', 'suppressed', { suppressed_reason: 'invalid' });
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
    expect(repos.campaign.pauseForCarrierAccount).not.toHaveBeenCalled();
    expectUncharged();
  });

  it('a dial not sent because the API was unreachable still holds the contact a minute', async () => {
    const before = Date.now();
    await dialWith(notSentFor('network'));
    expect(repos.contact.markState).not.toHaveBeenCalled();
    expect((repos.contact.unclaim.mock.calls[0]![1] as Date).getTime()).toBeGreaterThanOrEqual(before + PRE_CARRIER_FAILURE_REDIAL_DELAY_MS);
  });

  it('a campaign on the service`s own account (no credential) is never paused by it', async () => {
    const breaker = new CarrierRefusalBreaker(null, '');
    const own = { ...CAMPAIGN, telephony_provider: 'voicelink', telephony_credential_id: null };
    for (let i = 0; i < CARRIER_REFUSAL_BREAKER_THRESHOLD + 1; i++) await dialWith(carrierRefused(), breaker, own);
    expect(repos.campaign.pauseForCarrierAccount).not.toHaveBeenCalled();
  });
});
