import { describe, expect, it } from 'vitest';
import {
  AGENT_CALLER_ID_MAX_LENGTH,
  agentCallerIdOf,
  agentCallerIdsBody,
  parseSetAgentCallerIdBody,
} from '../../../src/api/routes/proxy-agency-assignment/agent-caller-ids.js';

/*
 * The dedicated caller ID routes' pure halves (DN5): the PUT body's validation and the GET
 * body. The routes end to end, with every refusal, the flag and the audit rows, are
 * `test/integration/api/agency-agent-caller-ids.test.ts`.
 */

const SET_AT = new Date('2026-11-06T10:00:00Z');
const row = (user_id: string, caller_id: string) =>
  ({ campaign_id: 'camp-1', user_id, caller_id, set_by_user_id: 'sup-1', set_at: SET_AT });

describe('parseSetAgentCallerIdBody', () => {
  it('takes a number, trimmed', () => {
    expect(parseSetAgentCallerIdBody({ caller_id: '  +918041000001 ' })).toEqual({ ok: true, callerId: '+918041000001' });
    expect(parseSetAgentCallerIdBody({ caller_id: '9'.repeat(AGENT_CALLER_ID_MAX_LENGTH) }).ok).toBe(true);
  });

  it('refuses per field: missing, blank, not a string, too long, an unknown key, no body', () => {
    expect(parseSetAgentCallerIdBody({})).toEqual({ ok: false, details: { caller_id: 'is required' } });
    expect(parseSetAgentCallerIdBody({ caller_id: '   ' })).toEqual({ ok: false, details: { caller_id: 'must not be empty' } });
    expect(parseSetAgentCallerIdBody({ caller_id: 7 })).toEqual({ ok: false, details: { caller_id: 'must be a string' } });
    expect(parseSetAgentCallerIdBody({ caller_id: '9'.repeat(AGENT_CALLER_ID_MAX_LENGTH + 1) }))
      .toEqual({ ok: false, details: { caller_id: `must be at most ${AGENT_CALLER_ID_MAX_LENGTH} characters` } });
    expect(parseSetAgentCallerIdBody({ caller_id: '+918041000001', note: 'x' }))
      .toEqual({ ok: false, details: { note: 'is not a field of this request' } });
    expect(parseSetAgentCallerIdBody(undefined)).toEqual({ ok: false, details: { caller_id: 'is required' } });
    expect(parseSetAgentCallerIdBody('+918041000001').ok).toBe(false);
  });
});

describe('agentCallerIdOf / agentCallerIdsBody', () => {
  const POOL = ['+918041000001', '+918041000002', '+918041000003'];

  it('one row: in_campaign is "still one of the usable caller IDs"', () => {
    expect(agentCallerIdOf(row('u1', '+918041000002'), POOL, 'Asha')).toEqual({
      campaign_id: 'camp-1', user_id: 'u1', agent_name: 'Asha', caller_id: '+918041000002', in_campaign: true,
      set_at: SET_AT.toISOString(), set_by_user_id: 'sup-1',
    });
    expect(agentCallerIdOf(row('u1', '+919999999999'), POOL, null).in_campaign).toBe(false);
  });

  it('orders by agent name (unnamed last), then user id; the rotation leaves the dedicated numbers out', () => {
    const body = agentCallerIdsBody(
      { id: 'camp-1', caller_ids: [...POOL, '  '] } as never,
      [row('u3', '+918041000003'), row('u2', '+918041000002'), row('u1', '+919999999999'), row('u0', '+918041000001')],
      new Map([['u3', 'Asha'], ['u2', 'Bina'], ['u0', null]]),
    );
    expect(body.dedicated.map((d) => d.user_id)).toEqual(['u3', 'u2', 'u0', 'u1']);
    expect(body.caller_ids).toEqual(POOL);
    // u0 holds the first number; with all three dedicated and in the campaign, the rotation is all of them.
    expect(body).toMatchObject({ campaign_id: 'camp-1', rotation: POOL, all_dedicated: true });
  });

  it('a dedication the campaign no longer has is listed but neither leaves the rotation nor counts as dedicated', () => {
    const body = agentCallerIdsBody(
      { id: 'camp-1', caller_ids: POOL } as never,
      [row('u1', '+918041000002'), row('u2', '+919999999999')],
      new Map(),
    );
    expect(body).toMatchObject({ rotation: ['+918041000001', '+918041000003'], all_dedicated: false });
    expect(body.dedicated.map((d) => [d.user_id, d.in_campaign])).toEqual([['u1', true], ['u2', false]]);
  });

  it('an empty pool is never all_dedicated', () => {
    expect(agentCallerIdsBody({ id: 'camp-1', caller_ids: [] } as never, [], new Map()))
      .toEqual({ campaign_id: 'camp-1', caller_ids: [], dedicated: [], rotation: [], all_dedicated: false });
  });
});
