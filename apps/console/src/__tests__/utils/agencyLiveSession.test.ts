import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearAllLiveSessions,
  clearLiveSession,
  coalesceJoin,
  localJoinConflict,
  LIVE_SESSION_MAX_AGE_MS,
  readLiveSession,
  rememberLiveSessionFromBootstrap,
  rememberLiveSessionFromConflict,
  resetLiveSessionForTests,
  touchLiveSessionState,
} from '../../utils/agencyLiveSession';
import type { AgencySessionBootstrap, AgencySessionConflict } from '../../types/agency';

/**
 * This browser's memory of the agent's live station — the join path's
 * equivalent of the station reload guard, so a second `POST /sessions` is not how we learn
 * the agent is already live elsewhere.
 */

const BOOTSTRAP: Pick<AgencySessionBootstrap, 'session_id' | 'campaign_id' | 'campaign_name' | 'state'> = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  state: 'available',
};

const CONFLICT: AgencySessionConflict = {
  error: 'Conflict',
  code: 'session_on_other_campaign',
  campaign_id: 'camp-other',
  campaign_name: 'Collections',
  state: 'available',
};

beforeEach(() => {
  resetLiveSessionForTests();
});

afterEach(() => {
  resetLiveSessionForTests();
});

describe('remember / read / clear', () => {
  it('round-trips a successful join, including the session id', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    expect(readLiveSession('tenant-1')).toEqual({
      tenantId: 'tenant-1',
      campaignId: 'camp-1',
      campaignName: 'Renewals',
      sessionId: 'sess-1',
      state: 'available',
      rememberedAt: 1_000,
    });
  });

  it('survives a memory wipe by reading localStorage', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    // Simulate a new module-load in the same origin (another tab, a reload)
    // without clearing storage — `resetLiveSessionForTests` wipes both, so
    // poke memory the way a second tab would: only the in-process copy is gone.
    resetLiveSessionForTests();
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    const stored = localStorage.getItem('mv:agency-live-session:tenant-1');
    expect(stored).toBeTruthy();
    resetLiveSessionForTests();
    // Put the record back as storage-only.
    localStorage.setItem('mv:agency-live-session:tenant-1', stored!);
    expect(readLiveSession('tenant-1')?.campaignId).toBe('camp-1');
  });

  it('a 409 names the other campaign and has no session id', () => {
    rememberLiveSessionFromConflict('tenant-1', CONFLICT, 1_000);
    const live = readLiveSession('tenant-1');
    expect(live?.campaignId).toBe('camp-other');
    expect(live?.sessionId).toBeNull();
  });

  it('is scoped to the tenant — another tenant does not inherit the station', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    expect(readLiveSession('tenant-2')).toBeNull();
  });

  it('clear drops both memory and storage', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    clearLiveSession('tenant-1');
    expect(readLiveSession('tenant-1')).toBeNull();
    expect(localStorage.getItem('mv:agency-live-session:tenant-1')).toBeNull();
  });

  it('clearAll drops every tenant so a logout cannot leak a join refusal', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    rememberLiveSessionFromBootstrap('tenant-2', { ...BOOTSTRAP, campaign_id: 'camp-2' }, 1_000);
    clearAllLiveSessions();
    expect(readLiveSession('tenant-1')).toBeNull();
    expect(readLiveSession('tenant-2')).toBeNull();
  });

  it('ignores a stored record that has no rememberedAt — better to POST than to strand', () => {
    localStorage.setItem('mv:agency-live-session:tenant-1', JSON.stringify({
      campaignId: 'camp-1',
      campaignName: 'Renewals',
      sessionId: 'sess-1',
      state: 'available',
    }));
    expect(readLiveSession('tenant-1')).toBeNull();
  });
});

describe('localJoinConflict', () => {
  it('is silent when this browser has no live station', () => {
    expect(localJoinConflict('tenant-1', 'camp-1', 1_000)).toBeNull();
  });

  it('is silent when joining the campaign we already hold — that is a resume', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    expect(localJoinConflict('tenant-1', 'camp-1', 1_000)).toBeNull();
  });

  it('names the live campaign when joining a different one', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    expect(localJoinConflict('tenant-1', 'camp-2', 1_000)).toEqual({
      error: 'Conflict',
      code: 'session_on_other_campaign',
      campaign_id: 'camp-1',
      campaign_name: 'Renewals',
      state: 'available',
    });
  });

  it('follows a later state touch so a second tab can still refuse a mid-call switch', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    touchLiveSessionState('tenant-1', 'camp-1', 'on_call', 1_100);
    expect(localJoinConflict('tenant-1', 'camp-2', 1_100)?.state).toBe('on_call');
  });

  it('does not rewrite a cache that belongs to another campaign', () => {
    rememberLiveSessionFromConflict('tenant-1', CONFLICT, 1_000);
    touchLiveSessionState('tenant-1', 'camp-1', 'on_call', 1_100);
    expect(readLiveSession('tenant-1')?.state).toBe('available');
    expect(readLiveSession('tenant-1')?.campaignId).toBe('camp-other');
  });

  it('is silent once the record is older than the heartbeat lease buffer', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    expect(localJoinConflict('tenant-1', 'camp-2', 1_000 + LIVE_SESSION_MAX_AGE_MS + 1)).toBeNull();
  });

  it('a touch keeps a long available shift from aging out', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    const later = 1_000 + LIVE_SESSION_MAX_AGE_MS + 1;
    touchLiveSessionState('tenant-1', 'camp-1', 'available', later);
    expect(localJoinConflict('tenant-1', 'camp-2', later)?.campaign_id).toBe('camp-1');
  });
});

describe('storage events from another tab', () => {
  it('Leave in another tab unsticks memory in this one', () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP, 1_000);
    expect(localJoinConflict('tenant-1', 'camp-2', 1_000)).not.toBeNull();

    // The other tab's `clearLiveSession` removes the key (which does not
    // fire `storage` here) and this tab hears the event. Clearing memory
    // without emptying storage would just rehydrate on the next read.
    localStorage.removeItem('mv:agency-live-session:tenant-1');
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'mv:agency-live-session:tenant-1',
      newValue: null,
    }));

    expect(readLiveSession('tenant-1')).toBeNull();
    expect(localJoinConflict('tenant-1', 'camp-2', 1_000)).toBeNull();
  });
});

describe('coalesceJoin', () => {
  it('reuses the in-flight promise for the same key', async () => {
    const start = vi.fn(() => Promise.resolve('ok'));
    const a = coalesceJoin('k', start);
    const b = coalesceJoin('k', start);
    expect(a).toBe(b);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await a).toBe('ok');
  });

  it('starts a new attempt once the previous one has settled', async () => {
    const start = vi.fn(() => Promise.resolve('ok'));
    await coalesceJoin('k', start);
    await coalesceJoin('k', start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not share across keys', async () => {
    const startA = vi.fn(() => Promise.resolve('a'));
    const startB = vi.fn(() => Promise.resolve('b'));
    const a = coalesceJoin('a', startA);
    const b = coalesceJoin('b', startB);
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    expect(startA).toHaveBeenCalledTimes(1);
    expect(startB).toHaveBeenCalledTimes(1);
  });

  it('a rejection still clears the inflight slot so a retry can POST', async () => {
    const boom = vi.fn(() => Promise.reject(new Error('no')));
    await expect(coalesceJoin('k', boom)).rejects.toThrow('no');
    const ok = vi.fn(() => Promise.resolve('ok'));
    await expect(coalesceJoin('k', ok)).resolves.toBe('ok');
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
