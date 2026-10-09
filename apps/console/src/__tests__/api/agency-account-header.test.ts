import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Every agency call must send `X-Account-Id`.
 *
 * This is a regression pin, not a style check. `apiFetch` takes `accountId` as
 * its FOURTH argument, so omitting it is silent at every layer that could catch
 * it: TypeScript is happy (the parameter is optional), the server is happy (it
 * treats `X-Account-Id` as optional and simply omits `x-mgkvc-account` when
 * absent), and the failure surfaces only at the server, whose `authMiddleware`
 * requires the header on every authenticated route — as
 * `400 Missing required header: x-mgkvc-account`, masked by the server, naming
 * nothing in the console.
 *
 * That is exactly how the entire agency surface shipped non-functional: every
 * `apiFetch` call in `agency.ts` and `agencyCampaigns.ts` passed `tenantId` and
 * stopped. The multipart helpers were unaffected because they build headers by
 * hand — which is why a test that only covered CSV upload would have stayed
 * green through the whole outage.
 *
 * So this asserts the header on the `apiFetch`-based functions specifically, and
 * asserts it per-function rather than once: the bug was not one missing call
 * site, it was a missing argument repeated eighteen times.
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  currentUser: { getIdToken: () => Promise.resolve('tok') } as {
    getIdToken: () => Promise<string>;
  } | null,
}));

vi.stubGlobal('fetch', mocks.fetch);

vi.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: mocks.currentUser }),
}));

vi.mock('../../analytics/posthog', () => ({
  captureError: vi.fn(),
}));

import {
  createAgencyCampaign,
  listAgencyCampaigns,
  getAgencyCampaign,
  updateAgencyCampaign,
  getAgencyCampaignStats,
  transitionAgencyCampaign,
  getIngestLimits,
  getIngestJob,
  cancelIngestJob,
  startRosterIngest,
  analyzeRosterColumns,
} from '../../api/agencyCampaigns';
import {
  createAgencySession,
  mintStationToken,
  setAgentAvailable,
  leaveAgencySession,
  hangupAttempt,
  setAgentBreak,
  cancelQueuedBreak,
  submitDisposition,
  markContactDnc,
  saveAttemptNotes,
  getMyAssignment,
  getMyAssignments,
  listCampaignAgents,
  assignAgent,
  unassignAgent,
} from '../../api/agency';

const TENANT = '3944103f-e770-47a9-b00b-059fd192eded';
const ACCOUNT = '42f2551b-29ba-4c58-ab8a-5b72f1d7603c';

function okJson(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });
}

function headersOf(): Record<string, string> {
  const [, opts] = mocks.fetch.mock.calls[0]!;
  return (opts as RequestInit & { headers: Record<string, string> }).headers;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(okJson({ id: 'c1', updated_at: '2026-01-01T00:00:00Z' }));
});

