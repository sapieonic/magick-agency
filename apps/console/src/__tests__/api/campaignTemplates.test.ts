import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The campaign templates client (`docs/campaign-templates.md` §6), through the real `apiFetch`:
 * each route's method, path and body, reads and account-template writes with `X-Account-Id`, and
 * an organisation template's writes WITHOUT it (the server prefers an account seat over the
 * organisation-wide one when the header is sent, and refuses the write, CT3). A refusal's code and
 * extra fields reach the caller on `ApiError.details`.
 */

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null, signOut: vi.fn() }) }));

import {
  applyCampaignTemplate,
  archiveCampaignTemplate,
  createCampaignTemplate,
  getCampaignTemplateVersion,
  getEffectiveCampaignTemplate,
  listCampaignTemplates,
  replaceCampaignTemplate,
  restoreCampaignTemplate,
  setCampaignTemplateDefault,
} from '../../api/campaignTemplates';
import { errorCode } from '../../utils/agencyErrors';

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

const call = (n = 0) => {
  const [url, init] = mocks.fetch.mock.calls[n] as [string, RequestInit];
  return { url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
};

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(respond(200, { templates: [] }));
});

describe('campaign templates client', () => {
  it('reads with the account: the list (archived on request), a version and the filled-in form', async () => {
    await listCampaignTemplates('t-1', 'a-1');
    await listCampaignTemplates('t-1', 'a-1', { archived: true });
    await getCampaignTemplateVersion('tp 1', 3, 't-1', 'a-1');
    await getEffectiveCampaignTemplate(null, 't-1', 'a-1');
    await getEffectiveCampaignTemplate('tp-2', 't-1', 'a-1');
    expect([0, 1, 2, 3, 4].map((n) => call(n).url)).toEqual([
      '/proxy/agency/campaign-templates',
      '/proxy/agency/campaign-templates?archived=true',
      '/proxy/agency/campaign-templates/tp%201/versions/3',
      '/proxy/agency/campaign-templates/effective',
      '/proxy/agency/campaign-templates/effective?template_id=tp-2',
    ]);
    for (let n = 0; n < 5; n += 1) expect(call(n).headers['X-Account-Id']).toBe('a-1');
  });

  it('writes an account template with the account, and an organisation template without it', async () => {
    await createCampaignTemplate({ scope: 'account', name: 'A', sections: {} }, 't-1', 'a-1');
    await createCampaignTemplate({ scope: 'organisation', name: 'O', sections: {} }, 't-1', 'a-1');
    await replaceCampaignTemplate('o-1', 'organisation', { name: 'O', description: null, based_on_template_id: null, sections: {}, expected_version: 2 }, 't-1', 'a-1');
    await setCampaignTemplateDefault('o-1', 'organisation', true, 't-1', 'a-1');
    await setCampaignTemplateDefault('a-9', 'account', false, 't-1', 'a-1');
    await archiveCampaignTemplate('o-1', 'organisation', 't-1', 'a-1');
    await restoreCampaignTemplate('o-1', 'organisation', 't-1', 'a-1');

    expect(call(0)).toMatchObject({ method: 'POST', url: '/proxy/agency/campaign-templates', body: { scope: 'account', name: 'A', sections: {} } });
    expect(call(0).headers['X-Account-Id']).toBe('a-1');
    for (const n of [1, 2, 3, 5, 6]) {
      expect(call(n).headers['X-Account-Id'], `call ${n}`).toBeUndefined();
      expect(call(n).headers['X-Tenant-Id']).toBe('t-1');
    }
    expect(call(2)).toMatchObject({ method: 'PUT', url: '/proxy/agency/campaign-templates/o-1', body: { expected_version: 2 } });
    expect(call(3)).toMatchObject({ method: 'POST', url: '/proxy/agency/campaign-templates/o-1/default' });
    expect(call(4)).toMatchObject({ method: 'DELETE', url: '/proxy/agency/campaign-templates/a-9/default' });
    expect(call(4).headers['X-Account-Id']).toBe('a-1');
    expect(call(5)).toMatchObject({ method: 'POST', url: '/proxy/agency/campaign-templates/o-1/archive' });
    expect(call(6)).toMatchObject({ method: 'POST', url: '/proxy/agency/campaign-templates/o-1/restore' });
  });

  it('applies with the account, whatever the template’s scope', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { template: {}, results: [] }));
    await applyCampaignTemplate('o-1', { campaign_ids: ['c-1'], sections: ['hours'], expected_version: 2 }, 't-1', 'a-1');
    expect(call()).toMatchObject({ method: 'POST', url: '/proxy/agency/campaign-templates/o-1/apply', body: { campaign_ids: ['c-1'], sections: ['hours'], expected_version: 2 } });
    expect(call().headers['X-Account-Id']).toBe('a-1');
  });

  it('hands a refusal’s code and fields to the caller', async () => {
    mocks.fetch.mockResolvedValue(respond(409, { error: 'Conflict', code: 'campaign_template_changed', message: 'Changed.', current_version: 5 }));
    const err = await replaceCampaignTemplate('a-1', 'account', { name: 'A', description: null, based_on_template_id: null, sections: {}, expected_version: 4 }, 't-1', 'a-1')
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe('campaign_template_changed');
    expect((err as { details: { current_version: number } }).details.current_version).toBe(5);
  });
});
