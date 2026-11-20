import type { DialerAnalysisJobRecord } from '@magick-agency/db/models/dialer-analysis-job.model';

/**
 * A dialer-analysis job row as the repository returns it: a queued job never claimed,
 * tried or refused, with every column the model has. Suites override what they test,
 * so a new column is added here once rather than in each suite's factory.
 */
export function makeJobRecord(over: Partial<DialerAnalysisJobRecord> = {}): DialerAnalysisJobRecord {
  return {
    id: 'job-1', call_id: 'call-1', tenant_id: 'ten-1', account_id: 'acc-1',
    profile_id: null, profile_snapshot: null, analysis_language: null,
    status: 'queued', attempts: 0, attempts_total: 0, claim_generation: 0,
    claimed_at: null, heartbeat_at: null, next_attempt_at: null,
    analysis_audio_seconds: null,
    error_code: null, error_message: null, vendor_refused_at: null, completed_at: null,
    created_at: new Date(), updated_at: new Date(),
    ...over,
  };
}
