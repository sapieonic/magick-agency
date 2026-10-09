import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insertMany: vi.fn(),
  findSuppressed: vi.fn(),
  deleteById: vi.fn(),
  list: vi.fn(),
  findById: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../../../src/dnc/dnc.repository.js', () => ({
  dncRepository: {
    insertMany: mocks.insertMany,
    findSuppressed: mocks.findSuppressed,
    deleteById: mocks.deleteById,
    list: mocks.list,
    findById: mocks.findById,
  },
  DNC_SOURCES: ['agent', 'import', 'api', 'regulator'],
}));

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  DncService,
  DncUnavailableError,
  toDncE164,
} from '../../../src/dnc/dnc.service.js';

const service = new DncService();
const TENANT = '11111111-1111-4111-8111-111111111111';

/**
 * The repository, in its ordinary shape: every distinct number is a new
 * tenant-wide row, and the request takes one version.
 *
 * `created` is per number so a test can make one of them a duplicate; the
 * `syncVersion` is per request, matching the real transaction.
 */
function mockInsertMany(
  createdByPhone: Record<string, boolean> = {},
  syncVersion: string | undefined = '7',
): void {
  mocks.insertMany.mockImplementation((input: { phones: string[]; account_id: string | null; campaign_id: string | null }) => {
    const tenantWide = input.account_id === null && input.campaign_id === null;
    const results = input.phones.map((phone, i) => ({
      phone_e164: phone,
      // The entry carries the scope it was written at, as the real repository's
      // `RETURNING *` / fallback SELECT does. The service reads its receipt off
      // this row, so a fixture that omitted the scope would let the service echo
      // the request instead and stay green.
      entry: {
        id: `entry-${i + 1}`,
        phone_e164: phone,
        account_id: input.account_id,
        campaign_id: input.campaign_id,
      },
      created: createdByPhone[phone] ?? true,
    }));
    const addedTenantWide = tenantWide
      ? results.filter((r) => r.created).map((r) => r.phone_e164)
      : [];
    return Promise.resolve({
      results,
      addedTenantWide,
      ...(addedTenantWide.length > 0 && syncVersion !== undefined ? { syncVersion } : {}),
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertMany();
  mocks.publish.mockResolvedValue(true);
});

describe('toDncE164 — strict on purpose, because the alternative fails open', () => {
  it('accepts E.164 and strips cosmetic separators', () => {
    expect(toDncE164('+1 (555) 123-0001')).toBe('+15551230001');
    expect(toDncE164('+91 98765 43210')).toBe('+919876543210');
  });

  it('REJECTS a local-format number rather than applying a default country code', () => {
    /**
     * The heart of it. `normalizePhoneToE164('5551234567')` would return
     * `+915551234567` under the platform default `DEFAULT_PHONE_COUNTRY_CODE=91`,
     * while a US campaign's roster normalises the same digits to `+15551234567`
     * using the ingest job's own `default_country_code`. The suppression lookup
     * is an exact string match, so such an entry would sit on the DNC list
     * matching nothing, forever, while the operator watched the number get
     * dialed.
     *
     * A rejected entry is visible and fixable in one edit. A mis-normalised one
     * is invisible and permanent.
     */
    expect(toDncE164('5551234567')).toBeNull();
    expect(toDncE164('09876543210')).toBeNull();
    expect(toDncE164('919876543210')).toBeNull();
  });

  it('rejects malformed E.164', () => {
    expect(toDncE164('+0123456789')).toBeNull(); // country code cannot start with 0
    expect(toDncE164('+1234')).toBeNull(); // too short
    expect(toDncE164('+1234567890123456')).toBeNull(); // too long
    expect(toDncE164('+1555abc0001')).toBeNull();
    expect(toDncE164('')).toBeNull();
  });
});

describe('add — outcomes an operator can reconcile', () => {
  it('reports added / already_present / invalid separately', async () => {
    mockInsertMany({ '+15551230002': false });

    const summary = await service.add({
      tenantId: TENANT,
      phoneNumbers: ['+15551230001', '+15551230002', 'not-a-number'],
      source: 'import',
    });

    expect(summary.added).toBe(1);
    expect(summary.already_present).toBe(1);
    expect(summary.invalid).toBe(1);
    // "412 added, 88 already on the list, 3 invalid" is the sentence the wizard
    // has to render; a bare count cannot produce it.
    expect(summary.results.map((r) => r.outcome)).toEqual([
      'added',
      'already_present',
      'invalid_phone',
    ]);
  });

  it('an invalid number does not discard the valid ones', async () => {
    const summary = await service.add({
      tenantId: TENANT,
      phoneNumbers: ['garbage', '+15551230001'],
      source: 'import',
    });

    // One mistyped row in a thousand-row regulator list must not throw the list
    // away — the operator would have to find the row with no help from us.
    expect(summary.added).toBe(1);
    expect(mocks.insertMany.mock.calls[0]![0].phones).toEqual(['+15551230001']);
  });

  it('echoes the input verbatim so the caller can point at the offending row', async () => {
    const summary = await service.add({
      tenantId: TENANT,
      phoneNumbers: ['+1 (555) 123-0001'],
      source: 'api',
    });

    expect(summary.results[0]!.input).toBe('+1 (555) 123-0001');
    expect(summary.results[0]!.phone_e164).toBe('+15551230001');
  });

  it('collapses duplicates WITHIN one request to a single database write', async () => {
    const summary = await service.add({
      tenantId: TENANT,
      phoneNumbers: ['+15551230001', '+1 555 123 0001', '+15551230001'],
      source: 'regulator',
    });

    // Same number three spellings. A pasted regulator list repeats routinely;
    // 3 inserts plus 2 fallback SELECTs for one number is a round-trip storm.
    expect(mocks.insertMany.mock.calls[0]![0].phones).toEqual(['+15551230001']);
    expect(summary.results).toHaveLength(3);
    // The operator sent three rows and gets three answers — the count of rows
    // they can reconcile is theirs, not ours.
    expect(summary.added).toBe(1);
    expect(summary.already_present).toBe(2);
  });

  it('gives every collapsed copy the SAME entry id as the write that happened', async () => {
    const summary = await service.add({
      tenantId: TENANT,
      phoneNumbers: ['+15551230001', '+15551230001'],
      source: 'api',
    });

    // Not `undefined` on the copies: a caller linking a row to its entry would
    // otherwise show a blank for the duplicate and imply nothing was recorded.
    expect(summary.results[1]!.entry_id).toBe(summary.results[0]!.entry_id);
  });

  it('carries the WRITTEN campaign scope out on each result', async () => {
    const campaignId = '33333333-3333-4333-8333-333333333333';

    const summary = await service.add({
      tenantId: TENANT,
      campaignId,
      phoneNumbers: ['+15551230001'],
      source: 'agent',
    });

    /**
     * `POST /internal/agency/dnc` returns this to core as a receipt for the write,
     * and core is being changed to compare it against what it sent and treat a
     * mismatch as "not landed". The route cannot produce that receipt unless the
     * service carries the row's scope out — before this it carried only
     * `entry_id`, so the route echoed its own request body instead and the
     * "receipt" could not detect the one failure it existed to detect.
     */
    expect(summary.results[0]!.campaign_id).toBe(campaignId);
  });

  it('reports the ROW\'s scope, even when it differs from the one requested', async () => {
    // The divergence is what the field is for. A repository that ignored the
    // requested scope — the silent-strip regression this feature was opened to
    // fix — produces exactly this, and the receipt has to show it rather than
    // repeat the request back.
    mocks.insertMany.mockResolvedValue({
      results: [
        {
          phone_e164: '+15551230001',
          entry: { id: 'e1', phone_e164: '+15551230001', account_id: null, campaign_id: null },
          created: false,
        },
      ],
      addedTenantWide: [],
    });

    const summary = await service.add({
      tenantId: TENANT,
      campaignId: '33333333-3333-4333-8333-333333333333',
      phoneNumbers: ['+15551230001'],
      source: 'agent',
    });

    // The row is tenant-wide. Reporting the requested campaign here would tell
    // core the number is suppressed in one campaign when it is suppressed in all.
    expect(summary.results[0]!.campaign_id).toBeNull();
  });

  it('defaults the scope to tenant-wide — the scope core\'s Redis set can express', async () => {
    await service.add({ tenantId: TENANT, phoneNumbers: ['+15551230001'], source: 'agent' });

    const input = mocks.insertMany.mock.calls[0]![0] as Record<string, unknown>;
    // §2.3: only tenant-wide rows reach core. A silently account-scoped default
    // would produce entries that never propagate to the dial-time check.
    expect(input['account_id']).toBeNull();
    expect(input['campaign_id']).toBeNull();
  });

  it('passes an explicit scope through unchanged', async () => {
    await service.add({
      tenantId: TENANT,
      accountId: '22222222-2222-4222-8222-222222222222',
      campaignId: '33333333-3333-4333-8333-333333333333',
      phoneNumbers: ['+15551230001'],
      source: 'api',
    });

    const input = mocks.insertMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(input['account_id']).toBe('22222222-2222-4222-8222-222222222222');
    expect(input['campaign_id']).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('propagates a database failure instead of reporting a partial import as success', async () => {
    mocks.insertMany.mockRejectedValue(new Error('deadlock detected'));

    // Returning the summary built so far would tell an operator "1 added" for a
    // two-number list and leave them believing the second is suppressed.
    await expect(
      service.add({
        tenantId: TENANT,
        phoneNumbers: ['+15551230001', '+15551230002'],
        source: 'import',
      }),
    ).rejects.toThrow('deadlock detected');
  });
});


describe('filterSuppressed — the fail-closed boundary', () => {
  it('returns the suppressed subset when the list can be read', async () => {
    mocks.findSuppressed.mockResolvedValue(new Set(['+15551230002']));

    const suppressed = await service.filterSuppressed({ tenantId: TENANT }, [
      '+15551230001',
      '+15551230002',
    ]);

    expect([...suppressed]).toEqual(['+15551230002']);
  });

  it('THROWS DncUnavailableError when the list cannot be read — never an empty Set', async () => {
    mocks.findSuppressed.mockRejectedValue(new Error('ECONNREFUSED'));

    /**
     * The polarity assertion for the whole feature. An empty Set is a
     * well-formed answer meaning "none of these are suppressed", and every
     * caller would proceed to dial. Under a database blip that is a DNC
     * violation at volume, with a green health check — exactly the failure the
     * feature exists to prevent.
     */
    await expect(
      service.filterSuppressed({ tenantId: TENANT }, ['+15551230001']),
    ).rejects.toBeInstanceOf(DncUnavailableError);
  });

  it('keeps the original error as `cause`, so the halt is diagnosable', async () => {
    const underlying = new Error('sorry, too many clients already');
    mocks.findSuppressed.mockRejectedValue(underlying);

    // A halted campaign with no recoverable reason looks arbitrary to whoever is
    // paged, and "the DNC list was unavailable" is not actionable on its own.
    await expect(
      service.filterSuppressed({ tenantId: TENANT }, ['+15551230001']),
    ).rejects.toMatchObject({ cause: underlying });
  });

  it('does NOT normalise its input — the roster already did, with the campaign\'s country code', async () => {
    mocks.findSuppressed.mockResolvedValue(new Set());

    await service.filterSuppressed({ tenantId: TENANT }, ['+15551230001']);

    // Normalising here with a *different* default country code than the write
    // side is how a lookup silently stops matching. The numbers must reach the
    // repository byte-identical to what the ingest produced.
    expect(mocks.findSuppressed.mock.calls[0]![1]).toEqual(['+15551230001']);
  });
});

describe('remove', () => {
  it('returns the removed row so the caller knows what to unpublish', async () => {
    mocks.deleteById.mockResolvedValue({
      entry: { id: 'e1', phone_e164: '+15551230001', account_id: null, campaign_id: null },
      syncVersion: '12',
    });

    const removed = await service.remove('e1', TENANT);

    expect(removed?.phone_e164).toBe('+15551230001');
    expect(mocks.deleteById).toHaveBeenCalledWith('e1', TENANT);
  });

  it('returns null for an id this tenant does not own', async () => {
    mocks.deleteById.mockResolvedValue(null);

    expect(await service.remove('e1', TENANT)).toBeNull();
  });

  it('forwards accountScope to the repository when given (account-scoped caller)', async () => {
    mocks.deleteById.mockResolvedValue({
      entry: { id: 'e1', phone_e164: '+15551230001', account_id: 'acct-a', campaign_id: null },
    });

    await service.remove('e1', TENANT, 'acct-a');

    expect(mocks.deleteById).toHaveBeenCalledWith('e1', TENANT, 'acct-a');
  });

  it('omitting accountScope calls the repository with exactly two arguments', async () => {
    // Not a third `undefined` — that would change nothing about the SQL but
    // would be a different call shape from every pre-existing assertion here.
    mocks.deleteById.mockResolvedValue({
      entry: { id: 'e1', phone_e164: '+15551230001', account_id: null, campaign_id: null },
    });

    await service.remove('e1', TENANT);

    expect(mocks.deleteById).toHaveBeenCalledWith('e1', TENANT);
    expect(mocks.deleteById.mock.calls[0]).toHaveLength(2);
  });
});
