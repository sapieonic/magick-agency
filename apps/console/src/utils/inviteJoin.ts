/**
 * The record that somebody is part-way through claiming an emailed invitation,
 * kept where neither a PAGE LOAD nor ANOTHER TAB can lose it.
 *
 * ── The defect this closes, which is the one the join page exists for ──────
 * `AuthContext.establishInviteCredential` produces a Firebase credential without
 * creating a platform session, and suppresses the provider's own
 * `onAuthStateChanged` listener while it does so — because that listener runs
 * `syncSession` → `POST /auth/session` → master's path 4, which provisions a
 * BRAND-NEW TENANT for an address it does not recognise. That suppression is a
 * `useRef`, and a ref is correct for exactly as long as the page lives.
 *
 * Firebase's default persistence is `browserLocalPersistence`, so the credential
 * outlives the tab; the ref does not survive a single reload. The gap is not
 * theoretical, it is the middle of the flow: an agent presses Continue with
 * Google, the browser hands over a different address, the page shows the
 * mismatch confirmation — a screen that deliberately WAITS for a human — and they
 * reload, close and re-open the tab, or their phone restores it. `AuthProvider`
 * mounts, the ref is `false`, a Google user is always `emailVerified`, and the
 * listener silently provisions the stray tenant, the credits and the core API key
 * this whole page was built to prevent. Worse, it is not recoverable: their
 * Google uid is now bound to that new user row, so the real claim afterwards
 * fails with `identity_in_use` forever.
 *
 * ── Why `localStorage`, when this was `sessionStorage` ─────────────────────
 * Because the thing being guarded is `localStorage`-scoped. Nothing in `src/`
 * calls `setPersistence`, so Firebase keeps the credential in
 * `browserLocalPersistence` — `localStorage` plus the `storage` event, shared by
 * every tab on the origin. A per-tab marker therefore guards the credential in
 * exactly one of the tabs that can see it:
 *
 *   1. Tab A sits on `/agency/join/:token`; the Google popup completes, or the
 *      mismatch confirmation is on screen waiting for a human.
 *   2. Tab B already has the app open — a previous `/agency/login`, a supervisor
 *      checking the mailed link, an email client that opened the invite beside an
 *      existing session.
 *   3. Firebase replays the new credential into Tab B, whose marker was never
 *      written, so its listener syncs it: path 4, stray tenant, uid bound, and
 *      the real claim fails `identity_in_use` from then on.
 *
 * The reason this was `sessionStorage` — a marker must not follow somebody into a
 * new tab days later and suppress an ordinary sign-in — is real, and it is what
 * {@link JOIN_MAX_AGE_MS} is for. The timestamp needed for that was ALREADY being
 * written and simply never read; {@link isJoinInProgress} was existence-only. So
 * the fix is one storage change plus reading the value that was already there.
 *
 * ── Two facts, two scopes, and why that is not one flag ────────────────────
 * The marker answers "is a join outstanding on this origin?", and every tab must
 * answer it the same way, so it lives in `localStorage`. A SECOND, per-tab flag
 * answers "is this the tab that started it?", so it lives in `sessionStorage` —
 * where it survives a reload and dies with the tab, which is exactly the lifetime
 * of a page life's ownership of a credential.
 *
 * The two are needed because the right answer to an outstanding join differs
 * between them, and conflating them breaks one case or the other:
 *
 *  - **The tab that started it, on a fresh page load** ({@link isThisTabsJoin}):
 *    the page that would have claimed is gone, so the credential is orphaned and
 *    is DROPPED — signed out, not merely ignored, or the next thing to read the
 *    auth state provisions the tenant anyway.
 *  - **Any other tab**: the join may still be live in the tab that owns it, so
 *    that tab's credential must be left alone. Signing out from here would kill
 *    the very claim this module exists to protect, turning a working join into
 *    "No authenticated user". Suppression, and nothing else, is the answer.
 *
 * Every access is guarded. Web storage THROWS rather than returning null in some
 * privacy modes, and a storage failure must degrade to the old behaviour —
 * suppression that lasts one page life, through `AuthProvider`'s own ref — rather
 * than break the credential flow. That degradation is the honest floor: without
 * storage there is nowhere to write this down, and refusing to sign anybody in
 * would be a worse answer than the hazard.
 */
const JOIN_IN_PROGRESS_KEY = 'magick-agency-join-in-progress';

/**
 * The per-tab half: this tab is the one that established the credential.
 *
 * `sessionStorage`, for the same reasons `AgencyLoginPage`'s unrecognised-account
 * diagnosis is: it is a fact about ONE attempt in ONE tab, it must survive the
 * reload that loses component state, and it must not follow anybody into a new
 * tab. The super-admin tree already keeps its token here, so the mechanism is not
 * new to this app.
 */
