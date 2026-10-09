/**
 * Bridge analysis hooks — the enqueue-gate test, against the seam implementation.
 *
 * The gate ladder is driven through
 * `createBridgeAnalysisHooks().onCallFinalized(facts)` with the facts the bridge hands
 * over (docs/seams.md). The gates:
 *  - feature off (no config.dialerAnalysis) ⇒ NULL analysis_status, no enqueue.
 *  - flag off ⇒ NULL, no enqueue.
 *  - not answered / too short / no consent ⇒ analysis_status='skipped', no enqueue.
 *  - all gates pass ⇒ enqueue with the snapshotted profile; recording present ⇒ wake.
 *  - profile resolution: explicit id → account default → common-only.
 *  - enqueue failure never reaches the bridge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    dialerAnalysis: { enabled: true, minTalkTimeSeconds: 10, settleSeconds: 15 } as Record<string, unknown> | undefined,
  },
}));
vi.mock('../../../src/config/index.js', () => ({ config: mockConfig }));

const { mockRepo } = vi.hoisted(() => ({
  mockRepo: { findById: vi.fn(), update: vi.fn().mockResolvedValue(null) },
}));
/*
 * Spread the real module: `analysisFlagFor` lives beside the repository, and the gate
 * under test calls it to choose the flag. Stubbing it would make the flag assertions
 * verify this file's copy of the mapping instead of the one that ships.
 */
vi.mock('@magick-agency/db/repositories/agency-call.repository', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  webrtcCallRepository: mockRepo,
}));

