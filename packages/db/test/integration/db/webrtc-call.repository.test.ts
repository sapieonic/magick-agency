import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertWebrtcCall } from '../setup/factories.js';

// The repository imports `getPool` from db/connection — point it at the test pool.
vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));

const { webrtcCallRepository } = await import('../../../src/repositories/agency-call.repository.js');

// PORT NOTE (magick-agency): ported from core
// test/integration/db/webrtc-call.repository.test.ts@4850d1d9. Plan-required
// changes: ids are UUIDs (core: 'test-tenant' / 'test-account' / 'other-*' /
// 'user-42'); the table is `agency_calls`; the only scope is `'agency'`, so the
// factory rows carry a campaign_id; the default provider is 'voicelink' (VoBiz
// deleted). The recording URL fixtures keep core's strings (opaque text).
const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;

const NON_TERMINAL = ['initiating', 'ringing', 'in_progress'] as const;
const TERMINAL = ['completed', 'failed', 'no_answer', 'busy', 'canceled'] as const;

/** A Date `seconds` in the past. */
function ago(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

describe('webrtcCallRepository (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── create ─────────────────────────────────────────────────────────────
  describe('create', () => {
    it('returns the row with defaults (initiating / voicelink / {})', async () => {
      const row = await webrtcCallRepository.create({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        caller_id: '+14155550100',
        destination_phone: '+14155550199',
      });

      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.tenant_id).toBe(TENANT);
      expect(row.account_id).toBe(ACCOUNT);
      expect(row.caller_id).toBe('+14155550100');
      expect(row.destination_phone).toBe('+14155550199');
      expect(row.status).toBe('initiating');
      expect(row.provider).toBe('voicelink');
      expect(row.metadata).toEqual({});
      expect(row.initiated_by).toBeNull();
      expect(row.provider_call_id).toBeNull();
      expect(row.answered_at).toBeNull();
      expect(row.ended_at).toBeNull();
      expect(row.created_at).toBeInstanceOf(Date);
    });

    it('persists provider override, initiated_by and metadata', async () => {
      const row = await webrtcCallRepository.create({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        caller_id: '+14155550100',
        destination_phone: '+14155550199',
        provider: 'voicelink',
        initiated_by: 'user-42',
        metadata: { source: 'agency', priority: 3 },
      });
      expect(row.initiated_by).toBe('user-42');
      expect(row.metadata).toEqual({ source: 'agency', priority: 3 });
    });
  });

  // ── findByIdScoped ───────────────────────────────────────────────────────
  describe('findByIdScoped', () => {
    it('returns the row when tenant+account match', async () => {
      const created = await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT });
      const found = await webrtcCallRepository.findByIdScoped(created.id, TENANT, ACCOUNT, 'agency');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for a wrong tenant (cross-tenant isolation)', async () => {
      const created = await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT });
      const found = await webrtcCallRepository.findByIdScoped(created.id, OTHER_TENANT, ACCOUNT, 'agency');
      expect(found).toBeNull();
    });

    it('returns null for a wrong account (cross-account isolation)', async () => {
      const created = await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT });
      const found = await webrtcCallRepository.findByIdScoped(created.id, TENANT, OTHER_ACCOUNT, 'agency');
      expect(found).toBeNull();
    });

    it('returns null for a non-existent id', async () => {
      const found = await webrtcCallRepository.findByIdScoped(
        '00000000-0000-0000-0000-000000000000', TENANT, ACCOUNT, 'agency',
      );
      expect(found).toBeNull();
    });
  });

  // ── listByTenant ─────────────────────────────────────────────────────────
  describe('listByTenant', () => {
    it('returns only this tenant/account rows with total count', async () => {
      await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT, status: 'completed' });
      await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT, status: 'failed' });
      await insertWebrtcCall({ tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT, status: 'completed' });

      const { rows, total } = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency');
      expect(total).toBe(2);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.tenant_id === TENANT && r.account_id === ACCOUNT)).toBe(true);
    });

    it('filters by status', async () => {
      await insertWebrtcCall({ status: 'completed' });
      await insertWebrtcCall({ status: 'completed' });
      await insertWebrtcCall({ status: 'failed' });

      const { rows, total } = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency', 20, 0, { status: 'completed' });
      expect(total).toBe(2);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === 'completed')).toBe(true);
    });

    it('honors limit and offset while keeping total at full count', async () => {
      for (let i = 0; i < 5; i++) await insertWebrtcCall();
      const page1 = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency', 2, 0);
      const page2 = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency', 2, 2);
      expect(page1.total).toBe(5);
      expect(page1.rows).toHaveLength(2);
      expect(page2.rows).toHaveLength(2);
      // distinct rows across pages
      const ids = new Set([...page1.rows, ...page2.rows].map((r) => r.id));
      expect(ids.size).toBe(4);
    });

    it('orders by created_at DESC (newest first)', async () => {
      const old = await insertWebrtcCall();
      // Force a clearly-older created_at on the first row.
      const pool = getTestPool();
      await pool.query(`UPDATE agency_calls SET created_at = now() - interval '1 hour' WHERE id = $1`, [old.id]);
      const recent = await insertWebrtcCall();

      const { rows } = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency');
      expect(rows[0]!.id).toBe(recent.id);
      expect(rows[1]!.id).toBe(old.id);
    });

    it('returns empty result when no rows exist', async () => {
      const { rows, total } = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency');
      expect(rows).toEqual([]);
      expect(total).toBe(0);
    });
  });

  // ── update ───────────────────────────────────────────────────────────────
  describe('update', () => {
    it('updates known columns', async () => {
      const created = await insertWebrtcCall({ status: 'initiating' });
      const endedAt = new Date();
      const updated = await webrtcCallRepository.update(created.id, {
        status: 'completed',
        outcome: 'answered',
        provider_call_id: 'prov-123',
        talk_time_seconds: 42,
        duration_seconds: 50,
        ended_at: endedAt,
      });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.outcome).toBe('answered');
      expect(updated!.provider_call_id).toBe('prov-123');
      expect(updated!.talk_time_seconds).toBe(42);
      expect(updated!.duration_seconds).toBe(50);
      expect(updated!.ended_at).toBeInstanceOf(Date);
    });

    it('returns the unchanged row when no updatable keys are provided', async () => {
      const created = await insertWebrtcCall({ status: 'ringing' });
      const updated = await webrtcCallRepository.update(created.id, {});
      expect(updated).not.toBeNull();
      expect(updated!.id).toBe(created.id);
      expect(updated!.status).toBe('ringing');
    });

    it('rejects unknown keys via the allow-list (no unknown column written)', async () => {
      const created = await insertWebrtcCall({ status: 'initiating' });
      await expect(
        // tenant_id is NOT on the WEBRTC_UPDATABLE_COLUMNS allow-list.
        webrtcCallRepository.update(created.id, { tenant_id: OTHER_TENANT } as never),
      ).rejects.toThrow(/Disallowed update column: tenant_id/);

      // And nothing was mutated.
      const after = await webrtcCallRepository.findById(created.id);
      expect(after!.tenant_id).toBe(TENANT);
    });

    it('returns null when updating a non-existent id with real columns', async () => {
      const updated = await webrtcCallRepository.update(
        '00000000-0000-0000-0000-000000000000', { status: 'completed' },
      );
      expect(updated).toBeNull();
    });
  });

  // ── recording columns ────────────────────────────────────────────────────
  describe('recording columns', () => {
    it('create() defaults recording_requested to false and leaves recording_url/duration null', async () => {
      const row = await webrtcCallRepository.create({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        caller_id: '+14155550100',
        destination_phone: '+14155550199',
      });
      expect(row.recording_requested).toBe(false);
      expect(row.recording_url).toBeNull();
      expect(row.recording_duration_seconds).toBeNull();
    });

    it('create({ recording_requested: true }) persists true', async () => {
      const row = await webrtcCallRepository.create({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        caller_id: '+14155550100',
        destination_phone: '+14155550199',
        recording_requested: true,
      });
      expect(row.recording_requested).toBe(true);
    });

    it('update() persists recording_url and recording_duration_seconds (on the allow-list)', async () => {
      const created = await insertWebrtcCall({ status: 'completed' });
      const updated = await webrtcCallRepository.update(created.id, {
        recording_url: 'https://vobiz.ai/rec/abc.wav',
        recording_duration_seconds: 123,
      });
      expect(updated).not.toBeNull();
      expect(updated!.recording_url).toBe('https://vobiz.ai/rec/abc.wav');
      expect(updated!.recording_duration_seconds).toBe(123);

      // The row reflects them via the scoped + unscoped lookups.
      const scoped = await webrtcCallRepository.findByIdScoped(created.id, TENANT, ACCOUNT, 'agency');
      expect(scoped!.recording_url).toBe('https://vobiz.ai/rec/abc.wav');
      expect(scoped!.recording_duration_seconds).toBe(123);
      const byId = await webrtcCallRepository.findById(created.id);
      expect(byId!.recording_url).toBe('https://vobiz.ai/rec/abc.wav');
      expect(byId!.recording_duration_seconds).toBe(123);
    });

    it('rejects recording_requested via the allow-list (insert-only, not updatable)', async () => {
      const created = await insertWebrtcCall({ status: 'initiating' });
      await expect(
        // recording_requested is NOT on the WEBRTC_UPDATABLE_COLUMNS allow-list.
        webrtcCallRepository.update(created.id, { recording_requested: true } as never),
      ).rejects.toThrow(/Disallowed update column: recording_requested/);

      // And nothing was mutated.
      const after = await webrtcCallRepository.findById(created.id);
      expect(after!.recording_requested).toBe(false);
    });

    it('round-trips recording fields inserted via the factory through findByIdScoped', async () => {
      const created = await insertWebrtcCall({
        recording_requested: true,
        recording_url: 'https://vobiz.ai/rec/x.wav',
        recording_duration_seconds: 55,
      });
      const found = await webrtcCallRepository.findByIdScoped(created.id, TENANT, ACCOUNT, 'agency');
      expect(found).not.toBeNull();
      expect(found!.recording_requested).toBe(true);
      expect(found!.recording_url).toBe('https://vobiz.ai/rec/x.wav');
      expect(found!.recording_duration_seconds).toBe(55);
    });
  });

  // ── failStaleActive (stuck active recovery) ──────────────────────────────
  describe('failStaleActive', () => {
    /** Insert a row, then backdate created_at. */
    async function insertAged(status: string, secondsOld: number, overrides: Record<string, unknown> = {}) {
      const row = await insertWebrtcCall({ status, ...overrides });
      const pool = getTestPool();
      await pool.query(`UPDATE agency_calls SET created_at = $2 WHERE id = $1`, [row.id, ago(secondsOld)]);
      return row;
    }

    it('fails only old non-terminal rows; leaves terminal rows untouched', async () => {
      const nonTerminal = [];
      for (const s of NON_TERMINAL) nonTerminal.push(await insertAged(s, 3600));
      const terminal = [];
      for (const s of TERMINAL) terminal.push(await insertAged(s, 3600));

      const failed = await webrtcCallRepository.failStaleActive(ago(60), []);
      expect(failed).toHaveLength(NON_TERMINAL.length);
      expect(new Set(failed.map((r) => r.id))).toEqual(new Set(nonTerminal.map((r) => r.id)));

      // Terminal rows still in their original status.
      const pool = getTestPool();
      for (const t of terminal) {
        const { rows } = await pool.query('SELECT status FROM agency_calls WHERE id = $1', [t.id]);
        expect(TERMINAL).toContain(rows[0].status);
      }
    });

    it('does not fail rows newer than the cutoff', async () => {
      const fresh = await insertAged('in_progress', 10); // 10s old
      const old = await insertAged('in_progress', 3600);

      const failed = await webrtcCallRepository.failStaleActive(ago(60), []);
      const failedIds = failed.map((r) => r.id);
      expect(failedIds).toContain(old.id);
      expect(failedIds).not.toContain(fresh.id);
    });

    it('excludes ids in excludeIds (NOT id = ANY branch)', async () => {
      const keep = await insertAged('in_progress', 3600);
      const sweep = await insertAged('ringing', 3600);

      const failed = await webrtcCallRepository.failStaleActive(ago(60), [keep.id]);
      const failedIds = failed.map((r) => r.id);
      expect(failedIds).toContain(sweep.id);
      expect(failedIds).not.toContain(keep.id);

      // The excluded row is still non-terminal.
      const pool = getTestPool();
      const { rows } = await pool.query('SELECT status FROM agency_calls WHERE id = $1', [keep.id]);
      expect(rows[0].status).toBe('in_progress');
    });

    it('empty excludeIds ($2 IS NULL branch) fails all eligible rows', async () => {
      const a = await insertAged('initiating', 3600);
      const b = await insertAged('ringing', 3600);
      const failed = await webrtcCallRepository.failStaleActive(ago(60), []);
      expect(new Set(failed.map((r) => r.id))).toEqual(new Set([a.id, b.id]));
    });

    it('sets failed status, stuck outcome/error_code, ended_at, COALESCEd durations', async () => {
      const row = await insertAged('in_progress', 3600);
      const [failed] = await webrtcCallRepository.failStaleActive(ago(60), []);
      expect(failed).toBeDefined();
      expect(failed!.status).toBe('failed');
      expect(failed!.outcome).toBe('stuck_active_call');
      expect(failed!.error_code).toBe('STUCK_ACTIVE_CALL');
      expect(failed!.error_message).toMatch(/stuck active call/);
      expect(failed!.ended_at).toBeInstanceOf(Date);
      expect(failed!.duration_seconds).toBeGreaterThanOrEqual(0);
      expect(failed!.talk_time_seconds).toBe(0); // COALESCE(NULL, 0)
      // RETURNING includes the fields settlement needs.
      expect(failed).toHaveProperty('destination_phone');
      expect(failed).toHaveProperty('talk_time_seconds');
    });

    it('preserves an already-set talk_time_seconds via COALESCE', async () => {
      const row = await insertAged('in_progress', 3600, { talk_time_seconds: 77, duration_seconds: 100 });
      const [failed] = await webrtcCallRepository.failStaleActive(ago(60), []);
      expect(failed!.talk_time_seconds).toBe(77);
      expect(failed!.duration_seconds).toBe(100);
    });

    it('is idempotent — a second sweep does not re-fail already-failed rows', async () => {
      await insertAged('in_progress', 3600);
      const first = await webrtcCallRepository.failStaleActive(ago(60), []);
      expect(first).toHaveLength(1);
      const second = await webrtcCallRepository.failStaleActive(ago(60), []);
      expect(second).toHaveLength(0);
    });

    it('returns empty array when nothing is eligible', async () => {
      await insertAged('completed', 3600);
      const failed = await webrtcCallRepository.failStaleActive(ago(60), []);
      expect(failed).toEqual([]);
    });
  });
});
