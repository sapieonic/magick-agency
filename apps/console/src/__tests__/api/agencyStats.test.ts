import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The per-agent stats routes.
 *
 * ── The two things a wrapper here can get wrong ────────────────────────────
 *  1. **Reaching the wrong route for the subject.** Every read exists twice: a
 *     `my-` form floored so a bare `agent` can call it and scoped to the caller
 *     server-side, and an `agents/:userId` twin floored at `agency.supervise`. The
 *     `my-` form takes NO subject — that is what makes it impossible for an agent
 *     to ask for somebody else's shift — so a wrapper that put an id on it, or
 *     that used the twin for "my own", would defeat the whole pairing.
 *  2. **`X-Account-Id`.** `apiFetch` takes it as the fourth argument, so omitting
 *     it is silent at every layer that could catch it and surfaces only at the server as
 *     `400 Missing required header: x-mgkvc-account`, masked by the server, naming
 *     nothing in the console. That is how the entire agency surface once shipped
 *     non-functional, so it is asserted per function rather than once.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../../api/client', () => ({ apiFetch: mocks.apiFetch }));

import { ENDPOINTS } from '../../config';
import {
  getAgencyGroupedStats,
  getAgencyRoster,
  getAgentAttempts,
  getAgentStats,
  getMyAttempts,
  getMyCampaigns,
  getMyStats,
} from '../../api/agencyStats';

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';
const QUERY = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-20T00:00:00.000Z',
  bucket: 'day' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({});
});

function url(): string {
  return mocks.apiFetch.mock.calls[0]![0] as string;
}

function headers(): [unknown, unknown] {
  const call = mocks.apiFetch.mock.calls[0]!;
  return [call[2], call[3]];
}

describe('getMyStats', () => {
  it('hits the subject-less my- route', async () => {
    await getMyStats(QUERY, TENANT, ACCOUNT);
    expect(url()).toContain('/proxy/agency/my-stats?');
    // No agent id anywhere: the server scopes it to the caller. A client that could
    // name the subject of its own stats read is a client that can ask for
    // somebody else's.
    expect(url()).not.toContain('agent_user_id');
    expect(url()).not.toContain('user_id');
  });

  it('sends the range and the bucket width', async () => {
    await getMyStats(QUERY, TENANT, ACCOUNT);
    expect(url()).toContain(`from=${encodeURIComponent(QUERY.from)}`);
    expect(url()).toContain(`to=${encodeURIComponent(QUERY.to)}`);
    expect(url()).toContain('bucket=day');
  });

  it('omits a blank campaign filter rather than sending an empty one', async () => {
    // `?campaign_id=` is what a cleared "all campaigns" selector holds, and
    // sending it reads as a filter matching nothing rather than as no filter.
    await getMyStats({ ...QUERY, campaign_id: '' }, TENANT, ACCOUNT);
    expect(url()).not.toContain('campaign_id');
  });

  it('sends a real campaign filter when there is one', async () => {
    await getMyStats({ ...QUERY, campaign_id: 'camp-1' }, TENANT, ACCOUNT);
    expect(url()).toContain('campaign_id=camp-1');
  });

  it('threads tenant and account through', async () => {
    await getMyStats(QUERY, TENANT, ACCOUNT);
    expect(headers()).toEqual([TENANT, ACCOUNT]);
  });
});

describe('getAgentStats', () => {
  it('hits the supervisor twin with the subject in the path', async () => {
    await getAgentStats('user-9', QUERY, TENANT, ACCOUNT);
    expect(url()).toContain('/proxy/agency/agents/user-9/stats?');
    expect(headers()).toEqual([TENANT, ACCOUNT]);
  });

  it('encodes an id that would otherwise break the path', async () => {
    await getAgentStats('a/b?c', QUERY, TENANT, ACCOUNT);
    expect(url()).toContain('/agents/a%2Fb%3Fc/stats');
  });
});

