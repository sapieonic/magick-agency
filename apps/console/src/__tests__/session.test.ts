import { describe, it, expect, beforeEach } from 'vitest';
import {
  SESSION_MAX_AGE_MS,
  markSessionStart,
  clearSessionStart,
  getSessionStart,
  isSessionExpired,
} from '../utils/session';

describe('session lifetime', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('caps the session at 6 hours', () => {
    expect(SESSION_MAX_AGE_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('records the session start timestamp', () => {
    markSessionStart(1000);
    expect(getSessionStart()).toBe(1000);
  });

  it('is idempotent — re-marking does not reset the clock', () => {
    markSessionStart(1000);
    markSessionStart(9999); // e.g. a page-reload re-sync
    expect(getSessionStart()).toBe(1000);
  });

  it('clears the session start', () => {
    markSessionStart(1000);
    clearSessionStart();
    expect(getSessionStart()).toBeNull();
  });

  it('returns null when no session has been started', () => {
    expect(getSessionStart()).toBeNull();
  });

  it('is not expired before the 6-hour cap', () => {
    markSessionStart(1000);
    expect(isSessionExpired(1000)).toBe(false);
    expect(isSessionExpired(1000 + SESSION_MAX_AGE_MS - 1)).toBe(false);
  });

  it('is expired at and after the 6-hour cap', () => {
    markSessionStart(1000);
    expect(isSessionExpired(1000 + SESSION_MAX_AGE_MS)).toBe(true);
    expect(isSessionExpired(1000 + SESSION_MAX_AGE_MS + 60_000)).toBe(true);
  });

  it('treats an unknown session start as not expired', () => {
    expect(isSessionExpired(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('ignores a corrupt stored timestamp', () => {
    localStorage.setItem('magick-session-started-at', 'not-a-number');
    expect(getSessionStart()).toBeNull();
    expect(isSessionExpired()).toBe(false);
  });
});