/** Each entry invokes one exported function with tenant + account threaded. */
const CALLS: Array<[string, () => Promise<unknown>]> = [
  ['createAgencyCampaign', () => createAgencyCampaign({ name: 'x' }, TENANT, ACCOUNT)],
  ['listAgencyCampaigns', () => listAgencyCampaigns(TENANT, ACCOUNT)],
  ['getAgencyCampaign', () => getAgencyCampaign('c1', TENANT, ACCOUNT)],
  ['updateAgencyCampaign', () => updateAgencyCampaign('c1', { name: 'y' }, TENANT, ACCOUNT)],
  ['getAgencyCampaignStats', () => getAgencyCampaignStats('c1', TENANT, ACCOUNT)],
  ['transitionAgencyCampaign', () => transitionAgencyCampaign('c1', 'start', TENANT, ACCOUNT)],
  ['getIngestLimits', () => getIngestLimits(TENANT, ACCOUNT)],
  ['getIngestJob', () => getIngestJob('j1', TENANT, ACCOUNT)],
  ['cancelIngestJob', () => cancelIngestJob('j1', TENANT, ACCOUNT)],
  [
    'startRosterIngest',
    () => startRosterIngest({ s3_key: 'k', phone_column: 'phone' } as never, TENANT, ACCOUNT),
  ],
  ['analyzeRosterColumns', () => analyzeRosterColumns({ s3_key: 'k' }, TENANT, ACCOUNT)],
  ['createAgencySession', () => createAgencySession('c1', TENANT, ACCOUNT)],
  ['mintStationToken', () => mintStationToken('s1', TENANT, ACCOUNT)],
  ['setAgentAvailable', () => setAgentAvailable('s1', TENANT, ACCOUNT)],
  ['leaveAgencySession', () => leaveAgencySession('s1', TENANT, ACCOUNT)],
  ['hangupAttempt', () => hangupAttempt('a1', TENANT, ACCOUNT)],
  ['setAgentBreak', () => setAgentBreak('s1', 'lunch', TENANT, ACCOUNT)],
  ['cancelQueuedBreak', () => cancelQueuedBreak('s1', TENANT, ACCOUNT)],
  [
    'submitDisposition',
    () => submitDisposition('a1', { disposition_code: 'sale' }, TENANT, ACCOUNT),
  ],
  ['markContactDnc', () => markContactDnc('a1', {}, TENANT, ACCOUNT)],
  // The assignment routes. Handled by the server itself rather than proxied, but
  // they resolve the tenant from the same headers — `my-assignment` is read by
  // an `agent`, the one role with no other way to discover a campaign id, so a
  // missing header there is a dead end rather than a degraded page.
  ['getMyAssignment', () => getMyAssignment(TENANT, ACCOUNT)],
  // The plural replacement. Added to this table deliberately: it is the route the
  // agent home actually calls now, so it inherits the dead-end consequence the
  // comment above describes — and a new wrapper left out of this list is exactly
  // the omission this file exists to catch.
  ['getMyAssignments', () => getMyAssignments(TENANT, ACCOUNT)],
  ['listCampaignAgents', () => listCampaignAgents('c1', TENANT, ACCOUNT)],
  ['assignAgent', () => assignAgent('c1', 'u1', TENANT, ACCOUNT)],
  ['unassignAgent', () => unassignAgent('c1', 'u1', TENANT, ACCOUNT)],
  [
    'saveAttemptNotes',
    () =>
      saveAttemptNotes(
        { hydrated: true, notes: 'note', editSource: 'agent_edit', attemptId: 'a1' },
        TENANT,
        ACCOUNT,
      ),
  ],
];

describe('agency API — X-Account-Id is sent on every call', () => {
  it.each(CALLS)('%s sends both tenant and account headers', async (_name, invoke) => {
    await invoke();

    const headers = headersOf();
    expect(headers['X-Tenant-Id']).toBe(TENANT);
    expect(headers['X-Account-Id']).toBe(ACCOUNT);
  });
});

describe('agency API — the header is genuinely caller-supplied', () => {
  /**
   * Guards against a fix that hardcodes the header or reads it from module
   * state. If the value did not come from the argument, this passes for the
   * wrong reason and the multi-account case is broken in a way the suite above
   * cannot see.
   */
  it('forwards a different account id when given one', async () => {
    await listAgencyCampaigns(TENANT, 'other-account');

    expect(headersOf()['X-Account-Id']).toBe('other-account');
  });

  it('omits the header entirely when no account is selected', async () => {
    await listAgencyCampaigns(TENANT, undefined);

    // Not an endorsement of the request — it will 400 at the server. Asserted so the
    // no-account path stays visibly distinct from the fixed path, and so a UI
    // guard has something concrete to prevent.
    expect(headersOf()['X-Account-Id']).toBeUndefined();
  });
});

describe('getMyAssignment — 204 is the unassigned answer', () => {
  it('resolves null rather than undefined when the server says 204', async () => {
    // `apiFetch` returns `undefined` for a 204, and `undefined` is what a
    // forgotten `await` also looks like. Normalising here means every caller
    // branches on a value that can only mean one thing — nobody has staffed
    // this agent yet — instead of on a status code they cannot see.
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(getMyAssignment(TENANT, ACCOUNT)).resolves.toBeNull();
  });

  it('passes a real assignment straight through', async () => {
    mocks.fetch.mockResolvedValue(okJson({ campaign_id: 'c1', campaign_name: 'Renewals' }));

    await expect(getMyAssignment(TENANT, ACCOUNT)).resolves.toEqual({
      campaign_id: 'c1',
      campaign_name: 'Renewals',
    });
  });
});
