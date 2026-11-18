import { describe, it, expect, vi } from 'vitest';

/*
 * The operator re-queue's command line, and the pin between the message the analysis runner
 * stores for a refused recording host (`RecordingHostRefusedError`, through
 * `TranscriptionError`) and the selector the repository matches it with
 * (`RECORDING_HOST_REFUSAL_MESSAGE`): a reworded refusal must turn this red, or the script
 * would silently match nothing. The selection and the re-queue run on real Postgres in
 * `test/integration/scripts/requeue-recording-host-refusals.test.ts`.
 */
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { parseArgs } = await import('../../../scripts/requeue-recording-host-refusals.js');
const { RECORDING_HOST_REFUSAL_MESSAGE } = await import('@magick-agency/db/repositories/dialer-analysis-job.repository');
const { RecordingHostRefusedError } = await import('../../../src/utils/recording-proxy.js');
const { fetchRecordingBytes } = await import('../../../src/transcription/recording-fetcher.js');

/** Postgres `~` and JS RegExp agree on this pattern (anchors, a class, a group, `?`). */
const matches = (message: string) => new RegExp(RECORDING_HOST_REFUSAL_MESSAGE).test(message);

describe('the stored host-refusal message matches the re-queue selector', () => {
  it('a refused first URL and a refused redirect hop match', () => {
    expect(matches(new RecordingHostRefusedError('aps1.media.plivo.com', 'off_list', 0).message)).toBe(true);
    expect(matches(new RecordingHostRefusedError('files.example', 'off_list', 2, 'media.plivo.com').message)).toBe(true);
  });

  it('the message the analysis fetch really throws (what markFailed stores) matches', async () => {
    const err = await fetchRecordingBytes('https://evilmedia.plivo.com/r.mp3', {
      maxBytes: 10, timeoutMs: 1000, allowedHosts: ['media.plivo.com'],
    }).then(() => null, (e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'TRANSCRIPTION_FAILED', retryable: false });
    expect(matches(err!.message)).toBe(true);
  });

  it('a too-many-redirects refusal and an unparseable URL do not: no allow-list fix cures them', () => {
    expect(matches(new RecordingHostRefusedError(null, 'too_many_redirects', 4, 'media.plivo.com').message)).toBe(false);
    expect(matches(new RecordingHostRefusedError(null, 'off_list', 0).message)).toBe(false);
  });
});

describe('requeue-recording-host-refusals: the command line', () => {
  it('is a dry run over every host refusal by default, at most 1000', () => {
    expect(parseArgs([])).toEqual({ ok: true, args: { limit: 1000, apply: false } });
  });

  it('takes a host (lowercased), a tenant, a failure window, a limit and --apply', () => {
    const parsed = parseArgs([
      '--host', 'APS1.media.plivo.com', '--tenant', '11111111-1111-4111-8111-111111111111',
      '--since', '2026-11-17T00:00:00Z', '--before', '2026-11-19T00:00:00Z', '--limit', '50', '--apply',
    ]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        host: 'aps1.media.plivo.com', tenantId: '11111111-1111-4111-8111-111111111111',
        failedSince: new Date('2026-11-17T00:00:00Z'), failedBefore: new Date('2026-11-19T00:00:00Z'),
        limit: 50, apply: true,
      },
    });
  });

  it.each([
    [['--tenant', 'not-a-uuid'], /--tenant/],
    [['--tenant'], /--tenant/],
    [['--since', 'yesterday'], /--since/],
    [['--before'], /--before/],
    [['--host', 'https://aps1.media.plivo.com/'], /--host/],
    [['--host', 'aps1.media.plivo.com:443'], /--host/],
    [['--host', '%'], /--host/],
    [['--limit', '0'], /--limit/],
    [['--limit', '10001'], /--limit/],
    [['--limit', '2.5'], /--limit/],
    [['--dry-run'], /unknown argument/],
  ])('refuses %j', (argv, error) => {
    const parsed = parseArgs(argv);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(error);
  });
});
