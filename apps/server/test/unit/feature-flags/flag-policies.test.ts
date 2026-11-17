import { afterEach, describe, expect, it, vi } from 'vitest';
import { envDefaultsPastPolicy, warnOfEnvDefaultsPastPolicy } from '../../../src/feature-flags/flag-policies.js';

/*
 * The env default of a flag whose handling policy refuses a global On (LS20 a): set in a
 * deployment's env, `FF_AGENCY_LIVE_LISTEN=true` turns the consent gate on for every tenant, with no
 * reason and no audit row, which the super-admin routes would refuse. It is a dev and staging
 * convenience; boot says so in a warning line rather than refusing it.
 */

afterEach(() => { vi.unstubAllEnvs(); });

describe('env defaults past a flag policy', () => {
  it('names the consent gate when its env default turns it on, and nothing otherwise', () => {
    vi.stubEnv('FF_AGENCY_LIVE_LISTEN', '');
    expect(envDefaultsPastPolicy()).toEqual([]);
    vi.stubEnv('FF_AGENCY_LIVE_LISTEN', 'false');
    expect(envDefaultsPastPolicy()).toEqual([]);
    vi.stubEnv('FF_AGENCY_LIVE_LISTEN', 'true');
    expect(envDefaultsPastPolicy()).toEqual([{ flag: 'agency_live_listen_enabled', envVar: 'FF_AGENCY_LIVE_LISTEN' }]);
  });

  it('warns once at boot for each, naming the flag and the env var', () => {
    const warn = vi.fn();
    vi.stubEnv('FF_AGENCY_LIVE_LISTEN', 'no');
    expect(warnOfEnvDefaultsPastPolicy(warn)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    vi.stubEnv('FF_AGENCY_LIVE_LISTEN', '1');
    expect(warnOfEnvDefaultsPastPolicy(warn)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = warn.mock.calls[0]!;
    expect(fields).toEqual({ flag: 'agency_live_listen_enabled', envVar: 'FF_AGENCY_LIVE_LISTEN' });
    expect(msg).toMatch(/every tenant/);
    expect(msg).toMatch(/dev and staging only/);
  });
});
