import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The contact-assignment clients: every route in the contract header, its
 * method, path and body, and the agent list's query encoding (repeated
 * `bucket`, blanks dropped), with the tenant and account headers passed through.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../api/client', () => ({ apiFetch: mocks.apiFetch, ApiError: class extends Error {} }));

import {
  clearAgentCallerId,
  commitAssignment,
  getAgentCallerIds,
  getAssignmentProgress,
  getContactAssignmentHistory,
  getMyContactsSummary,
  listMyContacts,
  previewAssignment,
  setAgentCallerId,
} from '../../api/agencyAssignment';
import { callMyContact, retryMyContacts } from '../../api/agencyMyContacts';

const BASE = '/proxy/agency';

function lastCall() {
  const [url, init, tenantId, accountId] = mocks.apiFetch.mock.lastCall!;
  return { url: String(url), init: init as RequestInit, tenantId, accountId };
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockResolvedValue({});
});

describe('supervisor routes', () => {
  it('previews and commits an operation', async () => {
    await previewAssignment('camp-1', { kind: 'rebalance', agent_user_ids: ['a', 'b'] }, 't', 'acc');
    let call = lastCall();
    expect(call.url).toContain(`${BASE}/campaigns/camp-1/assignments/preview`);
    expect(call.init.method).toBe('POST');
    expect(JSON.parse(call.init.body as string)).toEqual({ kind: 'rebalance', agent_user_ids: ['a', 'b'] });
    expect([call.tenantId, call.accountId]).toEqual(['t', 'acc']);

    await commitAssignment('camp-1', { operation: { kind: 'unassign', from_user_id: 'a' }, preview_token: 'tok' }, 't', 'acc');
    call = lastCall();
    expect(call.url.endsWith(`${BASE}/campaigns/camp-1/assignments`)).toBe(true);
    expect(JSON.parse(call.init.body as string)).toEqual({
      operation: { kind: 'unassign', from_user_id: 'a' }, preview_token: 'tok',
    });
  });

  it('reads progress (with an optional absence threshold) and a contact’s history', async () => {
    await getAssignmentProgress('camp-1', {}, 't', 'acc');
    expect(lastCall().url.endsWith(`${BASE}/campaigns/camp-1/assignments/progress`)).toBe(true);
    await getAssignmentProgress('camp-1', { absentAfterMinutes: 30 }, 't', 'acc');
    expect(lastCall().url.endsWith('/assignments/progress?absent_after_minutes=30')).toBe(true);
    await getContactAssignmentHistory('camp-1', 'c-1', 't', 'acc');
    expect(lastCall().url.endsWith(`${BASE}/campaigns/camp-1/contacts/c-1/assignments`)).toBe(true);
  });
});

describe('dedicated caller ID routes', () => {
  it('reads the campaign’s dedications, sets one with its body and clears one', async () => {
    await getAgentCallerIds('camp-1', 't', 'acc');
    let call = lastCall();
    expect(call.url.endsWith(`${BASE}/campaigns/camp-1/agent-caller-ids`)).toBe(true);
    expect(call.init.method).toBeUndefined();
    expect([call.tenantId, call.accountId]).toEqual(['t', 'acc']);

    await setAgentCallerId('camp-1', 'user-1', '+912200000001', 't', 'acc');
    call = lastCall();
    expect(call.url.endsWith(`${BASE}/campaigns/camp-1/agents/user-1/caller-id`)).toBe(true);
    expect(call.init.method).toBe('PUT');
    expect(JSON.parse(call.init.body as string)).toEqual({ caller_id: '+912200000001' });
    expect([call.tenantId, call.accountId]).toEqual(['t', 'acc']);

    await clearAgentCallerId('camp-1', 'user-1', 't', 'acc');
    call = lastCall();
    expect(call.url.endsWith(`${BASE}/campaigns/camp-1/agents/user-1/caller-id`)).toBe(true);
    expect(call.init.method).toBe('DELETE');
    expect(call.init.body).toBeUndefined();
  });
});

describe('agent routes', () => {
  it('reads the summary for a campaign', async () => {
    await getMyContactsSummary('camp-1', 't', 'acc');
    expect(lastCall().url.endsWith(`${BASE}/my-contacts/summary?campaign_id=camp-1`)).toBe(true);
  });

  it('lists with repeated buckets, a trimmed search and the cursor, dropping blanks', async () => {
    await listMyContacts({
      campaign_id: 'camp-1', bucket: ['callback', 'not_reached'], phone: ' 98 ', q: '', cursor: 'cur', limit: 25,
    }, 't', 'acc');
    const query = new URLSearchParams(lastCall().url.split('?')[1]);
    expect(lastCall().url).toContain(`${BASE}/my-contacts?`);
    expect(query.get('campaign_id')).toBe('camp-1');
    expect(query.getAll('bucket')).toEqual(['callback', 'not_reached']);
    expect(query.get('phone')).toBe('98');
    expect(query.has('q')).toBe(false);
    expect(query.get('cursor')).toBe('cur');
    expect(query.get('limit')).toBe('25');
  });

  it('retries and calls', async () => {
    await retryMyContacts({ campaign_id: 'camp-1', all: true }, 't', 'acc');
    expect(lastCall().url.endsWith(`${BASE}/my-contacts/retry`)).toBe(true);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ campaign_id: 'camp-1', all: true });

    await callMyContact('c-1', { campaign_id: 'camp-1', session_id: 's-1', override_note: 'Asked for 9pm call' }, 't', 'acc');
    expect(lastCall().url.endsWith(`${BASE}/my-contacts/c-1/call`)).toBe(true);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      campaign_id: 'camp-1', session_id: 's-1', override_note: 'Asked for 9pm call',
    });
  });
});
