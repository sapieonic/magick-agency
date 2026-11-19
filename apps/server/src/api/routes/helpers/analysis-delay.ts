/**
 * Why a call's `pending` summary is held up, for the call detail reads (the campaign attempt
 * and the soft-phone call's media leg). `formatWebRtcCallResponse` takes it as a required
 * argument; this reads it.
 */
import { createChildLogger } from '@magick-agency/observability';
import { dialerAnalysisJobRepository } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import type { WebRtcCallRecord } from '@magick-agency/db/models/agency-call.model';
import type { DialerAnalysisDelay } from '@magick-agency/contracts/api/agency/webrtc-call';

const log = createChildLogger({ component: 'analysis-delay' });

/**
 * Read from the analysis queue (`dialerAnalysisJobRepository.analysisDelayFor`) only for a
 * `pending` call, so a finished or never-analysed call costs no query. A failed read is
 * logged and answers null (the ordinary pending copy), never a failed call detail: the
 * delay is a better sentence about the call, not the call.
 */
export async function analysisDelayForRecord(
  record: Pick<WebRtcCallRecord, 'id' | 'tenant_id' | 'analysis_status'>,
): Promise<DialerAnalysisDelay | null> {
  if (record.analysis_status !== 'pending') return null;
  try {
    return await dialerAnalysisJobRepository.analysisDelayFor(record.id);
  } catch (err) {
    log.warn({ err, tenantId: record.tenant_id, callId: record.id },
      'Could not read why the call summary is waiting; answering the detail without it');
    return null;
  }
}
