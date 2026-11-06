import { describe, it, expect } from 'vitest';
import { AGENCY_AGENT_CALLER_ID_ERROR_CODES } from '@magick-agency/contracts/api/agency/agent-caller-id';
import {
  AGENT_CALLER_ID_REFUSAL_COPY,
  agentCallerIdRefusal,
  callerIdDedicatedMessage,
  dedicatedCallerIdsOf,
  myCallerIdLine,
} from '../../utils/agencyAgentCallerIdCopy';
import { ApiError } from '../../api/client';

/**
 * The dedicated caller ID copy: every refusal code the contract lists has words
 * (and nothing else does), the campaign PATCH's `caller_id_dedicated` is read off
 * its details and nothing else, and the numbers are shown formatted.
 */

describe('refusal copy', () => {
  it('is exhaustive over the contract’s codes', () => {
    expect(Object.keys(AGENT_CALLER_ID_REFUSAL_COPY).sort()).toEqual([...AGENCY_AGENT_CALLER_ID_ERROR_CODES].sort());
    for (const code of AGENCY_AGENT_CALLER_ID_ERROR_CODES) expect(AGENT_CALLER_ID_REFUSAL_COPY[code]).toBeTruthy();
  });

  it('never says a wire token to a supervisor', () => {
    for (const copy of Object.values(AGENT_CALLER_ID_REFUSAL_COPY)) expect(copy).not.toMatch(/_/);
  });

  it('names the holder of a taken number, trimmed', () => {
    const err = new ApiError(409, { code: 'caller_id_taken', details: { user_id: 'u', agent_name: ' Kiran ' } });
    expect(agentCallerIdRefusal(err, 'x'))
      .toBe('That number is already dedicated to Kiran. Pick another, or clear theirs first.');
  });

  it('falls back to the given text for an error with no message', () => {
    expect(agentCallerIdRefusal({}, 'Could not set that caller ID.')).toBe('Could not set that caller ID.');
  });
});

describe('the campaign PATCH’s caller_id_dedicated', () => {
  it('reads the dedicated numbers, and only off that code', () => {
    expect(dedicatedCallerIdsOf(new ApiError(409, {
      code: 'caller_id_dedicated', details: { caller_ids: ['+912200000001', 7] },
    }))).toEqual(['+912200000001']);
    expect(dedicatedCallerIdsOf(new ApiError(409, { code: 'caller_id_dedicated' }))).toEqual([]);
    expect(dedicatedCallerIdsOf(new ApiError(409, {
      code: 'mode_change_requires_pause', details: { caller_ids: ['+912200000001'] },
    }))).toBeNull();
    expect(dedicatedCallerIdsOf(new Error('boom'))).toBeNull();
  });

  it('names one number, several, or none', () => {
    expect(callerIdDedicatedMessage(['+912200000001']))
      .toBe('+91 22000 00001 is dedicated to an agent. Release it on the Agents tab first (“Use shared rotation”).');
    expect(callerIdDedicatedMessage(['+912200000001', '+912200000002', '+14155550100']))
      .toBe('+91 22000 00001, +91 22000 00002 and +14155550100 are dedicated to agents. Release them on the Agents tab first (“Use shared rotation”).');
    expect(callerIdDedicatedMessage([]))
      .toBe('A number you removed is dedicated to an agent. Release it on the Agents tab first (“Use shared rotation”).');
  });
});

describe('My contacts', () => {
  it('says which number the agent’s calls go from', () => {
    expect(myCallerIdLine('+912200000001')).toBe('Calls to your contacts on this campaign go from +91 22000 00001.');
  });
});
