/**
 * Dialer-analysis recording-race test (B1 / C3).
 *
 * The dangerous ordering: the recording webhook can land BEFORE the job row exists
 * (the carrier POSTs RecordStop before `endCall` enqueues). The design defends this
 * two ways, both exercised here against a faithful in-memory model of the repo's
 * guarded-SQL semantics:
 *
 *  - `markRecordingReady` guards `WHERE status='awaiting_recording'` (C3): a webhook
 *    with no job yet is a no-op; a duplicate webhook after the job is running/queued
 *    is a no-op — never a double re-queue.
 *  - `enqueueFromCall` derives `queued` vs `awaiting_recording` in-SQL FROM the call
 *    row's `recording_url` (B1): a recording that beat `endCall` lands the job
 *    straight in `queued`, so it is NEVER stuck in awaiting and NEVER expired.
 *  - The worker promotes (recording present) BEFORE it expires, so even a job that
 *    was enqueued awaiting and only later got its recording is rescued, not expired.
 */
/*
 * PORT NOTE (magick-agency): ported from core test/unit/core/dialer-analysis-race.test.ts
 * @4850d1d9 (4 -> 4). Only the model import path and the removed settlement fields
 * changed; the real-SQL counterpart is test/integration/flows/dialer-analysis-race.
 */
import { describe, it, expect } from 'vitest';
import type { DialerAnalysisJobRecord } from '@magick-agency/db/models/dialer-analysis-job.model';

/**
 * In-memory model of the dialer-analysis job repo's guarded semantics — only the
 * methods the recording race touches. Mirrors the real SQL guards exactly.
 */
class InMemoryJobs {
  jobs = new Map<string, DialerAnalysisJobRecord>();
  private seq = 0;

  /** Derives queued vs awaiting_recording from the call's recording_url (B1). ON CONFLICT no-op. */
  enqueueFromCall(callId: string, recordingUrl: string | null, createdAt = new Date()): DialerAnalysisJobRecord | null {
    const existing = [...this.jobs.values()].find((j) => j.call_id === callId);
    if (existing) return existing; // ON CONFLICT (call_id) DO NOTHING
    const job: DialerAnalysisJobRecord = {
      id: `job-${++this.seq}`, call_id: callId, tenant_id: 't', account_id: 'a',
      profile_id: null, profile_snapshot: null, analysis_language: null,
      status: recordingUrl ? 'queued' : 'awaiting_recording',
      attempts: 0, attempts_total: 0, claim_generation: 0,
      claimed_at: null, heartbeat_at: null, next_attempt_at: null,
      analysis_audio_seconds: null,
      error_code: null, error_message: null, created_at: createdAt, updated_at: createdAt,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  /** Guarded WHERE status='awaiting_recording' (C3). Returns the promoted job or null. */
  markRecordingReady(callId: string): DialerAnalysisJobRecord | null {
    const job = [...this.jobs.values()].find((j) => j.call_id === callId);
    if (!job || job.status !== 'awaiting_recording') return null;
    job.status = 'queued';
    return job;
  }

  /** Promote awaiting → queued where the call now has a recording (B1). Count promoted. */
  promoteRecordingReady(hasRecording: (callId: string) => boolean): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'awaiting_recording' && hasRecording(j.call_id)) { j.status = 'queued'; n++; }
    }
    return n;
  }

  /** Expire awaiting older than cutoff with NO recording (runs AFTER promote). */
  expireAwaitingRecording(olderThan: Date, hasRecording: (callId: string) => boolean): DialerAnalysisJobRecord[] {
    const out: DialerAnalysisJobRecord[] = [];
    for (const j of this.jobs.values()) {
      if (j.status === 'awaiting_recording' && j.created_at < olderThan && !hasRecording(j.call_id)) {
        j.status = 'expired'; j.error_code = 'RECORDING_NEVER_ARRIVED'; out.push(j);
      }
    }
    return out;
  }
}

describe('dialer-analysis recording race', () => {
  it('webhook BEFORE the job row exists ⇒ enqueue derives queued, never awaiting/expired (B1)', () => {
    const repo = new InMemoryJobs();
    const recordings = new Map<string, string>();

    // 1. Recording webhook fires first — no job row yet.
    recordings.set('call-1', 'https://rec/1.wav');
    const promoted = repo.markRecordingReady('call-1');
    expect(promoted).toBeNull(); // guarded no-op — nothing to promote yet

    // 2. endCall enqueues, reading the (already-present) recording_url from the call row.
    const job = repo.enqueueFromCall('call-1', recordings.get('call-1') ?? null);
    expect(job?.status).toBe('queued'); // B1 — straight to queued, never awaiting

    // 3. Even a late expiry sweep can never touch it (it isn't awaiting).
    const expired = repo.expireAwaitingRecording(new Date(Date.now() + 1e9), (id) => recordings.has(id));
    expect(expired).toHaveLength(0);
    expect(repo.jobs.get(job!.id)!.status).toBe('queued');
  });

  it('duplicate webhooks after the job is queued are no-ops (C3)', () => {
    const repo = new InMemoryJobs();
    // Job already awaiting (enqueued before the recording).
    const job = repo.enqueueFromCall('call-2', null)!;
    expect(job.status).toBe('awaiting_recording');

    // First webhook promotes it.
    expect(repo.markRecordingReady('call-2')?.status).toBe('queued');
    // Duplicate webhooks find status !== awaiting_recording → no-op (no re-queue).
    expect(repo.markRecordingReady('call-2')).toBeNull();
    expect(repo.markRecordingReady('call-2')).toBeNull();
    expect(repo.jobs.get(job.id)!.status).toBe('queued');
  });

  it('promotion rescues a lost-wake awaiting job before expiry (B1 ordering)', () => {
    const repo = new InMemoryJobs();
    const recordings = new Map<string, string>();
    // Enqueued awaiting an hour ago (older than any wait window).
    const job = repo.enqueueFromCall('call-3', null, new Date(Date.now() - 3600_000))!;
    // The recording arrived but the wake was lost (markRecordingReady never ran).
    recordings.set('call-3', 'https://rec/3.wav');

    // Worker tick: promote BEFORE expire.
    const promotedCount = repo.promoteRecordingReady((id) => recordings.has(id));
    const expired = repo.expireAwaitingRecording(new Date(Date.now() - 1800_000), (id) => recordings.has(id));

    expect(promotedCount).toBe(1);
    expect(expired).toHaveLength(0); // promotion already moved it out of awaiting
    expect(repo.jobs.get(job.id)!.status).toBe('queued');
  });

  it('a genuinely undelivered recording still expires after the wait window', () => {
    const repo = new InMemoryJobs();
    const recordings = new Map<string, string>(); // never arrives
    const job = repo.enqueueFromCall('call-4', null, new Date(Date.now() - 3600_000))!;

    repo.promoteRecordingReady((id) => recordings.has(id)); // nothing to promote
    const expired = repo.expireAwaitingRecording(new Date(Date.now() - 1800_000), (id) => recordings.has(id));

    expect(expired.map((j) => j.id)).toEqual([job.id]);
    expect(repo.jobs.get(job.id)!.status).toBe('expired');
    expect(repo.jobs.get(job.id)!.error_code).toBe('RECORDING_NEVER_ARRIVED');
  });
});
