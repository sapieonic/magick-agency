import { describe, it, expect, vi } from 'vitest';
import {
  CUE_PREFS_STORAGE_KEY,
  DEFAULT_CUE_PREFS,
  clampCueVolume,
  normalizeCuePrefs,
  readCuePrefs,
  writeCuePrefs,
} from '../../utils/agencyCuePrefs';
import { escalatedVisualActive } from '../../utils/agencyCues';

/**
 * The cue preferences — criterion (c), "the preference is settable,
 * not just readable".
 *
 * The parse is unit-tested away from the popover because the failure mode it
 * guards is invisible in a component: `escalatedVisualActive` branches on
 * `volume === 0`, and a `NaN` volume is neither `> 0` (so the cue never plays) nor
 * `=== 0` (so the escalation never turns on). A corrupted key would therefore leave
 * an agent with **no channel at all** — silent cues and no flash — and nothing on
 * screen would look wrong.
 */

function memoryStorage(initial?: string): Pick<Storage, 'getItem' | 'setItem'> & {
  written: string[];
} {
  let value: string | null = initial ?? null;
  const written: string[] = [];
  return {
    written,
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
      written.push(next);
    },
  };
}

describe('the defaults do not change what a silent upgrade sounds like', () => {
  it('is `auto` at 70%, which is what the two deleted module constants held', () => {
    // Shipping a settings surface must not also change what an agent who never
    // opens it hears. `auto` at 70 was `DEFAULT_CONNECT_FLASH`/`DEFAULT_CUE_VOLUME`.
    expect(DEFAULT_CUE_PREFS).toEqual({ volume: 70, connectFlash: 'auto' });
    // And at those defaults a hearing agent with working sound gets no flash —
    // the property the whole subsystem's restraint rests on.
    expect(
      escalatedVisualActive({
        setting: DEFAULT_CUE_PREFS.connectFlash,
        volume: DEFAULT_CUE_PREFS.volume,
        audible: true,
      }),
    ).toBe(false);
  });
});

describe('clampCueVolume', () => {
  it('keeps 0 as a real setting and refuses NaN, which would silence both channels', () => {
    // 0 is permitted and must survive the clamp as 0 — coercing it to the
    // default would override an agent who chose to work in silence.
    expect(clampCueVolume(0)).toBe(0);
    expect(escalatedVisualActive({ setting: 'auto', volume: clampCueVolume(0), audible: true })).toBe(
      true,
    );

    expect(clampCueVolume(100)).toBe(100);
    expect(clampCueVolume(-40)).toBe(0);
    expect(clampCueVolume(140)).toBe(100);
    expect(clampCueVolume(42.6)).toBe(43);
    // The one that matters: NaN is `> 0` false AND `=== 0` false, so it mutes the
    // cue and fails to escalate. It must never reach the dispatcher.
    expect(clampCueVolume(Number.NaN)).toBe(DEFAULT_CUE_PREFS.volume);
    expect(clampCueVolume('not a number')).toBe(DEFAULT_CUE_PREFS.volume);
    expect(clampCueVolume(undefined)).toBe(DEFAULT_CUE_PREFS.volume);
    expect(clampCueVolume(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CUE_PREFS.volume);
  });
});

describe('normalizeCuePrefs', () => {
  it('accepts the three real settings and rejects anything else', () => {
    expect(normalizeCuePrefs({ volume: 30, connectFlash: 'always' })).toEqual({
      volume: 30,
      connectFlash: 'always',
    });
    expect(normalizeCuePrefs({ volume: 0, connectFlash: 'never' })).toEqual({
      volume: 0,
      connectFlash: 'never',
    });
    // An unknown string must fall back to `auto` rather than being passed through:
    // `escalatedVisualActive` returns the auto branch for anything not
    // `always`/`never`, so a typo would *look* like it worked while being ignored.
    expect(normalizeCuePrefs({ volume: 50, connectFlash: 'sometimes' }).connectFlash).toBe('auto');
    expect(normalizeCuePrefs(null)).toEqual(DEFAULT_CUE_PREFS);
    expect(normalizeCuePrefs('auto')).toEqual(DEFAULT_CUE_PREFS);
    expect(normalizeCuePrefs({})).toEqual(DEFAULT_CUE_PREFS);
  });
});

describe('readCuePrefs / writeCuePrefs', () => {
  it('round-trips through storage under the versioned key', () => {
    const storage = memoryStorage();
    writeCuePrefs(storage, { volume: 0, connectFlash: 'always' });

    // The value the agent set, not the default — a round-trip that returned the
    // defaults would pass an `toEqual(DEFAULT_CUE_PREFS)` assertion while storing
    // nothing at all.
    expect(readCuePrefs(storage)).toEqual({ volume: 0, connectFlash: 'always' });
    expect(storage.written).toEqual(['{"volume":0,"connectFlash":"always"}']);
    expect(CUE_PREFS_STORAGE_KEY).toBe('magick-agency.cuePrefs.v1');
  });

  it('defaults on absent, on garbage, and on a store that throws', () => {
    expect(readCuePrefs(memoryStorage())).toEqual(DEFAULT_CUE_PREFS);
    expect(readCuePrefs(memoryStorage('not json at all'))).toEqual(DEFAULT_CUE_PREFS);
    expect(readCuePrefs(memoryStorage('{"volume":"loud"}'))).toEqual(DEFAULT_CUE_PREFS);
    expect(readCuePrefs(undefined)).toEqual(DEFAULT_CUE_PREFS);

    /**
     * `localStorage` itself throws on access in a browser with site data blocked.
     * A console that will not open because a *display preference* could not be read
     * is a worse outcome than a console with default cues.
     */
    const hostile = {
      getItem: vi.fn(() => {
        throw new Error('access denied');
      }),
      setItem: vi.fn(() => {
        throw new Error('quota exceeded');
      }),
    };
    expect(readCuePrefs(hostile)).toEqual(DEFAULT_CUE_PREFS);
    expect(() => writeCuePrefs(hostile, DEFAULT_CUE_PREFS)).not.toThrow();
    // And it did try — a `not.toThrow()` on a function that was never called passes
    // whatever the implementation does.
    expect(hostile.getItem).toHaveBeenCalledWith(CUE_PREFS_STORAGE_KEY);
    expect(hostile.setItem).toHaveBeenCalled();
  });

  it('normalises on the way in as well as out, so a bad write cannot become a bad read', () => {
    const storage = memoryStorage();
    writeCuePrefs(storage, { volume: 500, connectFlash: 'nonsense' as never });
    expect(readCuePrefs(storage)).toEqual({ volume: 100, connectFlash: 'auto' });
  });
});
