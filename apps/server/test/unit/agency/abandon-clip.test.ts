import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Resolving the apology clip an abandoned call plays.
//
// The property under test is not "it returns a hash". It is that **no input
// makes this throw**, because every caller is a live customer who has just
// answered a call with no agent on it: a throw there leaves them on an open
// silent line with a non-terminal attempt. So each arm is asserted by the
// REASON it reports, not merely by `hash === null` — a single collapsed
// "returns null" assertion would pass even if the four causes had been merged,
// and the reason is the only thing that tells an operator which of "you never
// configured one" / "you deleted it" / "TTS is down" they are looking at.
//
// Self-contained mock harness (project convention: no shared test utilities).
//
// Decision #4 ("uploaded clip only, no TTS"): `abandon-clip.ts` has no synthesis
// branch, `announcements.type` is narrowed to `'audio'` and there are no `tts_*`
// columns. A row that is not `'audio'` therefore resolves to `no_content`, and
// nothing is decoded. Mock specifiers: `@magick-agency/observability`,
// `@magick-agency/db/repositories/*`.
// ---------------------------------------------------------------------------

const { logSpy } = vi.hoisted(() => ({
  logSpy: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({
  logger: logSpy,
  createChildLogger: () => logSpy,
}));

const { announcements, audioFiles } = vi.hoisted(() => ({
  announcements: { findActiveByIdScoped: vi.fn() },
  audioFiles: { findById: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: announcements,
}));
vi.mock('@magick-agency/db/repositories/audio-file.repository', () => ({
  audioFileRepository: audioFiles,
}));

const { ensurePcmClip } = vi.hoisted(() => ({
  ensurePcmClip: vi.fn(),
}));
vi.mock('../../../src/audio/ensure-pcm-clip.js', () => ({ ensurePcmClip }));

import { resolveAbandonClip } from '../../../src/agency/abandon-clip.js';

/** The campaign's own tenancy — what the announcement is allowed to belong to. */
const SCOPE = { tenantId: 't1', accountId: 'a1' };

function audioAnnouncement(over: Record<string, unknown> = {}) {
  return {
    id: 'ann-2', tenant_id: 't1', account_id: 'a1', name: 'Recorded apology',
    type: 'audio',
    audio_file_id: 'af-1', is_active: true, ...over,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  ensurePcmClip.mockResolvedValue({ hash: 'pcm-hash', sampleRate: 8000 });
  audioFiles.findById.mockResolvedValue({ id: 'af-1', pcm_audio_hash: 'pcm-hash', pcm_sample_rate: 8000 });
});

describe('resolveAbandonClip — the four ways there is no clip', () => {
  it('reports `not_configured` for a null id, and never touches the DB', async () => {
    expect(await resolveAbandonClip(null, SCOPE)).toEqual({ hash: null, reason: 'not_configured' });
    expect(await resolveAbandonClip(undefined, SCOPE)).toEqual({ hash: null, reason: 'not_configured' });
    expect(await resolveAbandonClip('', SCOPE)).toEqual({ hash: null, reason: 'not_configured' });
    // The common case by far — most campaigns will never configure an apology.
    // A DB round trip per abandoned call to learn nothing is pure latency on the
    // one code path where the customer is already waiting.
    expect(announcements.findActiveByIdScoped).not.toHaveBeenCalled();
  });

  it('reports `not_found` for a dangling id rather than throwing', async () => {
    // The schema has NO foreign key here, deliberately, so an operator deleting
    // an announcement leaves exactly this state. It has to be survivable.
    announcements.findActiveByIdScoped.mockResolvedValue(null);
    expect(await resolveAbandonClip('gone', SCOPE)).toEqual({ hash: null, reason: 'not_found' });
  });

  it('reports `no_content` for an audio announcement with no file', async () => {
    announcements.findActiveByIdScoped.mockResolvedValue(audioAnnouncement({ audio_file_id: null }));
    expect(await resolveAbandonClip('ann-2', SCOPE)).toEqual({ hash: null, reason: 'no_content' });
    expect(ensurePcmClip).not.toHaveBeenCalled();
  });

  it('reports `no_content` when the referenced audio file row is gone', async () => {
    announcements.findActiveByIdScoped.mockResolvedValue(audioAnnouncement());
    audioFiles.findById.mockResolvedValue(null);
    expect(await resolveAbandonClip('ann-2', SCOPE)).toEqual({ hash: null, reason: 'no_content' });
    expect(ensurePcmClip).not.toHaveBeenCalled();
  });

  // A row that is not `'audio'` (the shape a TTS row used to have, now refused by the
  // baseline's CHECK) takes the `no_content` arm, and nothing is decoded.
  it('reports `no_content` for an announcement that is not an uploaded recording', async () => {
    for (const type of ['tts', '', 'video']) {
      announcements.findActiveByIdScoped.mockResolvedValue(audioAnnouncement({ type }));
      expect(await resolveAbandonClip('ann-2', SCOPE)).toEqual({ hash: null, reason: 'no_content' });
    }
    expect(ensurePcmClip).not.toHaveBeenCalled();
  });

  it('never reads an announcement outside the campaign’s own tenant/account', async () => {
    // The lookup itself must be scoped. A route-level ownership check happens at a
    // DIFFERENT TIME from this read — the column is written once and read on every
    // abandoned call after — so an admin tool, a support SQL fix or an
    // announcement that changes hands walks straight past it. The failure mode is
    // another tenant's recorded audio in a stranger's ear: inaudible to us, no log
    // line that looks wrong, unrepairable afterwards.
    await resolveAbandonClip('ann-1', { tenantId: 't1', accountId: 'a1' });
    expect(announcements.findActiveByIdScoped).toHaveBeenCalledWith('ann-1', 't1', 'a1');
    // Unscoped readers must not exist on this path at all — a `findById` here would
    // resolve any tenant's announcement by id alone.
    expect((announcements as Record<string, unknown>).findById).toBeUndefined();
  });

  it('resolves a FOREIGN announcement to no clip — silence, not someone else’s audio', async () => {
    // What a cross-tenant reference actually does now: the scoped lookup misses,
    // so it takes the same path as "never configured". The call still proceeds and
    // still settles — this must be silence, NOT another tenant's apology, and NOT
    // a throw that strands the customer on an open line.
    announcements.findActiveByIdScoped.mockResolvedValue(null);

    const result = await resolveAbandonClip('someone-elses-announcement', SCOPE);

    expect(result).toEqual({ hash: null, reason: 'not_found' });
    // Nothing was synthesized or decoded — no work was done on a foreign row.
    expect(ensurePcmClip).not.toHaveBeenCalled();
    // And the miss is logged with the scope, so a real cross-tenant reference is
    // findable rather than silently indistinguishable from an unconfigured campaign.
    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.objectContaining({ announcementId: 'someone-elses-announcement', tenantId: 't1', accountId: 'a1' }),
      expect.any(String),
    );
  });

  it('reports `failed` — not a throw — when the DB read blows up', async () => {
    announcements.findActiveByIdScoped.mockRejectedValue(new Error('connection terminated'));
    expect(await resolveAbandonClip('ann-1', SCOPE)).toEqual({ hash: null, reason: 'failed' });
  });

  it('reports `failed` — not a throw — when re-decoding the audio file blows up', async () => {
    // `ensurePcmClip` re-fetches from S3 on a cache miss, so this is the S3-down
    // and decode-timeout case: reachable on any replica that has never held the
    // clip, which is every replica the first time.
    announcements.findActiveByIdScoped.mockResolvedValue(audioAnnouncement());
    ensurePcmClip.mockRejectedValue(new Error('S3 fetch failed'));
    expect(await resolveAbandonClip('ann-2', SCOPE)).toEqual({ hash: null, reason: 'failed' });
  });
});

describe('resolveAbandonClip — the two ways there IS a clip', () => {
  it('resolves an uploaded recording through the shared PCM clip cache', async () => {
    announcements.findActiveByIdScoped.mockResolvedValue(audioAnnouncement());
    ensurePcmClip.mockResolvedValue({ hash: 'recorded-apology-hash', sampleRate: 8000 });

    expect(await resolveAbandonClip('ann-2', SCOPE)).toEqual({ hash: 'recorded-apology-hash' });
    // Routed through `ensurePcmClip` and not the row's stored hash: the cache is
    // node-local disk and is NOT authoritative, so a stored hash means "this
    // decoded once", never "the bytes are on this replica".
    expect(ensurePcmClip).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'af-1' }),
    );
  });

  it('is NOT memoized — a corrected apology takes effect on the next abandoned call', async () => {
    // Two uploaded recordings (decision #4); same property: two reads, two answers.
    announcements.findActiveByIdScoped
      .mockResolvedValueOnce(audioAnnouncement({ audio_file_id: 'af-wrong' }))
      .mockResolvedValueOnce(audioAnnouncement({ audio_file_id: 'af-corrected' }));
    audioFiles.findById.mockImplementation(async (id: string) => ({ id }));
    ensurePcmClip.mockImplementation(async (file: { id: string }) => ({ hash: `${file.id}-hash`, sampleRate: 8000 }));

    const first = await resolveAbandonClip('ann-2', SCOPE);
    const second = await resolveAbandonClip('ann-2', SCOPE);

    // Two reads, two texts. An in-process TTL here would mean an operator fixing
    // a bad apology mid-campaign keeps playing the bad one for up to the TTL.
    expect(announcements.findActiveByIdScoped).toHaveBeenCalledTimes(2);
    expect([first, second]).toEqual([{ hash: 'af-wrong-hash' }, { hash: 'af-corrected-hash' }]);
  });
});