describe('getMyAttempts and getAgentAttempts', () => {
  it('sends multi-value filters as REPEATED params', async () => {
    /**
     * Matching `agencySpine.ts`, because one convention across the two spines is
     * worth having and the server accepts this one.
     *
     * NOT because it makes a comma survive: the server's `forwardAllowedQuery` joins
     * the repeats with a comma and the server's `multiParam` splits on one, so a
     * disposition code containing a comma is unfilterable however this client
     * spells it. See `attemptQuery`'s docstring.
     */
    await getMyAttempts({ outcome: ['connected', 'no_answer'] }, {}, TENANT, ACCOUNT);
    expect(url()).toContain('outcome=connected&outcome=no_answer');
  });

  it('drops a blank filter value', async () => {
    await getMyAttempts({ phone: '' }, {}, TENANT, ACCOUNT);
    expect(url()).not.toContain('phone=');
  });

  it('passes the cursor and limit through', async () => {
    await getMyAttempts({}, { cursor: 'opaque', limit: 50 }, TENANT, ACCOUNT);
    expect(url()).toContain('cursor=opaque');
    expect(url()).toContain('limit=50');
  });

  it('takes no filters at all', async () => {
    await getMyAttempts(undefined, undefined, TENANT, ACCOUNT);
    expect(url()).toMatch(/\/proxy\/agency\/my-attempts$/);
  });

  it('routes the supervisor form through the twin', async () => {
    await getAgentAttempts('user-9', { campaign_id: 'camp-1' }, {}, TENANT, ACCOUNT);
    expect(url()).toContain('/proxy/agency/agents/user-9/attempts?campaign_id=camp-1');
  });
});

describe('getMyCampaigns', () => {
  it('accepts the bare array the server’s contract states', async () => {
    mocks.apiFetch.mockResolvedValue([{ campaign_id: 'camp-1', active: true }]);
    const out = await getMyCampaigns(TENANT, ACCOUNT);
    expect(out).toHaveLength(1);
  });

  it('reads the `assignments` key the server actually sends', async () => {
    /**
     * The regression this pins, and it is worth stating plainly because the
     * previous version of this test asserted the BUG.
     *
     * The server returns `{ assignments: [...] }` — the same envelope its sibling
     * `/my-assignments` uses on the same prefix. This client read `.campaigns`,
     * which type-checked, found `undefined`, fell through the `?? []` below and
     * rendered every agent's staffing history as "you have never been staffed on
     * anything": no error, no console warning, and an empty state indistinguishable
     * from the true one.
     *
     * The old test asserted `{ campaigns: [...] }` and described it as "the
     * enveloped form its sibling staffing route uses", which is precisely what the
     * sibling route does not use. A test written from the same wrong belief as the
     * code cannot catch the code — so this one names the key and the route it comes
     * from, and a reader who doubts it has somewhere to go and check.
     */
    mocks.apiFetch.mockResolvedValue({ assignments: [{ campaign_id: 'camp-1', active: false }] });
    const out = await getMyCampaigns(TENANT, ACCOUNT);
    expect(out[0]?.campaign_id).toBe('camp-1');
  });

  it('does not silently swallow an unrecognised envelope', async () => {
    /* The `?? []` is a guard against `.map` of undefined in a render, not a licence
       for any shape to mean "no assignments". Pinned so that if the server ever renames
       the key again, a test fails here rather than the product quietly claiming
       nobody has ever been staffed. */
    mocks.apiFetch.mockResolvedValue({ campaigns: [{ campaign_id: 'camp-1' }] });
    expect(await getMyCampaigns(TENANT, ACCOUNT)).toEqual([]);
  });

  it('degrades a body-less 200 to an empty history rather than throwing in a render', async () => {
    mocks.apiFetch.mockResolvedValue(undefined);
    expect(await getMyCampaigns(TENANT, ACCOUNT)).toEqual([]);
  });

  it('lets a genuine failure throw — "we could not ask" is a different screen', async () => {
    // From "nobody has staffed you", which is the empty array above.
    mocks.apiFetch.mockRejectedValue(new Error('Request Failed'));
    await expect(getMyCampaigns(TENANT, ACCOUNT)).rejects.toThrow('Request Failed');
  });
});

