import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * A legacy zone name is mapped to its current one only when this browser knows the current one:
 * an ICU that predates a rename (it knows `Asia/Calcutta`, not `Asia/Kolkata`) keeps the name it
 * can format in, so the reader's zone never falls to UTC for want of a name it was mapped to.
 */

const RealDateTimeFormat = Intl.DateTimeFormat;

/** An `Intl` that refuses `unknown` zones and reports `reported` as the reader's. */
function oldIcu(unknown: readonly string[], reported: string) {
  const Fake = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    if (options?.timeZone && unknown.includes(options.timeZone)) throw new RangeError(`Invalid time zone specified: ${options.timeZone}`);
    if (locales === undefined && options === undefined) {
      const real = new RealDateTimeFormat();
      return { ...real, format: real.format, formatToParts: real.formatToParts.bind(real), resolvedOptions: () => ({ ...real.resolvedOptions(), timeZone: reported }) };
    }
    return new RealDateTimeFormat(locales, options);
  } as unknown as typeof Intl.DateTimeFormat;
  const intl = Object.create(Intl) as typeof Intl;
  Object.defineProperty(intl, 'DateTimeFormat', { value: Fake });
  Object.defineProperty(intl, 'supportedValuesOf', { value: () => ['Asia/Calcutta', 'Asia/Tokyo', 'Europe/Kiev'] });
  vi.stubGlobal('Intl', intl);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('a legacy zone on a browser that does not know its current name', () => {
  it('keeps the legacy name for the reader’s zone, never UTC', async () => {
    oldIcu(['Asia/Kolkata', 'Europe/Kyiv'], 'Asia/Calcutta');
    vi.resetModules();
    const { currentZoneName, readerZone } = await import('../../utils/format/date');
    const { browserZone, reportZoneOptions } = await import('../../utils/reports/reportWindow');
    expect(currentZoneName('Asia/Calcutta')).toBe('Asia/Calcutta');
    expect(currentZoneName('Europe/Kiev')).toBe('Europe/Kiev');
    expect(readerZone()).toBe('Asia/Calcutta');
    expect(browserZone()).toBe('Asia/Calcutta');
    const zones = reportZoneOptions('Asia/Calcutta');
    expect(zones).toContain('Asia/Calcutta');
    expect(zones).not.toContain('Asia/Kolkata');
  });

  it('maps it where the current name is known', async () => {
    oldIcu([], 'Asia/Calcutta');
    vi.resetModules();
    const { currentZoneName, readerZone } = await import('../../utils/format/date');
    expect(currentZoneName('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(readerZone()).toBe('Asia/Kolkata');
  });
});
