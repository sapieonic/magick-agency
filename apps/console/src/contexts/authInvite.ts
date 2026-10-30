import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type GoogleAuthProvider,
  type User as FirebaseUser,
} from 'firebase/auth';
import { claimInvite as claimInviteRequest } from '../api/invites';
import { clearSessionStart } from '../utils/session';
import { markJoinInProgress, clearJoinInProgress } from '../utils/inviteJoin';
import type { SessionResponse } from '../types/auth';

/*
 * The invite-credential flow of `AuthProvider`: how an invitee on either invite
 * page — `/agency/join/:token` for an agent, `/join/:token` for every other role,
 * both running `components/agency/join/useInviteClaim` — gets a Firebase
 * credential WITHOUT a platform session being created from it, and how the invite
 * claim then turns it into one.
 *
 * Two hooks rather than one because `AuthProvider` sits between them:
 * `useInviteJoin` owns the suppression state and `endJoin`, which the
 * provider's own `adoptSession` calls; `useInviteCredentialFlow` needs that
 * `adoptSession` back for the claim. The provider owns the auth state, the
 * `onAuthStateChanged` listener and `manualAuthInProgress`, and passes them in.
 */

/**
 * The three ways an invited agent produces a Firebase credential on
 * `/agency/join/:token`. See {@link AuthContextValue.establishInviteCredential}.
 */
export type InviteCredentialRequest =
  | { method: 'create'; email: string; password: string }
  | { method: 'sign_in'; email: string; password: string }
  | { method: 'google' };

/**
 * What the invite page needs back from a credential: the address it is actually
 * for.
 *
 * The address is returned rather than assumed because on the Google path it is
 * routinely NOT the invited one — the personal account the browser is already
 * signed into — and the whole of that path's value is that the page notices and
 * says so instead of proceeding.
 *
 * It deliberately does NOT carry an id token. It used to, and the page held that
 * captured value across the address-mismatch confirmation — a screen that waits
 * for a human, on a token that lasts an hour. {@link AuthContextValue.claimInvite}
 * mints a fresh one at claim time instead, so there is no stale credential for a
 * caller to hold in the first place. `null` where Firebase reports no address at
 * all, which the page renders as "that Google account" rather than as blank.
 */
export interface InviteCredential {
  email: string | null;
}

/**
 * The join's suppression state and the one way to end it.
 */
export function useInviteJoin() {
  /**
   * Whether THIS provider instance established an invite credential that no claim
   * has spent yet.
   *
   * ── The distinction the marker alone cannot make ──────────────────────────
   * The marker in `utils/inviteJoin.ts` says a join is outstanding. It does not
   * say whether the page that is going to claim with it is still on screen, and
   * the listener's answer has to differ:
   *
   *  - **Still on screen** (this ref): `return`. Skip the sync and leave the
   *    credential alone — the claim is what will spend it.
   *  - **Gone** (a new provider instance, so this ref is born `false`): the
   *    credential is orphaned, and it is dropped.
   *
   * Treating every listener call as the second case is what made the guard fire
   * on the page it was protecting. `onAuthStateChanged` is not called once:
   * Firebase notifies around the persistence write and again as the id token is
   * confirmed, and StrictMode and HMR re-subscribe a fresh listener to the same
   * provider. `manualAuthInProgress` is already back to `false` by then, so a
   * second notification signed the visitor out WHILE THEY WERE READING the
   * address-mismatch confirmation — or in the gap between the credential
   * resolving and `claimInvite`, where the claim then failed with "No
   * authenticated user" on the one path (a matching address) that had nothing
   * wrong with it at all.
   *
   * A ref rather than another storage key, so this half of the suppression holds
   * even where web storage throws.
   */
  const holdsInviteCredential = useRef(false);

  /**
   * The join is over: forget the marker and the credential this page was holding.
   *
   * One function because the two facts must never disagree. A cleared marker with
   * the ref still set suppresses every sync for the rest of this page life; a
   * live marker with the ref cleared signs the visitor out on their next load.
   * Called on every path that ends a join — a claim adopted, a sign-out that
   * actually succeeded, an expiry, and a credential call that failed before
   * producing anything.
   */
  const endJoin = useCallback(() => {
    holdsInviteCredential.current = false;
    clearJoinInProgress();
  }, []);

  return { holdsInviteCredential, endJoin };
}