describe('getAgencyRoster', () => {
  /**
   * The wrapper that had NO contract test, while every wrapper beside it pinned its
   * route, its query serialisation and its two tenancy headers.
   *
   * That gap mattered more here than the count suggests, because this route is the
   * one whose path is a PREFIX of its sibling's: `/agents/stats` against
   * `/agents/:userId/stats`. A wrapper that reached the second by mistake would send
   * the literal string "stats" as a user id and get a plausible-looking 404 or an
   * empty page — and the contract's own route-precedence warning is about
   * exactly this pair, with an earlier incident where an assertion passed
   * because the route did not exist.
   */
  const ROSTER = {
    from: '2026-08-17T00:00:00.000Z',
    to: '2026-08-24T00:00:00.000Z',
  };

  it('hits the roster route, not the per-agent twin whose path it is a prefix of', async () => {
    await getAgencyRoster(ROSTER, TENANT, ACCOUNT);
    expect(url()).toContain('/proxy/agency/agents/stats?');
    // The subject of this route is the whole roster. One named person is
    // `getAgentStats`, and an id anywhere here would be a different question.
    expect(url()).not.toContain('agent_user_id');
    expect(url()).not.toContain('user_id');
    // And it is not the twin with the literal word "stats" in the id segment.
    expect(url()).not.toMatch(/\/agents\/[^/?]+\/stats/);
  });

  it('sends the half-open window', async () => {
    await getAgencyRoster(ROSTER, TENANT, ACCOUNT);
    expect(url()).toContain(`from=${encodeURIComponent(ROSTER.from)}`);
    expect(url()).toContain(`to=${encodeURIComponent(ROSTER.to)}`);
  });

  it('omits every optional parameter it was not given', async () => {
    /**
     * The server whitelists this route's params and answers an unknown or malformed one
     * with a 400 rather than dropping it silently. So a blank `campaign_id` is a
     * validation error about a filter nobody asked for, and an explicit
     * `include_inactive=false` is one more thing for the whitelist to agree about for
     * no gain.
     */
    await getAgencyRoster({ ...ROSTER, campaign_id: '' }, TENANT, ACCOUNT);
    expect(url()).not.toContain('campaign_id');
    expect(url()).not.toContain('sort');
    expect(url()).not.toContain('order');
    expect(url()).not.toContain('limit');
    expect(url()).not.toContain('include_inactive');
  });

  it('sends the shaping it WAS given', async () => {
    await getAgencyRoster(
      {
        ...ROSTER,
        campaign_id: 'camp-1',
        sort: 'success_rate_pct',
        order: 'asc',
        limit: 200,
        include_inactive: true,
      },
      TENANT,
      ACCOUNT,
    );
    const query = url();
    expect(query).toContain('campaign_id=camp-1');
    expect(query).toContain('sort=success_rate_pct');
    expect(query).toContain('order=asc');
    expect(query).toContain('limit=200');
    // `true` literally, which is what the server accepts. Anything else is a 400 rather than
    // a coercion — coercion would hide departed agents while `inactive_omitted`
    // claimed the omission was requested.
    expect(query).toContain('include_inactive=true');
  });

  it('sends `include_inactive` only when it is true', async () => {
    await getAgencyRoster({ ...ROSTER, include_inactive: false }, TENANT, ACCOUNT);
    expect(url()).not.toContain('include_inactive');
  });

  it('threads tenant and account through', async () => {
    /*
      The account is a REQUIRED predicate on this route rather than a filter: a
      tenant-wide roster is a different question and must not be reachable by
      omitting a parameter. `apiFetch` sends `X-Account-Id` only when it is given
      one, so an omission is silent at every layer that could catch it and surfaces
      at the server as a 400 about a header this client never sent.
    */
    await getAgencyRoster(ROSTER, TENANT, ACCOUNT);
    expect(headers()).toEqual([TENANT, ACCOUNT]);
  });

  it('lets a failure throw rather than degrading to an empty roster', async () => {
    // "We could not ask" is a different screen from "nobody dialled", and the hook's
    // four-state union is what keeps them apart. A wrapper that swallowed this would
    // make the empty state unreachable-by-truth.
    mocks.apiFetch.mockRejectedValue(new Error('Request Failed'));
    await expect(getAgencyRoster(ROSTER, TENANT, ACCOUNT)).rejects.toThrow('Request Failed');
  });
});

