import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Ingest ownership for roster chunks. `sendRosterChunk`
 * (`src/agency/agency-roster.client.ts`) runs the roster-chunk handler body in-process
 * (`applyRosterChunkInProcess`, private) and maps the outcome — a 4xx becomes a thrown
 * `RosterChunkError(message, status, chunkIndex)`, a 200 becomes a `RosterChunkResponse`.
 * So every assertion about the handler body is made against `sendRosterChunk`, with
 * repository mocks:
 *  - "refuses … with 404" → `sendRosterChunk` rejects with status 404 and the handler's
 *    message; the error's `{ status, message }` is compared (the body never leaves the process);
 *  - the 8 malformed-identity rows: the request's typed `tenantId`/`accountId` are driven
 *    with those values through a cast;
 *  - "accepts a chunk from the owner": the repository call is asserted exactly; the
 *    response is the CLIENT's mapping of the handler body (`rejected_duplicate_rows: 0`,
 *    `duplicate_source_rows: []` are the client's defaults for fields the mock omits);
 *  - campaign ids are UUIDs: the client answers a malformed campaign id with the same 404
 *    before reading (B2, "answers a malformed campaign id with the same 404"), so a
 *    non-UUID id like `'camp-victim'` would never reach `findById`. Tenant/account ids are
 *    arbitrary strings: the repository is mocked, and the comparison is string equality.
 *
 * There is no HTTP route for this hand-off. The real-Postgres twin is
 * test/integration/agency/agency-ingest-route-seam.test.ts.
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { campaigns, contacts } = vi.hoisted(() => ({
  campaigns: { findById: vi.fn() },
  contacts: { applyIngestChunk: vi.fn(), missingChunks: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
  agencyContactRepository: contacts,
  agencyAttemptRepository: {},
  agencyAgentSessionRepository: {},
}));

import {
  sendRosterChunk,
  ingestCallerOwnsCampaign,
  RosterChunkError,
  type RosterChunkRequest,
} from '../../../src/agency/agency-roster.client.js';

/** The victim campaign's id, as a UUID (see the header). */
const CAMPAIGN_ID = 'cccccccc-0000-4000-8000-00000000c1c7';

const CAMPAIGN_ROW = {
  id: CAMPAIGN_ID, tenant_id: 'victim-tenant', account_id: 'victim-account',
  name: 'Q3 Renewals', caller_ids: ['+14155550100'],
};

const OWNER = { tenant_id: 'victim-tenant', account_id: 'victim-account' };

/**
 * Builds a chunk request from an identity, in the client's request shape. The wire's
 * `tenant_id`/`account_id`/`is_final`/`chunk_count` are the request's
 * `tenantId`/`accountId`/`isFinal`/`chunkCount`; the idempotency key is derived by the
 * client as `{ingest_job_id}-{chunk_index}` — `job-1-0`.
 */
function chunk(identity: Record<string, unknown>, extra: { isFinal?: boolean; chunkCount?: number } = {}) {
  return {
    campaignId: CAMPAIGN_ID,
    ...('tenant_id' in identity ? { tenantId: identity.tenant_id } : {}),
    ...('account_id' in identity ? { accountId: identity.account_id } : {}),
    ingestJobId: 'job-1',
    chunkIndex: 0,
    isFinal: extra.isFinal ?? false,
    ...(extra.chunkCount !== undefined ? { chunkCount: extra.chunkCount } : {}),
    contacts: [{ phone_e164: '+15550000001', source_row_number: 1 }],
  } as unknown as RosterChunkRequest;
}

/** The 404 refusal, as the client surfaces it. */
const NOT_FOUND = { status: 404, message: 'Campaign not found' };

async function refusal(request: RosterChunkRequest): Promise<RosterChunkError> {
  const err = await sendRosterChunk(request).then(
    () => { throw new Error('expected sendRosterChunk to reject'); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RosterChunkError);
  return err as RosterChunkError;
}

beforeEach(() => {
  vi.clearAllMocks();
  campaigns.findById.mockResolvedValue(CAMPAIGN_ROW);
  contacts.applyIngestChunk.mockResolvedValue({ accepted: 1, duplicate_chunk: false, total_contacts: 1 });
  contacts.missingChunks.mockResolvedValue([]);
});

describe('internal roster ingest — campaign ownership', () => {
  it('refuses a chunk from another tenant with 404 and writes nothing', async () => {
    const err = await refusal(chunk({ tenant_id: 'attacker-tenant', account_id: 'victim-account' }));

    expect({ status: err.status, message: err.message }).toEqual(NOT_FOUND);
    expect(contacts.applyIngestChunk).not.toHaveBeenCalled();
    expect(contacts.missingChunks).not.toHaveBeenCalled();
  });

  it('refuses a chunk from a sibling account of the same tenant with 404 and writes nothing', async () => {
    // The tenant matches, so a tenant-only comparison would pass this. The
    // account is what separates two customers sharing one tenant.
    const err = await refusal(chunk({ tenant_id: 'victim-tenant', account_id: 'sibling-account' }));

    expect({ status: err.status, message: err.message }).toEqual(NOT_FOUND);
    expect(contacts.applyIngestChunk).not.toHaveBeenCalled();
  });

  it('a foreign campaign is indistinguishable from an unknown one', async () => {
    const foreign = await refusal(chunk({ tenant_id: 'attacker-tenant', account_id: 'attacker-account' }));

    campaigns.findById.mockResolvedValueOnce(null);
    const unknown = await refusal(chunk({ tenant_id: 'attacker-tenant', account_id: 'attacker-account' }));

    expect(foreign.status).toBe(unknown.status);
    expect(foreign.message).toBe(unknown.message);
    // `sendRosterChunk` surfaces this message on the failed ingest job,
    // and `supersedeRoster` (`isCoreCampaignNotFound`) classifies on it — so
    // the shared 404 must keep saying it.
    expect(unknown.message).toMatch(/campaign\s+not\s+found/i);
  });

  it.each([
    ['no tenant_id', { account_id: 'victim-account' }],
    ['no account_id', { tenant_id: 'victim-tenant' }],
    ['neither', {}],
    ['a blank tenant_id', { tenant_id: '  ', account_id: 'victim-account' }],
    ['a blank account_id', { tenant_id: 'victim-tenant', account_id: '' }],
    ['a non-string tenant_id', { tenant_id: 42, account_id: 'victim-account' }],
    ['a non-string account_id', { tenant_id: 'victim-tenant', account_id: 7 }],
    ['an array account_id', { tenant_id: 'victim-tenant', account_id: ['victim-account'] }],
  ])('refuses a chunk with %s as 400, before reading the campaign', async (_label, identity) => {
    const err = await refusal(chunk(identity));

    expect(err.status).toBe(400);
    expect(contacts.applyIngestChunk).not.toHaveBeenCalled();
    // Rejected on shape alone, so it says nothing about whether the id exists.
    expect(campaigns.findById).not.toHaveBeenCalled();
  });

  it("refuses a real account writing into a legacy 'default' campaign of its tenant", async () => {
    // The column default. The row is actually READ here (unlike the
    // missing-account cases, which 400 first), so this pins that 'default' is an
    // ordinary value and not a tenant-wide wildcard.
    // (magick-agency: `account_id` is a UUID column in the baseline, so such a row cannot
    // exist any more; the case still pins that the comparison has no wildcard.)
    campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, account_id: 'default' });

    const err = await refusal(chunk({ tenant_id: 'victim-tenant', account_id: 'some-account-uuid' }));

    expect(campaigns.findById).toHaveBeenCalledTimes(1);
    expect({ status: err.status, message: err.message }).toEqual(NOT_FOUND);
    expect(contacts.applyIngestChunk).not.toHaveBeenCalled();
  });

  it('accepts a chunk from the owner exactly as before, final-chunk completeness included', async () => {
    contacts.missingChunks.mockResolvedValue([1]);

    const res = await sendRosterChunk(chunk(OWNER, { isFinal: true, chunkCount: 2 }));

    expect(contacts.applyIngestChunk).toHaveBeenCalledTimes(1);
    expect(contacts.applyIngestChunk).toHaveBeenCalledWith({
      campaignId: CAMPAIGN_ID,
      tenantId: 'victim-tenant',
      accountId: 'victim-account',
      ingestJobId: 'job-1',
      chunkIndex: 0,
      chunkCount: 2,
      idempotencyKey: 'job-1-0',
      contacts: [{ phone_e164: '+15550000001', source_row_number: 1 }],
    });
    expect(contacts.missingChunks).toHaveBeenCalledWith(CAMPAIGN_ID, 'job-1', 2);
    expect(res).toEqual({
      accepted: 1, duplicate_chunk: false, total_contacts: 1,
      // The client's defaults for the two fields this mock omits (the client's mapping).
      rejected_duplicate_rows: 0, duplicate_source_rows: [],
      roster_complete: false, missing_chunks: [1],
    });
  });
});

