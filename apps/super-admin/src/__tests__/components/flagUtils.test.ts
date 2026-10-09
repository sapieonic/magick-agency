import { describe, it, expect } from 'vitest';
import { humanize, asBool, toTriState, relativeExpiry } from '../../components/super-admin/feature-flags/flagUtils';

describe('flagUtils.humanize', () => {
  it('title-cases plain snake_case tokens', () => {
    expect(humanize('new_dialer')).toBe('New Dialer');
    expect(humanize('beta')).toBe('Beta');
  });
  it('applies brand/acronym overrides per token', () => {
    expect(humanize('agency_dialer_enabled')).toBe('Agency Dialer Enabled');
    expect(humanize('ivr_tts_api')).toBe('IVR TTS API');
    expect(humanize('sms_ai')).toBe('SMS AI');
  });
});

describe('flagUtils.asBool', () => {
  it('treats only the literal true as On', () => {
    expect(asBool(true)).toBe(true);
    for (const v of [false, 1, 0, 'true', '', null, undefined, {}]) {
      expect(asBool(v)).toBe(false);
    }
  });
});

describe('flagUtils.toTriState', () => {
  it('maps absence to inherit', () => {
    expect(toTriState(null)).toBe('inherit');
    expect(toTriState(undefined)).toBe('inherit');
  });
  it('maps explicit boolean overrides', () => {
    expect(toTriState(true)).toBe('on');
    expect(toTriState(false)).toBe('off');
  });
});

describe('flagUtils.relativeExpiry', () => {
  it('reports past timestamps as expired', () => {
    expect(relativeExpiry(new Date(Date.now() - 60_000).toISOString())).toBe('expired');
  });
  it('reports whole days in the future', () => {
    expect(relativeExpiry(new Date(Date.now() + 3 * 86_400_000).toISOString())).toBe('in 3d');
  });
  it('reports hours for sub-day windows', () => {
    expect(relativeExpiry(new Date(Date.now() + 5 * 3_600_000).toISOString())).toBe('in 5h');
  });
  it('never floors a still-future expiry to 0h', () => {
    expect(relativeExpiry(new Date(Date.now() + 20 * 60_000).toISOString())).toBe('in 1h');
  });
});