describe('getAgencyGroupedStats', () => {
  const GROUPED = {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-20T00:00:00.000Z',
    group_by: ['agent', 'campaign'] as const,
  };

  it('sends the dimensions as ONE comma-separated param', async () => {
    // What the server parses. The tuple type on the query is what keeps it to one
    // or two entries — upstream answers a third with a 400, because the row count is
    // the product of the dimensions' cardinalities.
    await getAgencyGroupedStats(GROUPED, TENANT, ACCOUNT);
    expect(url()).toContain('group_by=agent%2Ccampaign');
  });

  it('takes one dimension just as happily', async () => {
    // The campaign's own line, which is a different read from the rows and not a sum
    // of them.
    await getAgencyGroupedStats({ ...GROUPED, group_by: ['campaign'] }, TENANT, ACCOUNT);
    expect(url()).toContain('group_by=campaign');
  });

  it('omits every optional parameter it was not given', async () => {
    /**
     * The server whitelists this route's params and answers an unknown or malformed one
     * with a 400, so a blank `campaign_id` would be a validation error about a
     * filter nobody asked for — and an explicit `include_inactive=false` is one more
     * thing for the whitelist to agree about for no gain.
     */
    await getAgencyGroupedStats({ ...GROUPED, campaign_id: '' }, TENANT, ACCOUNT);
    expect(url()).not.toContain('campaign_id');
    expect(url()).not.toContain('sort');
    expect(url()).not.toContain('order');
    expect(url()).not.toContain('limit');
    expect(url()).not.toContain('include_inactive');
  });

  it('sends the shaping it WAS given', async () => {
    await getAgencyGroupedStats(
      {
        ...GROUPED,
        campaign_id: 'camp-1',
        sort: 'successes',
        order: 'desc',
        limit: 200,
        include_inactive: true,
      },
      TENANT,
      ACCOUNT,
    );
    const query = url();
    expect(query).toContain('campaign_id=camp-1');
    expect(query).toContain('sort=successes');
    expect(query).toContain('order=desc');
    expect(query).toContain('limit=200');
    expect(query).toContain('include_inactive=true');
  });

  it('carries no agent id, on any call', async () => {
    // Not an accepted filter: the server has no user table, so it
    // cannot validate tenancy on a caller-supplied id, and the server's memberships is
    // the only place that boundary can exist.
    await getAgencyGroupedStats(GROUPED, TENANT, ACCOUNT);
    expect(url()).not.toContain('agent_user_id');
  });

  it('threads tenant and account through', async () => {
    // The account is a REQUIRED predicate on this route, not a filter: the server
    // answers `400 account_scope_required` before it resolves the tenant's API key.
    await getAgencyGroupedStats(GROUPED, TENANT, ACCOUNT);
    expect(headers()).toEqual([TENANT, ACCOUNT]);
  });
});

describe('the routes come from the ENDPOINTS catalog', () => {
  /**
   * `ENDPOINTS` is the repo's single source of truth for URL construction, and
   * this module used to rebuild `${API_BASE}/proxy/agency` locally — five routes
   * hardcoded a few lines from the catalog that exists to prevent exactly that.
   *
   * Asserted against the catalog rather than against a literal on purpose: a
   * literal here would be a THIRD copy of the path, and the property worth
   * holding is "these two agree", not "this string is spelled this way".
   */
  const url = () => mocks.apiFetch.mock.calls[0]![0] as string;

  it('reads my-stats from the catalog', async () => {
    await getMyStats(QUERY, TENANT, ACCOUNT);
    expect(url().startsWith(`${ENDPOINTS.proxy.agency.myStats}?`)).toBe(true);
  });

  it('reads the supervisor stats twin from the catalog', async () => {
    await getAgentStats('user-9', QUERY, TENANT, ACCOUNT);
    expect(url().startsWith(`${ENDPOINTS.proxy.agency.agentStats('user-9')}?`)).toBe(true);
  });

  it('reads my-attempts from the catalog', async () => {
    await getMyAttempts({}, {}, TENANT, ACCOUNT);
    expect(url()).toBe(ENDPOINTS.proxy.agency.myAttempts);
  });

  it('reads the supervisor attempts twin from the catalog', async () => {
    await getAgentAttempts('user-9', {}, {}, TENANT, ACCOUNT);
    expect(url()).toBe(ENDPOINTS.proxy.agency.agentAttempts('user-9'));
  });

  it('reads the roster from the catalog', async () => {
    await getAgencyRoster(
      { from: '2026-08-17T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' },
      TENANT,
      ACCOUNT,
    );
    expect(url().startsWith(`${ENDPOINTS.proxy.agency.agentsStats}?`)).toBe(true);
  });

  it('reads the grouped read from the catalog', async () => {
    await getAgencyGroupedStats(
      {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-20T00:00:00.000Z',
        group_by: ['agent', 'campaign'],
      },
      TENANT,
      ACCOUNT,
    );
    expect(url().startsWith(`${ENDPOINTS.proxy.agency.agentsGroupedStats}?`)).toBe(true);
  });

  it('reads my-campaigns from the catalog', async () => {
    mocks.apiFetch.mockResolvedValue({ assignments: [] });
    await getMyCampaigns(TENANT, ACCOUNT);
    expect(url()).toBe(ENDPOINTS.proxy.agency.myCampaigns);
  });

  it('encodes a user id that would otherwise break the path', async () => {
    /**
     * `userId` is the server's id, opaque to this client. A segment built by
     * concatenation is the one that breaks quietly — and it is the segment that
     * decides WHOSE shift is being read, so a mangled one is a 404 at best.
     */
    await getAgentStats('user/9?x=1', QUERY, TENANT, ACCOUNT);
    expect(url()).toContain('/agents/user%2F9%3Fx%3D1/stats');
  });
});
