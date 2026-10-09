import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertWebrtcCall } from '../setup/factories.js';

// PORT NOTE (magick-agency): ported from core
// test/integration/db/webrtc-call-analysis-projection.test.ts@4850d1d9. Ids are
// UUIDs (core: 'test-tenant' / 'test-account'); the scope is `'agency'`.

vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { webrtcCallRepository: repo } = await import('../../../src/repositories/agency-call.repository.js');

describe('webrtc call analysis projection (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('lists scalar sentiment from nested and legacy analysis without returning blobs; detail returns blobs', async () => {
    const nested = await insertWebrtcCall({ call_analysis: JSON.stringify({ common: { overall_sentiment: { label: 'positive' } } }), conversation_log: JSON.stringify([{ content: 'secret' }]), transcript_meta: JSON.stringify({ provider: 'gemini' }), analysis_status: 'completed' });
    const legacy = await insertWebrtcCall({ call_analysis: JSON.stringify({ overall_sentiment: { label: 'negative' } }), analysis_status: 'completed' });
    const empty = await insertWebrtcCall({ analysis_status: null });
    const listed = await repo.listByTenant(DEFAULTS.tenantId, DEFAULTS.accountId, 'agency');
    const byId = new Map(listed.rows.map((row) => [row.id, row]));
    expect(byId.get(nested.id)).toMatchObject({ analysis_status: 'completed', analysis_sentiment_label: 'positive' });
    expect(byId.get(legacy.id)).toMatchObject({ analysis_sentiment_label: 'negative' });
    expect(byId.get(empty.id)?.analysis_sentiment_label).toBeNull();
    expect(byId.get(nested.id)).not.toHaveProperty('call_analysis');
    expect(byId.get(nested.id)).not.toHaveProperty('conversation_log');
    expect(byId.get(nested.id)).not.toHaveProperty('transcript_meta');
    expect((await repo.findById(nested.id))!.conversation_log).toEqual([{ content: 'secret' }]);
  });

  it('filters list by analysis_status and keeps analysis intake fields immutable', async () => {
    const completed = await insertWebrtcCall({ analysis_status: 'completed', analysis_profile_id: '00000000-0000-0000-0000-000000000001', analysis_consent: true });
    await insertWebrtcCall({ analysis_status: 'failed' });
    const filtered = await repo.listByTenant(DEFAULTS.tenantId, DEFAULTS.accountId, 'agency', 20, 0, { analysis_status: 'completed' });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]!.id).toBe(completed.id);
    await expect(repo.update(completed.id, { analysis_profile_id: 'hacked' } as never)).rejects.toThrow(/Disallowed update column/);
    await expect(repo.update(completed.id, { analysis_consent: false } as never)).rejects.toThrow(/Disallowed update column/);
    const persisted = await repo.findById(completed.id);
    expect(persisted).toMatchObject({ analysis_profile_id: '00000000-0000-0000-0000-000000000001', analysis_consent: true });
  });
});
