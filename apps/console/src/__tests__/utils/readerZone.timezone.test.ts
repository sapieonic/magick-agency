import { describe, it, expect } from 'vitest';
import { LEGACY_ZONE_NAMES, currentZoneName, readerZone } from '../../utils/format/date';
import { browserZone, reportZoneOptions } from '../../utils/reports/reportWindow';

/**
 * The reader's zone by its current IANA name. ICU, so Chromium and Node, reports India as its
 * legacy canonical ID `Asia/Calcutta` (and lists it so in `Intl.supportedValuesOf`); the console
 * sends Compare agents and the report exports `Asia/Kolkata`, the name the product stores. In a
 * `.timezone.test.ts` file, so the `TZ` set here really moves what `Intl` resolves.
 */
function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env['TZ'];
  process.env['TZ'] = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  }
}

describe('the reader’s zone, by its current name', () => {
  it('reads India as Asia/Kolkata, whichever name the environment was given', () => {
    for (const tz of ['Asia/Kolkata', 'Asia/Calcutta']) {
      expect(inZone(tz, () => readerZone())).toBe('Asia/Kolkata');
      // The default zone of a report export and of Compare agents' query.
      expect(inZone(tz, () => browserZone())).toBe('Asia/Kolkata');
    }
  });

  it('maps every legacy alias, and leaves a current name or an unknown one as given', () => {
    expect(LEGACY_ZONE_NAMES).toEqual({
      'Asia/Calcutta': 'Asia/Kolkata',
      'Asia/Saigon': 'Asia/Ho_Chi_Minh',
      'Asia/Katmandu': 'Asia/Kathmandu',
      'Asia/Rangoon': 'Asia/Yangon',
      'Europe/Kiev': 'Europe/Kyiv',
      'Asia/Dacca': 'Asia/Dhaka',
      'Asia/Thimbu': 'Asia/Thimphu',
    });
    expect(currentZoneName('Asia/Saigon')).toBe('Asia/Ho_Chi_Minh');
    expect(currentZoneName('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(inZone('Asia/Saigon', () => readerZone())).toBe('Asia/Ho_Chi_Minh');
    expect(inZone('Europe/Kiev', () => browserZone())).toBe('Europe/Kyiv');
    expect(inZone('Asia/Tokyo', () => browserZone())).toBe('Asia/Tokyo');
  });

  it('offers the export’s zone list by current names, once each, keeping a stored legacy zone it is given', () => {
    const zones = reportZoneOptions('Asia/Kolkata');
    expect(zones).toContain('Asia/Kolkata');
    expect(zones).not.toContain('Asia/Calcutta');
    expect(zones.filter((z) => z === 'Asia/Kolkata')).toHaveLength(1);
    for (const legacy of Object.keys(LEGACY_ZONE_NAMES)) expect(zones).not.toContain(legacy);
    // A subscription saved with the old name keeps it on screen, never silently swapped.
    expect(reportZoneOptions('Asia/Calcutta')).toContain('Asia/Calcutta');
    // …in place of its current name: the one zone is never offered twice.
    expect(reportZoneOptions('Asia/Calcutta')).not.toContain('Asia/Kolkata');
    expect(reportZoneOptions('Asia/Calcutta')).toContain('Asia/Tokyo');
  });
});