describe('ingestCallerOwnsCampaign', () => {
  const campaign = { tenant_id: 't', account_id: 'a' };

  it('requires both tenant and account to match', () => {
    expect(ingestCallerOwnsCampaign(campaign, { tenantId: 't', accountId: 'a' })).toBe(true);
    expect(ingestCallerOwnsCampaign(campaign, { tenantId: 'x', accountId: 'a' })).toBe(false);
    expect(ingestCallerOwnsCampaign(campaign, { tenantId: 't', accountId: 'x' })).toBe(false);
  });

  it("matches a legacy 'default' account only by the literal value", () => {
    const legacy = { tenant_id: 't', account_id: 'default' };
    expect(ingestCallerOwnsCampaign(legacy, { tenantId: 't', accountId: 'default' })).toBe(true);
    expect(ingestCallerOwnsCampaign(legacy, { tenantId: 't', accountId: 'some-uuid' })).toBe(false);
  });
});

/*
 * The handler-body assertion for an accepted chunk; there is no credential to check on
 * the in-process hand-off.
 */
describe('the in-process hand-off applies the chunk', () => {
  it('applies the chunk with tenancy taken from the campaign row', async () => {
    const res = await sendRosterChunk(chunk(OWNER, { isFinal: true, chunkCount: 1 }));

    expect(contacts.applyIngestChunk).toHaveBeenCalledTimes(1);
    expect(contacts.applyIngestChunk).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: CAMPAIGN_ID,
      // Still derived from the campaign row — the fix is the credential, not the
      // tenancy model. Pinned so a later change to one is not mistaken for the other.
      // (The body's tenant/account are now compared to these, never written.)
      tenantId: 'victim-tenant',
      accountId: 'victim-account',
    }));
    expect(res).toMatchObject({ roster_complete: true, missing_chunks: [] });
  });
});
