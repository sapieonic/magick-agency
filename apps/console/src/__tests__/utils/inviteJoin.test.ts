import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  markJoinInProgress,
  isJoinInProgress,
  isThisTabsJoin,
  clearJoinInProgress,
  JOIN_MAX_AGE_MS,
} from '../../utils/inviteJoin';

/**
 * Replace both web stores with ones that throw on every access, and hand back the
 * undo. What a privacy mode does, and the one condition this module has to
 * survive without throwing.
 */
function denyStorage(): () => void {
  const deny = () => { throw new Error('storage denied'); };
  const denied = { getItem: deny, setItem: deny, removeItem: deny, clear: deny, key: deny, length: 0 };
  const originals = (['localStorage', 'sessionStorage'] as const).map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(window, name),
  }));
  for (const { name } of originals) {
    Object.defineProperty(window, name, { value: denied, configurable: true, writable: true });
  }
  return () => {
    for (const { name, descriptor } of originals) {
      if (descriptor) Object.defineProperty(window, name, descriptor);
    }
  };
}

/**
 * The record that a join is outstanding, and the two scopes it is kept in.
 *
 * ── Why these properties and not the storage keys ─────────────────────────
 * The consequences live in `AuthContext` — that is where the marker decides
 * whether a Firebase credential is synced, ignored or dropped, and
 * `AuthContext.test.tsx` pins those outcomes end to end. What is worth pinning
 * HERE is the shape of the fact itself, because each property below is a
 * requirement pulling against another one and it is the balance that is easy to
 * break later:
 *
 *  1. **Origin-wide.** The credential it guards is `browserLocalPersistence` —
 *     `localStorage`, visible in every tab — so a per-tab record guarded it in one
 *     of the tabs that can see it. That was the defect.
 *  2. **Bounded.** Which is what a per-tab record was buying, and now has to be
 *     bought on purpose: a record nothing cleaned up must not suppress (or sign
 *     out of) a real session days later.
 *  3. **Owned by one tab.** Only the tab that started the join may drop the
 *     credential; any other may only decline to sync it. `signOut` is origin-wide,
 *     so a foreign tab acting on it would destroy a claim in progress.
 *  4. **Never throws.** Web storage throws rather than returning null in some
 *     privacy modes, and the floor has to be "no suppression", not "no sign-in".
 */
describe('the join record', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is visible to a tab that never wrote it', () => {
    // A second tab: the same `localStorage`, its own empty `sessionStorage`. The
    // credential is visible there, so the record has to be too.
    markJoinInProgress();
    sessionStorage.clear();

    expect(isJoinInProgress()).toBe(true);
  });

  it('is owned by the tab that wrote it, and by no other', () => {
    markJoinInProgress();
    expect(isThisTabsJoin()).toBe(true);

    sessionStorage.clear();
    expect(isThisTabsJoin()).toBe(false);
    // …while still suppressing there. The two answers are deliberately different:
    // the foreign tab must not sync it and must not drop it either.
    expect(isJoinInProgress()).toBe(true);
  });

  it('expires, and sweeps itself when it does', () => {
    markJoinInProgress();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + JOIN_MAX_AGE_MS + 1);

    expect(isJoinInProgress()).toBe(false);
    expect(isThisTabsJoin()).toBe(false);

    // Swept rather than merely disbelieved: an expired record can never become
    // valid again, and one nobody can explain must not linger in a profile.
    clock.mockRestore();
    expect(isJoinInProgress()).toBe(false);
  });

  it('is still live one millisecond before the bound', () => {
    /*
      The clock is pinned BEFORE the write, not after it.

      Reading the real `Date.now()` a second time to build the mock made this the
      one flaky test in the suite: the marker is stamped at T0, the mock is built
      from a T1 read a moment later, and the assertion `T1 + MAX - 1 - T0 < MAX`
      only holds while `T1 === T0`. It therefore passed exactly when the write and
      the mock fell inside the same millisecond and failed whenever they straddled
      a boundary — roughly one run in five, reported as a defect in the guard
      rather than in the test. A boundary case has to own both ends of the
      interval it is asserting about.
    */
    const base = 1_700_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    markJoinInProgress();

    clock.mockReturnValue(base + JOIN_MAX_AGE_MS - 1);
    expect(isJoinInProgress()).toBe(true);

    // And the far side of the same boundary, so the bound is pinned from both
    // directions rather than only from below.
    clock.mockReturnValue(base + JOIN_MAX_AGE_MS);
    expect(isJoinInProgress()).toBe(false);

    clock.mockRestore();
  });

  it('reads a record from the future as live, not as expired', () => {
    /*
      A clock that moved backwards, or two machines syncing storage. Suppressing
      one sync too many costs a signed-out page load; one too few costs a stray
      tenant that cannot be undone, so the ambiguous case resolves towards the
      recoverable failure.
    */
    markJoinInProgress();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - JOIN_MAX_AGE_MS);

    expect(isJoinInProgress()).toBe(true);
    clock.mockRestore();
  });

  it('treats an unreadable record as no record', () => {
    // Not a value this app writes — but a record it cannot reason about must not
    // be allowed to suppress sign-in forever.
    localStorage.setItem('magick-agency-join-in-progress', 'not-a-timestamp');

    expect(isJoinInProgress()).toBe(false);
  });

  it('is forgotten in both scopes at once', () => {
    markJoinInProgress();
    clearJoinInProgress();

    expect(isJoinInProgress()).toBe(false);
    expect(isThisTabsJoin()).toBe(false);
  });

  it('degrades to no suppression when storage throws', () => {
    /*
      Some privacy modes throw on every access. Without storage there is nowhere
      to write this down, so the honest floor is `AuthProvider`'s in-memory ref —
      suppression that lasts one page life. Refusing to sign anybody in would be a
      worse answer than the hazard, and throwing from here would do exactly that.

      Both stores are REPLACED rather than spied through `Storage.prototype`:
      whether a given store instance carries its own methods or inherits them is
      the test environment's business, and a spy that silently stops applying
      would leave this asserting nothing.
    */
    const restore = denyStorage();
    try {
      expect(() => markJoinInProgress()).not.toThrow();
      expect(isJoinInProgress()).toBe(false);
      expect(isThisTabsJoin()).toBe(false);
      expect(() => clearJoinInProgress()).not.toThrow();
    } finally {
      restore();
    }
  });
});
