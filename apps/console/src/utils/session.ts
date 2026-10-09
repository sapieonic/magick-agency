/**
 * Client-side session-lifetime enforcement.
 *
 * Firebase persists auth state in localStorage and silently refreshes ID
 * tokens indefinitely, so without an explicit cap a signed-in user stays
 * authenticated forever. We stamp the moment of authentication and force a
 * re-login once SESSION_MAX_AGE_MS elapses. This is an *absolute* lifetime
 * (measured from sign-in) — not an idle/inactivity timeout.
 *
 * NOTE: this layer lives in localStorage and is therefore tamper-able, so it
 * is UX / defence-in-depth only. Real enforcement must also reject stale
 * sessions server-side (the backend returns 401, handled in api/client.ts).
 */

/** Maximum session lifetime before a forced re-auth: 6 hours from sign-in. */
export const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const SESSION_STARTED_KEY = 'magick-session-started-at';

/** User-facing message shown on the login screen after a forced re-auth. */
export const SESSION_EXPIRED_MESSAGE =
  'Your session expired after 6 hours. Please sign in again.';

/**
 * Record the start of an authenticated session.
 *
 * Idempotent: only writes when no timestamp exists yet, so silent re-syncs
 * (page reload → onAuthStateChanged → syncSession) never reset the clock.
 * The timestamp is cleared on logout / expiry, so the next real sign-in
 * re-stamps a fresh start.
 */
export function markSessionStart(now: number = Date.now()): void {
  try {
    if (!localStorage.getItem(SESSION_STARTED_KEY)) {
      localStorage.setItem(SESSION_STARTED_KEY, String(now));
    }
  } catch {
    /* localStorage unavailable — fail open */
  }
}

/** Clear the recorded session start (on logout / forced expiry). */
export function clearSessionStart(): void {
  try {
    localStorage.removeItem(SESSION_STARTED_KEY);
  } catch {
    /* */
  }
}

/** Epoch-ms when the current session began, or null if unknown. */
export function getSessionStart(): number | null {
  try {
    const raw = localStorage.getItem(SESSION_STARTED_KEY);
    if (!raw) return null;
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/**
 * True when an authenticated session has exceeded its maximum lifetime.
 * Returns false when no session start is recorded (nothing to expire yet).
 */
export function isSessionExpired(now: number = Date.now()): boolean {
  const started = getSessionStart();
  if (started === null) return false;
  return now - started >= SESSION_MAX_AGE_MS;
}
