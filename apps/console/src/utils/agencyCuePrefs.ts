import type { ConnectFlashSetting } from './agencyCues';

/**
 * The agent's cue preferences — the settings half of `AD-P2-U-07`.
 *
 * ── Why this is a module and not two `useState` calls ─────────────────────────
 * `escalatedVisualActive` has read a volume and a `ConnectFlashSetting` since
 * `AD-P2-U-02`, and **nothing set either of them.** The values were module
 * constants with a comment explaining that inventing a persisted preference with
 * no UI would be a dead control panel — correct at the time, and the reason the
 * escalation was reachable only by an `AudioContext` the browser refused to run.
 * A deaf agent could not turn it on.
 *
 * The parse lives here, pure and injectable, because it is the part that can be
 * got wrong in ways a component test would not notice: a `volume` of `NaN`
 * compares false against `> 0`, so a corrupted key would silently mute the cues
 * *and* — via `escalatedVisualActive`'s `volume === 0` — silently fail to turn the
 * flash on either, leaving an agent with no channel at all. Every value that
 * reaches the dispatcher is clamped and re-validated here first.
 */

export interface CuePrefs {
  /**
   * 0–100. **0 is a permitted setting, not an error** (§A.4.3.1) — an agent is
   * allowed to work in silence, and `escalatedVisualActive` turns the visual
   * channel on permanently when they do.
   */
  volume: number;
  /**
   * The visual escalation's override. `auto` means "on when the cue cannot do the
   * job"; `always` and `never` are the agent's explicit choice, filed under
   * display with **no disclosure of any kind** — an agent who needs `always` sets
   * it without telling their employer anything about themselves.
   */
  connectFlash: ConnectFlashSetting;
}

/**
 * `auto` and 70%, which is what the two deleted module constants
 * (`DEFAULT_CONNECT_FLASH`, `DEFAULT_CUE_VOLUME`) held. Unchanged deliberately:
 * shipping a settings surface must not also change what an agent who never opens
 * it hears.
 */
export const DEFAULT_CUE_PREFS: CuePrefs = { volume: 70, connectFlash: 'auto' };

/**
 * Versioned, and **per browser rather than per agent**.
 *
 * A cue volume is a property of the room and the headset in front of this
 * machine, not of the person's account — and a hot-desking agent who sat at a
 * quiet station yesterday should not carry that station's volume to a loud one.
 * The `v1` suffix is so a future shape change is a fresh default rather than a
 * parse of something that no longer means what it says.
 */
// PORT NOTE (magick-agency, decision B17): renamed from cusui's `magickvoice.agency.cuePrefs.v1`; no stored values to migrate.
export const CUE_PREFS_STORAGE_KEY = 'magick-agency.cuePrefs.v1';

const FLASH_SETTINGS: readonly ConnectFlashSetting[] = ['auto', 'always', 'never'];

/** 0–100, integral, and never `NaN` — see the note on the parse above. */
export function clampCueVolume(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_CUE_PREFS.volume;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

/**
 * Coerce anything into a usable `CuePrefs`.
 *
 * Applied on the way **in and out**: the slider cannot produce an out-of-range
 * volume today, but the dispatcher reads this value through a ref on a hot path
 * and a future caller getting it wrong should be clamped rather than silently
 * muting an agent's console.
 */
export function normalizeCuePrefs(value: unknown): CuePrefs {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_CUE_PREFS };
  const record = value as Record<string, unknown>;
  const flash = record['connectFlash'];
  return {
    volume: clampCueVolume(record['volume']),
    connectFlash: FLASH_SETTINGS.includes(flash as ConnectFlashSetting)
      ? (flash as ConnectFlashSetting)
      : DEFAULT_CUE_PREFS.connectFlash,
  };
}

/**
 * Read the stored preferences, falling back to the defaults on anything at all.
 *
 * Never throws: `localStorage` itself throws on access in a browser with site
 * data blocked, and a console that will not open because a display preference
 * could not be read is a worse outcome than a console with default cues.
 */
export function readCuePrefs(storage: Pick<Storage, 'getItem'> | undefined): CuePrefs {
  if (!storage) return { ...DEFAULT_CUE_PREFS };
  try {
    const raw = storage.getItem(CUE_PREFS_STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_CUE_PREFS };
    return normalizeCuePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CUE_PREFS };
  }
}

/** Persist, normalising first so a bad write cannot become a bad read. */
export function writeCuePrefs(
  storage: Pick<Storage, 'setItem'> | undefined,
  prefs: CuePrefs,
): void {
  if (!storage) return;
  try {
    storage.setItem(CUE_PREFS_STORAGE_KEY, JSON.stringify(normalizeCuePrefs(prefs)));
  } catch {
    // A full or blocked store means the preference lasts for this shift only,
    // which is a degradation the agent can live with and cannot be told about
    // usefully — the control they just moved did work.
  }
}
