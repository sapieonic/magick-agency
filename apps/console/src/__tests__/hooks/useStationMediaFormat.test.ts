import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { AGENCY_FLAGS } from '@magick-agency/contracts/flags';

const flags = vi.hoisted(() => ({ provider: true, on: new Set<string>() }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => {
    if (!flags.provider) throw new Error('useFeatureFlags must be used within FeatureFlagsProvider');
    return { isEnabled: (flag: string) => flags.on.has(flag) };
  },
}));

import { CONSOLE_ALAW8_FLAG, useStationMediaFormat } from '../../hooks/useFeatureFlagEnabled';

/**
 * The tenant's way back from `alaw8`: the `agency_console_alaw8` flag picks the station
 * socket's media format. On (its server default) the console speaks binary A-law; off,
 * it speaks base64 PCM16. Whenever the flags cannot be read it speaks `pcm16`, the
 * format every server accepts: a costlier call, never a silent one.
 */
describe('useStationMediaFormat', () => {
  beforeEach(() => {
    flags.provider = true;
    flags.on = new Set();
  });

  it('is alaw8 with the flag on', () => {
    flags.on.add('agency_console_alaw8');
    expect(renderHook(() => useStationMediaFormat()).result.current).toBe('alaw8');
  });

  it('falls back to pcm16 with the flag off', () => {
    expect(renderHook(() => useStationMediaFormat()).result.current).toBe('pcm16');
  });

  it('falls back to pcm16 with no flag provider (flags unreadable)', () => {
    flags.provider = false;
    flags.on.add('agency_console_alaw8');
    expect(renderHook(() => useStationMediaFormat()).result.current).toBe('pcm16');
  });

  it('reads the contracts flag, which is on by default and visible to the console', () => {
    expect(CONSOLE_ALAW8_FLAG).toBe('agency_console_alaw8');
    expect(AGENCY_FLAGS.agency_console_alaw8.default).toBe(true);
    expect(AGENCY_FLAGS.agency_console_alaw8.clientExposed).toBe(true);
  });
});
