/**
 * Per-user transcript display preference.
 *
 * A single localStorage key (not namespaced by tenant/account) so the choice
 * follows the user across every org context they switch into — the same scoping
 * ThemeContext uses. All reads are guarded so corrupt JSON or an unavailable
 * storage backend (SSR / private mode) never throws.
 *
 * NOTE: localStorage is per browser/device, so this preference does not sync
 * across a user's devices. Moving to cross-device would need a real
 * user-preferences store in the API.
 */

const STORAGE_KEY = 'magick-agency-transcript-visible';

/** Transcripts are shown by default — the toggle is opt-out. */
export const TRANSCRIPT_VISIBLE_DEFAULT = true;

export function loadTranscriptVisible(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return TRANSCRIPT_VISIBLE_DEFAULT;
  } catch {
    return TRANSCRIPT_VISIBLE_DEFAULT;
  }
}

export function saveTranscriptVisible(visible: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(visible));
  } catch {
    /* storage unavailable — preference is best-effort, never break the page */
  }
}