/** The minimum of the provider's auth state this flow writes. */
interface AuthStateShape {
  loading: boolean;
  error: string | null;
}

/**
 * Dropping or suppressing an invite credential, establishing one, and claiming
 * an invite with it. Every callback is stable as long as the inputs are.
 */
export function useInviteCredentialFlow<S extends AuthStateShape>({
  getFirebaseAuth,
  getGoogleProvider,
  manualAuthInProgress,
  holdsInviteCredential,
  endJoin,
  adoptSession,
  setState,
  signedOut,
}: {
  getFirebaseAuth: () => Auth;
  getGoogleProvider: () => GoogleAuthProvider;
  /** The provider's listener suppression for a credential call in flight. */
  manualAuthInProgress: MutableRefObject<boolean>;
  holdsInviteCredential: MutableRefObject<boolean>;
  endJoin: () => void;
  /** Become signed in on a session answer (the provider's `adoptSession`). */
  adoptSession: (fbUser: FirebaseUser, session: SessionResponse) => void;
  setState: Dispatch<SetStateAction<S>>;
  /** The provider's signed-out state. */
  signedOut: S;
}) {
  /**
   * Drop a Firebase credential that was established for an invite claim and then
   * abandoned — a reload, a closed tab, a restored session.
   *
   * ── Why the credential goes rather than merely being ignored ───────────────
   * Ignoring it would leave a signed-in Firebase user behind a signed-out app,
   * which is the state that produced this defect in the first place: the next
   * thing to read the auth state provisions a tenant for it. Dropping it also
   * makes the next Google popup ASK again rather than silently re-selecting the
   * account that did not match — the same reasoning as the mismatch screen's
   * "Use a different account", which signs out for exactly that reason.
   *
   * Deliberately NOT {@link expireSession}: that one navigates to a sign-in page,
   * and the page this fires on is the invite landing page, whose URL carries the
   * single-use token. A redirect here would spend the one thing the visitor
   * cannot get back without asking their supervisor for another invitation.
   *
   * No error is published either. Nothing was lost from the visitor's point of
   * view — there was never a session — and a "your session expired" notice on a
   * page for somebody who has no account reads as a fault in the invitation.
   *
   * ── The marker outlives a sign-out that did not happen ─────────────────────
   * The clear used to come FIRST, and the comment defending it said "a credential
   * we could not drop is still one nothing will sync". That is true of this
   * listener call and of no other. `signOut` rejects on
   * `auth/network-request-failed`, `browserLocalPersistence` still holds the
   * user, and the next `onAuthStateChanged` — a reload, another tab, or simply
   * Firebase confirming the id token — then found a live credential with no
   * marker in front of it and synced it. The stray tenant, created by the failure
   * path of the code whose whole job is to prevent it. So the marker is cleared
   * only once the credential is really gone, and re-armed when it is not: the
   * suppression must outlive our attempt to drop it by as much as the credential
   * does.
   */
  const discardInviteCredential = useCallback(async () => {
    clearSessionStart();
    let dropped = true;
    try {
      await signOut(getFirebaseAuth());
    } catch {
      /* Best effort for the STATE below — the app reads it either way — but not
         for the marker, which is the only thing standing between the credential
         that survived this and `POST /auth/session`. */
      dropped = false;
    }
    if (dropped) endJoin();
    else markJoinInProgress();
    setState(signedOut);
  }, [endJoin, getFirebaseAuth, setState, signedOut]);

  /**
   * Another tab is mid-join: publish "signed out" WITHOUT touching the
   * credential.
   *
   * Firebase's persistence is shared across the origin, so a credential
   * established on `/agency/join/:token` in one tab is immediately the current
   * user in every other tab the visitor has open — a supervisor's session, an
   * email client's preview, a `/agency/login` from ten minutes ago. Those tabs
   * must not sync it (that is the stray tenant), and they equally must not sign
   * it out: doing so would destroy, from a tab nobody is looking at, the very
   * credential the join page is about to claim with, and the visitor would watch
   * their invitation fail with "No authenticated user".
   *
   * So this reports the only thing that is true here — this tab has no session —
   * and leaves the credential to the tab that owns it. `loading` must be released
   * as part of that: a bare `return` would leave a `RequireAuth` route spinning
   * forever instead of sending the visitor to a sign-in page.
   */
  const suppressForeignJoin = useCallback(() => {
    setState(signedOut);
  }, [setState, signedOut]);

  /**
   * Get a Firebase credential for an invited agent, WITHOUT provisioning a
   * platform session for it.
   *
   * ── Why this cannot be done from the page ──────────────────────────────────
   * `AgencyJoinPage` is the one place in the app that needs a Firebase credential
   * and must NOT have a session created from it — the invite claim is what
   * creates the session, using the token as the authority. Calling
   * `signInWithPopup` from the page instead reintroduces the exact defect the
   * invite flow exists to remove, and does it invisibly: the provider's own
   * `onAuthStateChanged` listener below fires on the credential, and for a Google
   * user (always `emailVerified`) it runs `syncSession` → `POST /auth/session` →
   * the server's path 4 → **a brand-new tenant provisioned for the address they just
   * signed in with**. The stray tenant would be created while the page was
   * sitting on its own address-mismatch confirmation, before the agent had
   * pressed anything.
   *
   * `manualAuthInProgress` is that listener's existing suppression, and it is a
   * ref inside this provider, so the only way to hold it across the credential
   * call is for the credential call to live in here. Released in a `finally`,
   * like every other method on this context — and it is deliberately NOT the
   * whole of the suppression, because the listener is invoked more than once:
   * Firebase notifies around the persistence write and again as the id token is
   * confirmed, and a StrictMode or HMR re-subscribe replays the current user into
   * a fresh listener. {@link holdsInviteCredential} is what covers the rest of
   * this page's life, and the marker what covers the loads after it.
   *
   * ── A credential call that FAILS leaves nothing behind ─────────────────────
   * The marker is written before the Firebase call, because the popup is a place
   * a page gets reloaded — but `signInWithPopup` routinely throws
   * (`auth/popup-closed-by-user`, `auth/popup-blocked`, a network failure) and
   * then no credential exists at all. Leaving the marker standing there was its
   * own defect, and a nastier one than the hole it was covering: a supervisor who
   * is ALREADY SIGNED IN opens the invite to check it, closes the Google window,
   * and goes back to the app — where the listener finds their real Firebase user
   * behind a marker for a credential that was never created, and signs them out
   * of a genuine session. So the marker is kept only when this call returns a
   * credential, and taken back when it does not — unless this page is already
   * holding an earlier one (a Google credential whose claim failed, followed by
   * an attempt at the password path), which is still real and still needs
   * suppressing.
   *
   * ── Three modes, one method ────────────────────────────────────────────────
   * A discriminated union rather than three exported methods, because they are
   * one concept — "produce a credential this page may claim with" — and three
   * entry points would be three places to forget the suppression above. The modes
   * are the three ways an invited agent actually arrives: no account yet
   * (`create`), an account from a previous invite to another tenant (`sign_in`,
   * which is where `auth/email-already-in-use` sends them), and Google.
   *
   * `emailVerified` is deliberately not checked on any of them — see
   * {@link claimInvite}.
   */
  const establishInviteCredential = useCallback(async (
    request: InviteCredentialRequest,
  ): Promise<InviteCredential> => {
    manualAuthInProgress.current = true;
    /*
      And the half of the suppression that survives a page load, and reaches the
      other tabs. The ref above dies with this page; Firebase's default
      `browserLocalPersistence` does neither, so a reload while the page waits on
      the address-mismatch confirmation — or simply a second tab with the app open
      — used to reach the listener with nothing in front of it and provision the
      stray tenant. Written BEFORE the Firebase call because the popup is itself a
      place somebody reloads. See `utils/inviteJoin.ts`.
    */
    markJoinInProgress();
    // A fresh sign-in, so any prior clock is void — the same first line
    // `signInEmail` and `signInGoogle` run, and for the same reason (a user
    // switch with no explicit logout in between).
    clearSessionStart();
    try {
      const cred =
        request.method === 'google'
          ? await signInWithPopup(getFirebaseAuth(), getGoogleProvider())
          : request.method === 'create'
            ? await createUserWithEmailAndPassword(getFirebaseAuth(), request.email, request.password)
            : await signInWithEmailAndPassword(getFirebaseAuth(), request.email, request.password);
      /*
        Only now does a credential exist for anything to suppress — and from here
        this page's own listener calls must skip the sync WITHOUT dropping it.
      */
      holdsInviteCredential.current = true;
      return { email: cred.user.email };
    } catch (err) {
      /*
        Nothing was established, so there is nothing to suppress — unless an
        EARLIER call on this page already produced a credential that is still
        live, in which case the marker is still describing something real and must
        stay. See the docstring above for the signed-in supervisor this protects.
      */
      if (!holdsInviteCredential.current) endJoin();
      throw err;
    } finally {
      manualAuthInProgress.current = false;
    }
  }, [endJoin, getFirebaseAuth, getGoogleProvider, holdsInviteCredential, manualAuthInProgress]);

  /**
   * Exchange an invite token plus a Firebase id token for a platform session.
   *
   * ── The one place `emailVerified` is not a gate, and why ───────────────────
   * `signInEmail` refuses an unverified address outright and sends a verification
   * mail; every other path into a session inherits that through
   * `onAuthStateChanged`. This path deliberately does not, and the divergence is
   * the server's, not this client's: possession of the emailed single-use token
   * ALREADY proves control of the inbox, which is the only thing verifying the
   * address would establish. Requiring it as well would mean an invited agent
   * receives two emails to open in order, and the second one is the step where
   * agency onboarding is already measured to stall — an agent told to check an
   * inbox often simply does not come back (`trackEmailVerificationRequired`'s
   * `door` dimension exists to watch exactly that drop-off).
   *
   * So do not "fix" this by adding a verification check. The claim is authorized
   * by the token; the address is corroboration the server no longer needs.
   *
   * Adopted through {@link adoptSession}, so a claimed invite and an ordinary
   * sign-in produce state that is identical field for field. The clock is cleared
   * first and re-stamped inside, which is `completeEmailVerification`'s ordering
   * rather than `syncSession`'s: this is the beginning of a session, not the
   * continuation of one, so it must not inherit a window some earlier tab opened.
   *
   * ── The id token is minted HERE, at claim time ─────────────────────────────
   * It used to be a parameter, captured once by `establishInviteCredential` and
   * handed back to the page. Firebase id tokens last an hour, and the page's most
   * important screen — the address-mismatch confirmation — is an explicit PAUSE
   * for a human to read two addresses and decide; a coffee, a phone call or a
   * "let me ask my supervisor" is enough for the captured token to be expired by
   * the time they press the button, and the server answers a stale one with a 401 the
   * visitor can do nothing about. `getIdToken()` returns the cached token and
   * refreshes it only when it is close to expiring, so this costs nothing in the
   * ordinary case. Taking it as a parameter at all was the hazard: every caller
   * would have had to remember the age of a value it did not create.
   */
  const claimInvite = useCallback(async (token: string): Promise<SessionResponse> => {
    const fbUser = getFirebaseAuth().currentUser;
    if (!fbUser) throw new Error('No authenticated user');
    setState(prev => ({ ...prev, loading: true, error: null }));
    manualAuthInProgress.current = true;
    try {
      const session = await claimInviteRequest(token, await fbUser.getIdToken());
      clearSessionStart();
      /*
        The claim is what ends the join: from here the credential is bound to a
        real membership and an ordinary reload must sync it like any other
        session. {@link adoptSession} drops the marker that suppresses that sync,
        along with everything else adopting a session means.
      */
      adoptSession(fbUser, session);
      return session;
    } catch (err) {
      /*
        `loading` is released and the message is published on the context, the
        same as every other failing method here — but the PAGE renders its own
        copy for the invite-specific failures it can name (expired, revoked,
        already claimed). Both exist because they answer different questions:
        this one unsticks the shared spinner, that one tells the agent what to do.
      */
      setState(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Could not accept that invitation',
      }));
      throw err;
    } finally {
      manualAuthInProgress.current = false;
    }
  }, [adoptSession, getFirebaseAuth, manualAuthInProgress, setState]);

  return { discardInviteCredential, suppressForeignJoin, establishInviteCredential, claimInvite };
}