const JOIN_TAB_KEY = 'magick-agency-join-tab';

/**
 * How long a join may plausibly still be outstanding.
 *
 * One hour, because that is the life of the Firebase id token the claim is made
 * with: past it, `claimInvite` would have to mint a fresh one anyway, and a
 * marker older than that is not describing a claim anybody is about to complete.
 *
 * A bound is what makes `localStorage` safe here. Without one, a marker written
 * by a join that was abandoned in a way no clear path caught — the tab crashed,
 * the browser was killed — would suppress the sign-in of somebody who came back
 * to this browser the next morning, and (worse) sign them out of the real session
 * they were establishing. The old `sessionStorage` scope bounded that by accident
 * of the tab closing; this bounds it on purpose, and the timestamp it reads is
 * the one that was already being written.
 */
export const JOIN_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Record that a credential is being established for an invite claim.
 *
 * Written BEFORE the Firebase call, not after it: the popup is itself a place a
 * page can be reloaded, and a marker written on the way back would miss exactly
 * the credential that already exists. `AuthContext` takes it back off again when
 * that call fails — nothing was established, so there is nothing to suppress.
 *
 * Both halves are written together and each is guarded on its own, so a browser
 * that allows one store and not the other still gets the half it can keep.
 */
export function markJoinInProgress(): void {
  try {
    localStorage.setItem(JOIN_IN_PROGRESS_KEY, String(Date.now()));
  } catch {
    /* Storage unavailable — the in-memory ref still covers this page's own life. */
  }
  try {
    sessionStorage.setItem(JOIN_TAB_KEY, '1');
  } catch {
    /* Without this half the join is suppressed everywhere and dropped nowhere,
       which is the safe direction: nothing syncs, and the marker expires. */
  }
}

/**
 * Whether a credential established for a claim may still be outstanding —
 * ANYWHERE on this origin, this tab included.
 *
 * The timestamp is read rather than merely tested for existence, which is the
 * whole of what makes an origin-wide marker safe; see {@link JOIN_MAX_AGE_MS}.
 * An expired or unreadable record is SWEPT rather than left to be re-examined on
 * every listener call: it can never become valid again, and clearing it here is
 * what stops a marker nobody can explain from lingering in a profile.
 *
 * A record from the future — a clock that moved backwards, or two machines
 * syncing storage — reads as live rather than as expired. That is the safe
 * direction: the cost of suppressing one sync too many is a signed-out page load,
 * and the cost of one too few is a stray tenant that cannot be undone.
 */
export function isJoinInProgress(): boolean {
  let raw: string | null;
  try {
    raw = localStorage.getItem(JOIN_IN_PROGRESS_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;

  const markedAt = Number(raw);
  if (Number.isFinite(markedAt) && Date.now() - markedAt < JOIN_MAX_AGE_MS) return true;

  clearJoinInProgress();
  return false;
}

/**
 * Whether the outstanding join is THIS tab's — i.e. whether a credential this tab
 * established is now sitting in a page life that has ended.
 *
 * Only the owning tab may drop the credential. Any other tab that finds a live
 * marker is looking at a join that may still be on screen somewhere, and signing
 * out from there would destroy it mid-claim.
 *
 * Requires the origin-wide half as well as the per-tab one: the tab flag alone
 * outlives the join it was written for (it is cleared on the same paths, but a
 * storage failure could leave it behind), and an expired marker means there is no
 * join left to own.
 */
export function isThisTabsJoin(): boolean {
  if (!isJoinInProgress()) return false;
  try {
    return sessionStorage.getItem(JOIN_TAB_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Forget it — on a successful claim, on a sign-out that actually succeeded, and
 * on the one path that acts on it.
 *
 * The listener CONSUMES the marker (drops the credential, then clears) rather
 * than merely reading it, which is what bounds this: a marker that somehow
 * outlived every other clear path costs one signed-out page load and then no
 * longer exists, instead of quietly signing somebody out of that tab forever.
 *
 * ── Ordering, at every call site: the sign-out FIRST ───────────────────────
 * This used to run before `signOut`, on the reasoning that "a credential we could
 * not drop is still one nothing will sync". That holds for one listener call and
 * no longer: `signOut` rejects on a network blip, `browserLocalPersistence` still
 * holds the user, and the NEXT `onAuthStateChanged` then sees a live credential
 * with no marker in front of it and syncs it — the stray tenant, arrived by the
 * failure path of the code that was removing it. So callers clear only once the
 * credential is really gone, and re-arm the marker when it is not.
 */
export function clearJoinInProgress(): void {
  try {
    localStorage.removeItem(JOIN_IN_PROGRESS_KEY);
  } catch {
    /* Nothing to clear if we could never write. */
  }
  try {
    sessionStorage.removeItem(JOIN_TAB_KEY);
  } catch {
    /* Ditto. */
  }
}
