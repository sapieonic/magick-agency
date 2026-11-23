/*
 * The `?type=` of the public call lists (`docs/call-log.md` §7): the campaign Call log, the
 * account's All calls and the agent's My calls.
 */
import type { FastifyReply } from 'fastify';
import { AGENCY_CALL_LOG_TYPE_FILTERS } from '@magick-agency/contracts/api/agency/call-log';
import {
  callLogSourceForType,
  isCallLogTypeFilter,
  type CampaignCallLogSourceFilter,
} from '../../../agency/campaign-call-log.js';
import { replyValidationFailed } from './parse-or-400.js';

/** `?type=` (the public word) checked, and turned into the read's `source`. Null once it has replied 400. */
export function parseCallLogType(
  rawType: string | undefined,
  reply: FastifyReply,
): { source: CampaignCallLogSourceFilter | null } | null {
  if (rawType !== undefined && !isCallLogTypeFilter(rawType)) {
    void replyValidationFailed(reply, [
      { param: 'type', message: `must be one of: ${AGENCY_CALL_LOG_TYPE_FILTERS.join(', ')}` },
    ]);
    return null;
  }
  return { source: callLogSourceForType(rawType) };
}
