import { describe, it, expect } from 'vitest';
import {
  TELEPHONY_PROVIDER_ALIASES,
  normalizeTelephonyProviderKey,
  hasTelephonyProviderAlias,
  telephonyProviderAlias,
} from '../../config/telephonyProviders';

describe('TELEPHONY_PROVIDER_ALIASES', () => {
  it('maps every known slug to a non-empty alias that is not the vendor slug', () => {
    for (const [slug, alias] of Object.entries(TELEPHONY_PROVIDER_ALIASES)) {
      expect(alias.trim().length).toBeGreaterThan(0);
      expect(alias.toLowerCase()).not.toBe(slug);
    }
  });

  it('never uses a vendor brand as the alias', () => {
    const vendorBrands = [
      'twilio', 'plivo', 'exotel', 'vobiz', 'voicelink', 'telnyx', 'z99',
      'generic sip', 'generic_sip',
    ];
    const aliases = Object.values(TELEPHONY_PROVIDER_ALIASES).map((a) => a.toLowerCase());
    for (const brand of vendorBrands) {
      expect(aliases).not.toContain(brand);
    }
  });
});

describe('normalizeTelephonyProviderKey', () => {
  it('lowercases, trims, and turns spaces/hyphens into underscores', () => {
    expect(normalizeTelephonyProviderKey('  VoBiz  ')).toBe('vobiz');
    expect(normalizeTelephonyProviderKey('VoiceLink')).toBe('voicelink');
    expect(normalizeTelephonyProviderKey('Generic SIP')).toBe('generic_sip');
    expect(normalizeTelephonyProviderKey('generic-sip')).toBe('generic_sip');
  });
});

describe('hasTelephonyProviderAlias', () => {
  it('is true only for mapped slugs', () => {
    expect(hasTelephonyProviderAlias('vobiz')).toBe(true);
    expect(hasTelephonyProviderAlias(' VoBiz ')).toBe(true);
    expect(hasTelephonyProviderAlias('vonage')).toBe(false);
    expect(hasTelephonyProviderAlias('constructor')).toBe(false);
    expect(hasTelephonyProviderAlias('')).toBe(false);
    expect(hasTelephonyProviderAlias(null)).toBe(false);
  });
});

describe('telephonyProviderAlias', () => {
  it('returns the Indian alias for known slugs', () => {
    expect(telephonyProviderAlias('twilio')).toBe('Tarang');
    expect(telephonyProviderAlias('plivo')).toBe('Pravah');
    expect(telephonyProviderAlias('exotel')).toBe('Ekvani');
    expect(telephonyProviderAlias('vobiz')).toBe('Vaani');
    expect(telephonyProviderAlias('telnyx')).toBe('Tejas');
    expect(telephonyProviderAlias('voicelink')).toBe('Swar');
    expect(telephonyProviderAlias('z99')).toBe('Navtara');
    expect(telephonyProviderAlias('generic_sip')).toBe('Sanchar');
  });

  it('resolves vendor display names and mixed case', () => {
    expect(telephonyProviderAlias('Twilio')).toBe('Tarang');
    expect(telephonyProviderAlias('VoBiz')).toBe('Vaani');
    expect(telephonyProviderAlias('Vobiz')).toBe('Vaani');
    expect(telephonyProviderAlias('VoiceLink')).toBe('Swar');
    expect(telephonyProviderAlias('Generic SIP')).toBe('Sanchar');
    expect(telephonyProviderAlias(' Telnyx ')).toBe('Tejas');
  });

  it('returns the trimmed slug for unknown providers', () => {
    expect(telephonyProviderAlias('bandwidth')).toBe('bandwidth');
    expect(telephonyProviderAlias('vonage')).toBe('vonage');
    expect(telephonyProviderAlias(' vonage ')).toBe('vonage');
  });

  it('prefers the API display name for unknown providers', () => {
    expect(telephonyProviderAlias('airtel_iq', 'Airtel IQ')).toBe('Airtel IQ');
    expect(telephonyProviderAlias('airtel_iq', '  Airtel IQ  ')).toBe('Airtel IQ');
    // Mapped slugs still win over a display-name fallback.
    expect(telephonyProviderAlias('vobiz', 'VoBiz')).toBe('Vaani');
  });

  it('does not resolve Object.prototype keys as aliases', () => {
    expect(telephonyProviderAlias('constructor')).toBe('constructor');
    expect(telephonyProviderAlias('toString')).toBe('toString');
    expect(telephonyProviderAlias('valueOf')).toBe('valueOf');
    expect(telephonyProviderAlias('hasOwnProperty')).toBe('hasOwnProperty');
    expect(typeof telephonyProviderAlias('constructor')).toBe('string');
    expect(telephonyProviderAlias('constructor', 'Safe Label')).toBe('Safe Label');
  });

  it('returns empty for null, undefined, or blank', () => {
    expect(telephonyProviderAlias(null)).toBe('');
    expect(telephonyProviderAlias(undefined)).toBe('');
    expect(telephonyProviderAlias('')).toBe('');
    expect(telephonyProviderAlias('   ')).toBe('');
    expect(telephonyProviderAlias(null, 'Airtel IQ')).toBe('Airtel IQ');
    expect(telephonyProviderAlias('   ', 'Airtel IQ')).toBe('Airtel IQ');
  });
});
