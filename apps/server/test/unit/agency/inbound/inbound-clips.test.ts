import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * What an inbound caller hears, as clips (docs/inbound.md §3.4): a part asked for with a standard
 * recording plays the route's recording when it plays, else ours; a bare slot plays the route's or
 * nothing; the lookup is the account's (tenant AND account scoped); every failure is "nothing to
 * play" for that part, never a throw.
 */

const mocks = vi.hoisted(() => ({
  findByIdScoped: vi.fn(),
  ensurePcmClip: vi.fn(),
  standardClipHash: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/audio-file.repository', () => ({
  audioFileRepository: { findByIdScoped: mocks.findByIdScoped },
}));
vi.mock('../../../../src/audio/ensure-pcm-clip.js', () => ({ ensurePcmClip: mocks.ensurePcmClip }));
vi.mock('../../../../src/agency/inbound/inbound-standard-clips.js', () => ({ standardClipHash: mocks.standardClipHash }));

import { resolveInboundClips } from '../../../../src/agency/inbound/inbound-clips.js';
import type { AgencyInboundRouteRecord } from '../../../../src/db/repositories/agency.repository.js';

const SCOPE = { tenantId: 't-1', accountId: 'a-1' };
const route = (over: Partial<AgencyInboundRouteRecord> = {}): AgencyInboundRouteRecord => ({
  greeting_audio_id: null, hold_audio_id: null, closed_audio_id: null, busy_audio_id: null,
  recording_notice_audio_id: null, callback_audio_id: null, ...over,
} as AgencyInboundRouteRecord);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findByIdScoped.mockImplementation(async (id: string) => ({ id }));
  mocks.ensurePcmClip.mockImplementation(async (file: { id: string }) => ({ hash: `own-${file.id}`, sampleRate: 8000 }));
  mocks.standardClipHash.mockImplementation(async (r: string) => `std-${r}`);
});

describe('resolveInboundClips', () => {
  it('a bare slot: the route’s recording, or nothing', async () => {
    expect(await resolveInboundClips(route({ greeting_audio_id: 'g' }), ['greeting'], SCOPE)).toEqual(['own-g']);
    expect(await resolveInboundClips(route(), ['greeting'], SCOPE)).toEqual([]);
    expect(mocks.standardClipHash).not.toHaveBeenCalled();
  });

  it('a slot with a standard recording: the route’s when set, else ours', async () => {
    expect(await resolveInboundClips(route({ callback_audio_id: 'cb' }), [{ slot: 'callback', standard: 'callback' }], SCOPE)).toEqual(['own-cb']);
    expect(await resolveInboundClips(route(), [{ slot: 'callback', standard: 'callback' }], SCOPE)).toEqual(['std-callback']);
    expect(await resolveInboundClips(null, [{ slot: 'closed', standard: 'closed' }], SCOPE)).toEqual(['std-closed']);
  });

  it('a recording that is set but cannot be played falls back to ours (never silence)', async () => {
    mocks.findByIdScoped.mockResolvedValueOnce(null); // another account's, or gone
    expect(await resolveInboundClips(route({ closed_audio_id: 'x' }), [{ slot: 'closed', standard: 'closed' }], SCOPE)).toEqual(['std-closed']);
    mocks.ensurePcmClip.mockRejectedValueOnce(new Error('undecodable'));
    expect(await resolveInboundClips(route({ closed_audio_id: 'x' }), [{ slot: 'closed', standard: 'closed' }], SCOPE)).toEqual(['std-closed']);
  });

  it('a standard recording alone, and parts kept in order with the empty ones left out', async () => {
    const hashes = await resolveInboundClips(
      route({ busy_audio_id: 'b' }),
      ['greeting', { slot: null, standard: 'voicemail_prompt' }, { slot: 'busy', standard: 'busy' }, { slot: 'hold', standard: null }],
      SCOPE,
    );
    expect(hashes).toEqual(['std-voicemail_prompt', 'own-b']);
  });

  it('a standard recording that cannot be played is left out', async () => {
    mocks.standardClipHash.mockResolvedValueOnce(null);
    expect(await resolveInboundClips(route(), [{ slot: 'recording_notice', standard: 'recording_notice' }], SCOPE)).toEqual([]);
  });

  it('looks the recording up for the call’s tenant and account', async () => {
    await resolveInboundClips(route({ greeting_audio_id: 'g' }), ['greeting'], SCOPE);
    expect(mocks.findByIdScoped).toHaveBeenCalledWith('g', 't-1', 'a-1');
  });
});
