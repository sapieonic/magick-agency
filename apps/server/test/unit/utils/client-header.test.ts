import { describe, expect, it } from 'vitest';
import { parseClientHeader } from '../../../src/utils/client-header.js';

// `X-Client`: the mobile app names itself; everything else is the web. Client-declared,
// so the parser's only duties are to recognise the app and never let the header become
// something else (an oversized or hostile value is still just `web` or a bare `mobile`).
describe('parseClientHeader', () => {
  it('reads the mobile app\'s header: kind, version and platform', () => {
    expect(parseClientHeader('magick-agency-mobile/1.4.0+212 (android 14; Pixel 8)')).toEqual({
      kind: 'mobile', version: '1.4.0+212', platform: 'android',
    });
    expect(parseClientHeader('magick-agency-mobile/0.9.1+7 (ios 17.5; iPhone15,2)')).toEqual({
      kind: 'mobile', version: '0.9.1+7', platform: 'ios',
    });
  });

  it('is mobile on the prefix alone; a missing or odd detail just drops that field', () => {
    expect(parseClientHeader('magick-agency-mobile/2.0.0')).toEqual({ kind: 'mobile', version: '2.0.0' });
    expect(parseClientHeader('magick-agency-mobile/2.0.0 (windows 11)')).toEqual({ kind: 'mobile', version: '2.0.0' });
    expect(parseClientHeader('Magick-Agency-Mobile/1.0.0 (IOS 18)')).toEqual({ kind: 'mobile', version: '1.0.0', platform: 'ios' });
    // A version token that is not one is not logged.
    expect(parseClientHeader('magick-agency-mobile/1.0"}\n{"x":1')).toEqual({ kind: 'mobile' });
    expect(parseClientHeader('magick-agency-mobile/')).toEqual({ kind: 'mobile' });
  });

  it('is web for no header and for anything that is not the mobile app', () => {
    for (const value of [undefined, null, '', '   ', 'Mozilla/5.0 (X11; Linux x86_64)', 'magick-agency-mobil/1.0', 'x magick-agency-mobile/1.0']) {
      expect(parseClientHeader(value as string | undefined), String(value)).toEqual({ kind: 'web' });
    }
  });

  it('takes the first of a repeated header', () => {
    expect(parseClientHeader(['magick-agency-mobile/1.0.0 (ios 17)', 'Mozilla/5.0']).kind).toBe('mobile');
    expect(parseClientHeader(['Mozilla/5.0', 'magick-agency-mobile/1.0.0']).kind).toBe('web');
  });

  it('bounds what it parses: a huge header costs nothing and yields no version', () => {
    const huge = `magick-agency-mobile/${'9'.repeat(100_000)}`;
    expect(parseClientHeader(huge)).toEqual({ kind: 'mobile' });
  });
});
