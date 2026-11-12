import { browserStorage } from './browserStorage';

/**
 * The Settings page this viewer opened last, so `/settings` (the sidebar's Settings) reopens it
 * (`settingsLandingPath` in `consoleNav.ts` decides whether they may still open it).
 *
 * Per person and per browser: keyed by the signed-in user's id, in `localStorage`. A
 * convenience only, so every read and write is wrapped: storage that throws (a private window,
 * blocked site data) or holds nothing is the same as never having visited.
 */
const KEY_PREFIX = 'magick.settings.last';

function storageKey(userId: string | null | undefined): string {
  return userId ? `${KEY_PREFIX}:${userId}` : KEY_PREFIX;
}

export function readLastSettingsEntry(userId: string | null | undefined, storage = browserStorage()): string | null {
  try {
    const value = storage?.getItem(storageKey(userId)) ?? null;
    return value && /^[a-z][a-z0-9-]*$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberSettingsEntry(userId: string | null | undefined, entryId: string, storage = browserStorage()): void {
  try {
    storage?.setItem(storageKey(userId), entryId);
  } catch {
    /* storage refused: the hub opens its default next time */
  }
}
