import { describe, expect, it } from 'vitest';
import {
  AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS,
  AGENCY_AGENT_CALLER_ID_ERROR_CODES,
  AGENCY_CALLER_ID_DEDICATED_CODE,
} from '../src/api/agency/agent-caller-id';

/**
 * SNAPSHOTS, written out by hand. The code list is held equal to its union at type level
 * (`AllListed` in the source); this pins the order and the audit vocabulary (DN9, DN10).
 */
describe('dedicated caller ID vocabularies', () => {
  it('error codes', () => {
    expect([...AGENCY_AGENT_CALLER_ID_ERROR_CODES]).toEqual([
      'assignment_disabled',
      'caller_id_invalid',
      'campaign_not_found',
      'agent_not_staffed',
      'caller_id_not_in_campaign',
      'caller_id_taken',
    ]);
    expect(new Set(AGENCY_AGENT_CALLER_ID_ERROR_CODES).size).toBe(AGENCY_AGENT_CALLER_ID_ERROR_CODES.length);
  });

  it('the campaign PATCH refusal and the audit actions', () => {
    expect(AGENCY_CALLER_ID_DEDICATED_CODE).toBe('caller_id_dedicated');
    expect(AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS).toEqual({
      set: 'agency_campaign.agent_caller_id_set',
      cleared: 'agency_campaign.agent_caller_id_cleared',
    });
  });
});
