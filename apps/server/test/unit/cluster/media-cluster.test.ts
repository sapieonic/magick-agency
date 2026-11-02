import { afterEach, describe, expect, it } from 'vitest';
import { MediaCluster } from '../../../src/cluster/media-cluster.js';
import { parseConfig } from '../../../src/config/load.js';
import { EMPTY_SNAPSHOT, FakeChildProcess } from '../../helpers/fake-child-process.js';

/*
 * The primary's MediaCluster against fake media children: what it asks its workers and
 * when, without a database (no request here resolves a session from a row).
 */

function cluster(opts: Partial<ConstructorParameters<typeof MediaCluster>[0]> = {}) {
  const forks: FakeChildProcess[] = [];
  const c = new MediaCluster({
    count: 2,
    fork: (slot) => {
      const child = new FakeChildProcess('media', slot);
      child.handlers.set('reaper.snapshot', () => EMPTY_SNAPSHOT);
      forks.push(child);
      setImmediate(() => child.ready());
      return child.asChild();
    },
    readOwner: async () => null,
    setAgentOffline: async () => {},
    readyTimeoutMs: 2_000,
    ...opts,
  });
  return { c, forks };
}

let running: MediaCluster | null = null;
afterEach(async () => {
  await running?.stop(1_000);
  running = null;
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('MediaCluster snapshot refresh', () => {
  it('MEDIA_SNAPSHOT_REFRESH_MS comes through config: 5 s by default, 0 allowed (off)', () => {
    const env = { DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency', REDIS_URL: 'redis://localhost:6383/0' };
    const parse = (extra: Record<string, string>) => {
      const r = parseConfig({ ...env, ...extra });
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      return r.config.processes.mediaSnapshotRefreshMs;
    };
    expect(parse({})).toBe(5_000);
    expect(parse({ MEDIA_SNAPSHOT_REFRESH_MS: '0' })).toBe(0);
    expect(parseConfig({ ...env, MEDIA_SNAPSHOT_REFRESH_MS: '-1' }).ok).toBe(false);
  });

  it('refreshes every worker\'s snapshot at the configured interval', async () => {
    const { c, forks } = cluster({ snapshotRefreshMs: 20 });
    running = c;
    await c.start();
    await sleep(150);
    for (const f of forks) expect(f.requests('reaper.snapshot').length).toBeGreaterThanOrEqual(3);
  });

  it('with 0, asks once at start and never again', async () => {
    const { c, forks } = cluster({ snapshotRefreshMs: 0 });
    running = c;
    await c.start();
    await sleep(150);
    for (const f of forks) expect(f.requests('reaper.snapshot')).toHaveLength(1);
  });
});
