import { describe, expect, it } from 'vitest';
import { parseClientHeader } from '../../../src/utils/client-header.js';

// `X-Client`: the mobile app names itself; everything else is the web, and a web UI may
// name itself and its version (`<app>/<semver>`). Client-declared, so the parser's only
// duties are to recognise the app and never let the header become something else (an
// oversized or hostile value is still just `web` or a bare `mobile`).
describe('parseClientHeader', () => {
  it('reads the mobile app\'s header: kind, version and platform', () => {
    expect(parseClientHeader('magick-agency-mobile/1.4.0+212 (android 14; Pixel 8)')).toEqual({
      kind: 'mobile', app: 'magick-agency-mobile', version: '1.4.0+212', platform: 'android',
    });
    expect(parseClientHeader('magick-agency-mobile/0.9.1+7 (ios 17.5; iPhone15,2)')).toEqual({
      kind: 'mobile', app: 'magick-agency-mobile', version: '0.9.1+7', platform: 'ios',
    });
  });

  it('is mobile on the prefix alone; a missing or odd detail just drops that field', () => {
    const app = 'magick-agency-mobile';
    expect(parseClientHeader('magick-agency-mobile/2.0.0')).toEqual({ kind: 'mobile', app, version: '2.0.0' });
    expect(parseClientHeader('magick-agency-mobile/2.0.0 (windows 11)')).toEqual({ kind: 'mobile', app, version: '2.0.0' });
    expect(parseClientHeader('Magick-Agency-Mobile/1.0.0 (IOS 18)')).toEqual({ kind: 'mobile', app, version: '1.0.0', platform: 'ios' });
    // A version token that is not one is not logged.
    expect(parseClientHeader('magick-agency-mobile/1.0"}\n{"x":1')).toEqual({ kind: 'mobile', app });
    expect(parseClientHeader('magick-agency-mobile/')).toEqual({ kind: 'mobile', app });
  });

  it('is a bare web for no header and for one not in the `<app>/<version>` shape', () => {
    for (const value of [undefined, null, '', '   ', 'x magick-agency-mobile/1.0', 'magick-agency-mobile', 'Mozilla 5.0']) {
      expect(parseClientHeader(value as string | undefined), String(value)).toEqual({ kind: 'web' });
    }
  });

  it('reads a web UI\'s `<app>/<version>`: still web, with its app and version', () => {
    expect(parseClientHeader('magick-agency-console/0.29.0')).toEqual({ kind: 'web', app: 'magick-agency-console', version: '0.29.0' });
    expect(parseClientHeader('magick-agency-super-admin/0.6.2')).toEqual({ kind: 'web', app: 'magick-agency-super-admin', version: '0.6.2' });
    // A near miss of the mobile prefix is a web app by that name, never mobile.
    expect(parseClientHeader('magick-agency-mobil/1.0')).toEqual({ kind: 'web', app: 'magick-agency-mobil', version: '1.0' });
    // Any brand id the console accepts (`VALID_BRAND_ID`: digits first, underscores) is read.
    expect(parseClientHeader('acme_co-console/1.0.0')).toEqual({ kind: 'web', app: 'acme_co-console', version: '1.0.0' });
    expect(parseClientHeader('9dots-super-admin/2.0.0')).toEqual({ kind: 'web', app: '9dots-super-admin', version: '2.0.0' });
    // Any other `<name>/<version>` is logged as the caller gave it: not proof it is ours.
    expect(parseClientHeader('curl/8.5.0')).toEqual({ kind: 'web', app: 'curl', version: '8.5.0' });
    // A detail after the token is allowed for any app, and only the mobile app's names a platform.
    expect(parseClientHeader('Mozilla/5.0 (X11; Linux x86_64)')).toEqual({ kind: 'web', app: 'mozilla', version: '5.0' });
    expect(parseClientHeader('magick-agency-console/1.0.0 (ios 17)')).toEqual({ kind: 'web', app: 'magick-agency-console', version: '1.0.0' });
  });

  it('never lets a web header carry anything but a plain name and version', () => {
    // A name that is not one: nothing is read.
    for (const value of ['magick-agency-console"x/0.29.0', '/0.29.0', '-console/1.0.0', `${'a'.repeat(65)}/1.0.0`]) {
      expect(parseClientHeader(value), value).toEqual({ kind: 'web' });
    }
    // A version that is not one: the name alone.
    for (const value of ['magick-agency-console/0.29.0"}\n{"x":1', 'magick-agency-console/', `magick-agency-console/${'9'.repeat(41)}`]) {
      expect(parseClientHeader(value), value).toEqual({ kind: 'web', app: 'magick-agency-console' });
    }
  });

  it('takes the first of a repeated header', () => {
    expect(parseClientHeader(['magick-agency-mobile/1.0.0 (ios 17)', 'Mozilla/5.0']).kind).toBe('mobile');
    expect(parseClientHeader(['Mozilla/5.0', 'magick-agency-mobile/1.0.0']).kind).toBe('web');
  });

  it('bounds what it parses: a huge header costs nothing and yields no version', () => {
    const huge = `magick-agency-mobile/${'9'.repeat(100_000)}`;
    expect(parseClientHeader(huge)).toEqual({ kind: 'mobile', app: 'magick-agency-mobile' });
    expect(parseClientHeader(`magick-agency-console/${'9'.repeat(100_000)}`)).toEqual({ kind: 'web', app: 'magick-agency-console' });
  });
});