const { mockAccountSettings } = vi.hoisted(() => ({
  mockAccountSettings: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({ accountSettingsRepository: mockAccountSettings }));

const { mockJobRepo, mockProfileRepo } = vi.hoisted(() => ({
  mockJobRepo: {
    enqueueFromCall: vi.fn().mockResolvedValue({ id: 'job-1', status: 'queued' }),
    markRecordingReady: vi.fn(),
  },
  mockProfileRepo: { findById: vi.fn().mockResolvedValue(null), findDefault: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@magick-agency/db/repositories/dialer-analysis-job.repository', () => ({ dialerAnalysisJobRepository: mockJobRepo }));
vi.mock('@magick-agency/db/repositories/call-analysis-profile.repository', () => ({ callAnalysisProfileRepository: mockProfileRepo }));

const { mockCreateTranscriber, mockGetWorker, mockWorker } = vi.hoisted(() => ({
  mockCreateTranscriber: vi.fn().mockReturnValue({ provider: 'gemini' }),
  mockWorker: { wake: vi.fn() },
  mockGetWorker: vi.fn(),
}));
vi.mock('../../../src/transcription/index.js', () => ({ createTranscriber: mockCreateTranscriber }));
vi.mock('../../../src/core/dialer-analysis-worker-handle.js', () => ({ getDialerAnalysisWorker: mockGetWorker }));

const { mockFlagService } = vi.hoisted(() => ({
  mockFlagService: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => mockFlagService,
}));

import { createBridgeAnalysisHooks } from '../../../src/analysis/bridge-analysis-hooks.js';
import { setBridgeAnalysisHooks, getBridgeAnalysisHooks, resetBridgeAnalysisHooks, type BridgeCallFinalizedFacts } from '../../../src/seams/bridge-analysis-hooks.js';

/** The persisted call row the hook reads back via findById. */
function callRow(over: Record<string, unknown> = {}) {
  return {
    id: 'call-1', tenant_id: 't1', account_id: 'a1', provider: 'voicelink',
    destination_phone: '+14155550199', status: 'completed',
    recording_requested: true, recording_url: 'https://rec/1.wav', recording_duration_seconds: 60,
    talk_time_seconds: 60, answered_at: new Date(), ended_at: new Date(),
    analysis_profile_id: null, analysis_language: null, analysis_status: null,
    campaign_id: 'camp-1', agency_attempt_id: 'att-1',
    ...over,
  };
}

/** The facts the bridge hands the seam at finalize (docs/seams.md). */
function facts(over: Partial<BridgeCallFinalizedFacts> = {}): BridgeCallFinalizedFacts {
  return {
    callId: 'call-1', tenantId: 't1', accountId: 'a1', campaignId: 'camp-1',
    answeredAt: new Date(Date.now() - 30_000), talkTimeSeconds: 30,
    ...over,
  };
}

const hooks = createBridgeAnalysisHooks();

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.dialerAnalysis = { enabled: true, minTalkTimeSeconds: 10, settleSeconds: 15 };
  mockCreateTranscriber.mockReturnValue({ provider: 'gemini' });
  mockFlagService.isEnabled.mockResolvedValue(true);
  mockProfileRepo.findById.mockResolvedValue(null);
  mockProfileRepo.findDefault.mockResolvedValue(null);
  mockJobRepo.enqueueFromCall.mockResolvedValue({ id: 'job-1', status: 'queued' });
  mockGetWorker.mockReturnValue(mockWorker);
  mockRepo.findById.mockResolvedValue(callRow());
  mockRepo.update.mockResolvedValue(null);
});

describe('bridge analysis hooks — onCallFinalized gate', () => {
  it('all gates pass ⇒ enqueue with the account-default profile snapshot; wakes worker', async () => {
    mockProfileRepo.findDefault.mockResolvedValue({
      id: 'prof-default', context: 'collections', custom_dimensions: [{ key: 'ptp', description: 'd', type: 'boolean' }], language_hint: 'en-IN',
    });

    await hooks.onCallFinalized(facts());

    expect(mockJobRepo.enqueueFromCall).toHaveBeenCalledWith(expect.objectContaining({
      call_id: 'call-1',
      profile_id: 'prof-default',
      profile_snapshot: { context: 'collections', custom_dimensions: [{ key: 'ptp', description: 'd', type: 'boolean' }], language_hint: 'en-IN' },
      analysis_language: 'en-IN',
    }));
    expect(mockWorker.wake).toHaveBeenCalledOnce();
    expect(mockRepo.update).not.toHaveBeenCalledWith('call-1', { analysis_status: 'skipped' });
  });

  it('enqueues exactly the documented payload for an agency call (nothing extra)', async () => {
    mockProfileRepo.findDefault.mockResolvedValue({
      id: 'prof-default', context: 'collections', custom_dimensions: [{ key: 'ptp', description: 'd', type: 'boolean' }], language_hint: 'en-IN',
    });
    await hooks.onCallFinalized(facts());
    expect(mockJobRepo.enqueueFromCall.mock.calls[0]![0]).toEqual({
      call_id: 'call-1',
      profile_id: 'prof-default',
      profile_snapshot: {
        context: 'collections',
        custom_dimensions: [{ key: 'ptp', description: 'd', type: 'boolean' }],
        language_hint: 'en-IN',
      },
      analysis_language: 'en-IN',
    });
  });

  it('explicit analysis_profile_id (stamped on the row at dial time) wins over the account default (M1)', async () => {
    mockRepo.findById.mockResolvedValue(callRow({ analysis_profile_id: 'prof-explicit', analysis_language: 'hi-IN' }));
    // The profile row carries its owner, which the hook checks (see the owned-by case below).
    mockProfileRepo.findById.mockResolvedValue({ id: 'prof-explicit', tenant_id: 't1', account_id: 'a1', context: 'renewals', custom_dimensions: [], language_hint: 'hi-IN' });
    mockProfileRepo.findDefault.mockResolvedValue({ id: 'prof-default', context: 'x', custom_dimensions: [], language_hint: 'en-IN' });

    await hooks.onCallFinalized(facts());

    expect(mockProfileRepo.findById).toHaveBeenCalledWith('prof-explicit');
    expect(mockProfileRepo.findDefault).not.toHaveBeenCalled();
    expect(mockJobRepo.enqueueFromCall).toHaveBeenCalledWith(expect.objectContaining({ profile_id: 'prof-explicit', analysis_language: 'hi-IN' }));
  });

  it.each([
    ['another tenant', { tenant_id: 't2', account_id: 'a1' }],
    ['another account of the same tenant', { tenant_id: 't1', account_id: 'a2' }],
  ])('a stamped profile id owned by %s is never snapshotted — the account default is used', async (_label, owner) => {
    mockRepo.findById.mockResolvedValue(callRow({ analysis_profile_id: 'prof-foreign' }));
    mockProfileRepo.findById.mockResolvedValue({ id: 'prof-foreign', ...owner, context: 'FOREIGN', custom_dimensions: [{ key: 'leak', description: 'd', type: 'boolean' }], language_hint: 'fr-FR' });
    mockProfileRepo.findDefault.mockResolvedValue({ id: 'prof-default', tenant_id: 't1', account_id: 'a1', context: null, custom_dimensions: [], language_hint: null });

    await hooks.onCallFinalized(facts());

    expect(mockProfileRepo.findDefault).toHaveBeenCalledWith('t1', 'a1');
    const enqueued = mockJobRepo.enqueueFromCall.mock.calls[0]![0];
    expect(enqueued.profile_id).toBe('prof-default');
    expect(JSON.stringify(enqueued)).not.toContain('FOREIGN');
    expect(JSON.stringify(enqueued)).not.toContain('fr-FR');
  });

  it('an explicit id that no longer resolves falls back to the account default', async () => {
    mockRepo.findById.mockResolvedValue(callRow({ analysis_profile_id: 'prof-gone' }));
    mockProfileRepo.findById.mockResolvedValue(null);
    mockProfileRepo.findDefault.mockResolvedValue({ id: 'prof-default', context: null, custom_dimensions: [], language_hint: null });
    await hooks.onCallFinalized(facts());
    expect(mockProfileRepo.findDefault).toHaveBeenCalledWith('t1', 'a1');
    expect(mockJobRepo.enqueueFromCall).toHaveBeenCalledWith(expect.objectContaining({ profile_id: 'prof-default' }));
  });

  it('no profile at all ⇒ common-only snapshot (empty custom_dimensions)', async () => {
    await hooks.onCallFinalized(facts());
    expect(mockJobRepo.enqueueFromCall).toHaveBeenCalledWith(expect.objectContaining({
      profile_id: null,
      profile_snapshot: { custom_dimensions: [] },
    }));
  });

  it('feature off (no config.dialerAnalysis) ⇒ NULL, no enqueue, no skip write', async () => {
    mockConfig.dialerAnalysis = undefined;
    await hooks.onCallFinalized(facts());
    expect(mockJobRepo.enqueueFromCall).not.toHaveBeenCalled();
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('feature configured but disabled, or no constructible transcriber ⇒ NULL, no enqueue', async () => {
    mockConfig.dialerAnalysis = { enabled: false, minTalkTimeSeconds: 10, settleSeconds: 15 };
    await hooks.onCallFinalized(facts());
    mockConfig.dialerAnalysis = { enabled: true, minTalkTimeSeconds: 10, settleSeconds: 15 };
    mockCreateTranscriber.mockReturnValue(null);
    await hooks.onCallFinalized(facts());
    expect(mockJobRepo.enqueueFromCall).not.toHaveBeenCalled();
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('flag off ⇒ NULL, no enqueue, no skip write', async () => {
    mockFlagService.isEnabled.mockResolvedValue(false);
    await hooks.onCallFinalized(facts());
    expect(mockJobRepo.enqueueFromCall).not.toHaveBeenCalled();
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('unanswered ⇒ analysis_status=skipped, no enqueue', async () => {
    await hooks.onCallFinalized(facts({ answeredAt: null, talkTimeSeconds: 0 }));
    expect(mockRepo.update).toHaveBeenCalledWith('call-1', { analysis_status: 'skipped' });
    expect(mockJobRepo.enqueueFromCall).not.toHaveBeenCalled();
  });

  it('talk-time below the floor ⇒ skipped', async () => {
    await hooks.onCallFinalized(facts({ talkTimeSeconds: 2 }));
    expect(mockRepo.update).toHaveBeenCalledWith('call-1', { analysis_status: 'skipped' });
    expect(mockJobRepo.enqueueFromCall).not.toHaveBeenCalled();
  });

  it('talk-time exactly at the floor is enough', async () => {
    await hooks.onCallFinalized(facts({ talkTimeSeconds: 10 }));
    expect(mockJobRepo.enqueueFromCall).toHaveBeenCalledOnce();
  });

  it('no consent (recording not requested) ⇒ skipped', async () => {
    mockRepo.findById.mockResolvedValue(callRow({ recording_requested: false }));
    await hooks.onCallFinalized(facts());
    expect(mockRepo.update).toHaveBeenCalledWith('call-1', { analysis_status: 'skipped' });
    expect(mockJobRepo.enqueueFromCall).not.toHaveBeenCalled();
  });

  it('a failing skip write is logged, not thrown', async () => {
    mockRepo.update.mockRejectedValue(new Error('db'));
    await expect(hooks.onCallFinalized(facts({ answeredAt: null }))).resolves.toBeUndefined();
  });

  it('a call row that vanished ⇒ nothing happens', async () => {
    mockRepo.findById.mockResolvedValue(null);
    await hooks.onCallFinalized(facts());
    expect(mockJobRepo.enqueueFromCall).not.toHaveBeenCalled();
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('recording NOT yet present ⇒ enqueue as awaiting, worker NOT woken', async () => {
    mockRepo.findById.mockResolvedValue(callRow({ recording_url: null }));
    mockJobRepo.enqueueFromCall.mockResolvedValue({ id: 'job-1', status: 'awaiting_recording' });
    await hooks.onCallFinalized(facts());
    expect(mockJobRepo.enqueueFromCall).toHaveBeenCalledOnce();
    expect(mockWorker.wake).not.toHaveBeenCalled();
  });

  it('no registered worker is fine', async () => {
    mockGetWorker.mockReturnValue(null);
    await expect(hooks.onCallFinalized(facts())).resolves.toBeUndefined();
  });

  it('enqueue failure never reaches the bridge (the seam says catch and log)', async () => {
    mockJobRepo.enqueueFromCall.mockRejectedValue(new Error('db down'));
    await expect(hooks.onCallFinalized(facts())).resolves.toBeUndefined();
  });

  it('a flag-service failure never reaches the bridge either', async () => {
    mockFlagService.isEnabled.mockRejectedValue(new Error('redis down'));
    await expect(hooks.onCallFinalized(facts())).resolves.toBeUndefined();
    expect(mockJobRepo.enqueueFromCall).not.toHaveBeenCalled();
  });
});

describe('bridge analysis hooks — agency gate 2 (product flag) and deleted gate 3', () => {
  /** Flag keys the gate actually asked about. */
  function checkedFlagKeys(): string[] {
    return mockFlagService.isEnabled.mock.calls
      .map((c) => (c[0] as { key?: string } | undefined)?.key)
      .filter((k): k is string => typeof k === 'string');
  }

  it('gates on agency_call_analysis, resolved for {tenant, account}', async () => {
    await hooks.onCallFinalized(facts());
    expect(checkedFlagKeys()).toEqual(['agency_call_analysis']);
    expect(mockFlagService.isEnabled.mock.calls[0]![1]).toEqual({ tenantId: 't1', accountId: 'a1' });
    expect(mockJobRepo.enqueueFromCall).toHaveBeenCalledTimes(1);
  });

  it('agency flag off ⇒ no job, and no skip write (feature absent, not declined)', async () => {
    mockFlagService.isEnabled.mockImplementation(async (flag: { key?: string }) => flag?.key !== 'agency_call_analysis');
    await hooks.onCallFinalized(facts());
    expect(mockJobRepo.enqueueFromCall).not.toHaveBeenCalled();
    expect(mockRepo.update).not.toHaveBeenCalledWith('call-1', { analysis_status: 'skipped' });
  });

  it('never consults a softphone flag: the dialer flag cannot stop an agency job', async () => {
    mockFlagService.isEnabled.mockImplementation(async (flag: { key?: string }) => flag?.key !== 'dialer_call_analysis');
    await hooks.onCallFinalized(facts());
    expect(checkedFlagKeys()).not.toContain('dialer_call_analysis');
    expect(mockJobRepo.enqueueFromCall).toHaveBeenCalledTimes(1);
  });

  it('gate 3 is deleted: account settings are never read on the analysis path', async () => {
    await hooks.onCallFinalized(facts());
    for (const fn of Object.values(mockAccountSettings)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('bridge analysis hooks — onRecordingReady', () => {
  it('no-op when dialer analysis is unconfigured', async () => {
    mockConfig.dialerAnalysis = undefined;
    await hooks.onRecordingReady('call-1');
    expect(mockJobRepo.markRecordingReady).not.toHaveBeenCalled();
  });

  it('no-op when dialer analysis is configured but disabled', async () => {
    mockConfig.dialerAnalysis = { enabled: false, minTalkTimeSeconds: 10, settleSeconds: 15 };
    await hooks.onRecordingReady('call-1');
    expect(mockJobRepo.markRecordingReady).not.toHaveBeenCalled();
  });

  it('promotes the waiting job with the settle delay and wakes the worker', async () => {
    mockJobRepo.markRecordingReady.mockResolvedValue({ id: 'job-1', status: 'queued' });
    await hooks.onRecordingReady('call-1');
    expect(mockJobRepo.markRecordingReady).toHaveBeenCalledWith('call-1', 15);
    expect(mockWorker.wake).toHaveBeenCalledOnce();
  });

  it('a duplicate (nothing promoted) does not wake the worker (C3)', async () => {
    mockJobRepo.markRecordingReady.mockResolvedValue(null);
    await hooks.onRecordingReady('call-1');
    expect(mockWorker.wake).not.toHaveBeenCalled();
  });

  it('swallows a repository failure (the bridge awaits this call)', async () => {
    mockJobRepo.markRecordingReady.mockRejectedValue(new Error('db'));
    await expect(hooks.onRecordingReady('call-1')).resolves.toBeUndefined();
    expect(mockWorker.wake).not.toHaveBeenCalled();
  });
});

describe('seam registration', () => {
  it('the implementation registers through setBridgeAnalysisHooks and the bridge reaches it through the getter', async () => {
    resetBridgeAnalysisHooks();
    const impl = createBridgeAnalysisHooks();
    setBridgeAnalysisHooks(impl);
    expect(getBridgeAnalysisHooks()).toBe(impl);
    await getBridgeAnalysisHooks().onCallFinalized(facts());
    expect(mockJobRepo.enqueueFromCall).toHaveBeenCalledOnce();
    resetBridgeAnalysisHooks();
  });
});
