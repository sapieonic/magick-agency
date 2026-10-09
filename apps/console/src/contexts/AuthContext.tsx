import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import { FIREBASE_CONFIG } from '../config';
import { createSession, getMe } from '../api/auth';
import { claimInvite as claimInviteRequest } from '../api/invites';
import { resetAnalytics } from '../analytics/posthog';
import { markSessionStart, clearSessionStart, isSessionExpired, SESSION_EXPIRED_MESSAGE } from '../utils/session';
import { isLoginPath, sessionExpiredLoginUrl } from '../utils/returnPath';
import { clearAllLiveSessions } from '../utils/agencyLiveSession';
import {
  markJoinInProgress,
  isJoinInProgress,
  isThisTabsJoin,
  clearJoinInProgress,
} from '../utils/inviteJoin';
import type { User, Tenant, Membership, SessionResponse, SessionRefusalCode } from '../types/auth';
import { sessionRefusalCode } from '../utils/sessionRefusal';
import type { AgencyAccountSettingsMap } from '@magick-agency/contracts/api/platform/settings';

/**
 * Notes on this provider's state:
 *
 *  1. `settings`. The session payload carries the per-account settings map
 *     (`SessionResponse.settings`, keyed by account id);
 *     `GovernanceContext` derives its capability map from it.
 *  2. There is no `defaultAccount`, `isNew` or `needsPhone` state, nor
 *     `signUpEmail`, `updatePhone` or a `magick-pending-phone` stash. Those
 *     belong to session path 4 — a brand-new user provisioned a tenant, a pooled
 *     number and signup credits — and agency REFUSES path 4 with 403
 *     `no_membership`. There is no self-serve sign-up.
 *  3. `sessionRefusal`: When `POST /auth/session` answers 403 with a
 *     {@link SessionRefusalCode}, the code is kept on the state, so the sign-in
 *     door can show "we don't recognise that account" — including after a reload,
 *     when the refusal came from the listener rather than a button press — and
 *     never a sign-up. See `utils/sessionRefusal.ts`.
 *  4. Sign-out clears no concurrency-limits cache: there is no AI broadcast
 *     composer "Simultaneous calls" field to feed.
 */


/**
 * Firebase is initialized LAZILY, not at module load.
 *
 * `getAuth()` throws `auth/invalid-api-key` when the VITE_FIREBASE_* vars are
 * absent — which is the case in CI, where no `.env` exists. Because this module
 * ran its initialization as a side effect of being imported, any test that
 * merely pulled in a component transitively reaching AuthContext died at import
 * time, before a single assertion ran. Tests "protected" themselves by mocking
 * whichever context happened to sit on that path, so adding an unrelated import
 * to a page could break test files that never referenced auth at all.
 *
 * Deferring to first use keeps the failure where it belongs: a component that
 * actually needs auth. Vite statically replaces import.meta.env at build time,
 * so real builds are unaffected.
 */
let cachedAuth: ReturnType<typeof getAuth> | null = null;
let cachedGoogleProvider: GoogleAuthProvider | null = null;

function getFirebaseAuth(): ReturnType<typeof getAuth> {
  if (!cachedAuth) cachedAuth = getAuth(initializeApp(FIREBASE_CONFIG));
  return cachedAuth;
}

function getGoogleProvider(): GoogleAuthProvider {
  if (!cachedGoogleProvider) cachedGoogleProvider = new GoogleAuthProvider();
  return cachedGoogleProvider;
}

interface AuthState {
  firebaseUser: FirebaseUser | null;
  user: User | null;
  tenants: Tenant[];
  memberships: Membership[];
  loading: boolean;
  error: string | null;
  /** True when a Firebase email/password user has not yet verified their email */
  pendingEmailVerification: boolean;
  /** Per-account settings for every account the memberships reach, keyed by account id. */
  settings: AgencyAccountSettingsMap;
  /** Why the last `POST /auth/session` was refused (403), or `null`. */
  sessionRefusal: SessionRefusalCode | null;
}

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

interface AuthContextValue extends AuthState {
  signInEmail: (email: string, password: string) => Promise<SessionResponse | null>;
  signInGoogle: (phoneNumber?: string) => Promise<SessionResponse>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  /** Call after the user verifies their email to sync session with backend */
  completeEmailVerification: () => Promise<SessionResponse>;
  /**
   * Produce a Firebase credential for an invited agent WITHOUT creating a
   * platform session from it. The invite claim is what creates the session.
   */
  establishInviteCredential: (request: InviteCredentialRequest) => Promise<InviteCredential>;
  /**
   * Exchange a single-use invite token for a session. The Firebase id token is
   * minted inside, at claim time — see the implementation for why it is not a
   * parameter.
   */
  claimInvite: (token: string) => Promise<SessionResponse>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * The state of nobody being signed in: settled, with nothing to report.
 *
 * One value rather than the five identical literals it replaces. They were
 * identical by intention rather than by construction, which is how a field added
 * to {@link AuthState} gets into four of the five resets and leaves the fifth
 * holding a stale value from the session that just ended.
 *
 * Never mutated — every `setState` here replaces the state object rather than
 * editing it, and the updater form always builds a new one.
 */
const SIGNED_OUT: AuthState = {
  firebaseUser: null,
  user: null,
  tenants: [],
  memberships: [],
  loading: false,
  error: null,
  pendingEmailVerification: false,
  settings: {},
  sessionRefusal: null,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ ...SIGNED_OUT, loading: true });

  // Flag to prevent onAuthStateChanged from racing with manual signUp/signIn calls
  const manualAuthInProgress = useRef(false);

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

  /**
   * Take a session answer and BECOME signed in on it: stamp the clock, replace
   * the whole auth state.
   *
   * Extracted out of `syncSession` when `claimInvite` arrived, rather than
   * copied into it. Both produce the identical `SessionResponse` — the server answers
   * `POST /invites/:token/claim` with `POST /auth/session`'s body, byte for byte,
   * which is its contract and not a coincidence — and the thing that must not
   * diverge is what "signed in" MEANS here. There is exactly one other copy of
   * this block, in `completeEmailVerification`, and it is already the reason the
   * governance map and the session clock have to be re-checked in three places
   * whenever the session shape moves; a third copy for the invite path would have
   * made every such change a four-file change with one of them easy to miss.
   *
   * PostHog identification is deliberately NOT done here and is not missing:
   * `usePostHogIdentify` derives it from this state inside whichever shell mounts,
   * so adopting the state identically is the whole of what this owes analytics.
   */
  const adoptSession = useCallback((fbUser: FirebaseUser, session: SessionResponse): void => {
    /*
      A real session exists, so no join is in progress — whichever path got here.
      Ended BEFORE the state update, so no ordering of that update and a listener
      call can observe a signed-in session with the invite suppression still
      standing. Placed here rather than only in `claimInvite` because the marker
      must not outlive its cause on ANY path: a visitor whose invite attempt
      failed and who then signed in the ordinary way in the same tab would
      otherwise be signed out again by their next reload, for a reason they could
      not see. See `utils/inviteJoin.ts`.
    */
    endJoin();
    // Stamp the session start (idempotent — reloads keep the original clock).
    markSessionStart();
    setState({
      firebaseUser: fbUser,
      user: session.user,
      tenants: session.tenants,
      memberships: session.memberships,
      loading: false,
      error: null,
      pendingEmailVerification: false,
      settings: session.settings ?? {},
      sessionRefusal: null,
    });
  }, [endJoin]);

  const syncSession = useCallback(async (fbUser: FirebaseUser, phoneNumber?: string): Promise<SessionResponse> => {
    const idToken = await fbUser.getIdToken();
    const session = await createSession(idToken, phoneNumber);
    adoptSession(fbUser, session);
    return session;
  }, [adoptSession]);

  // Force a re-login by clearing the session and signing out of Firebase.
  // Surfaces a friendly "session expired" message on the login screen.
  const expireSession = useCallback(async () => {
    clearSessionStart();
    await signOut(getFirebaseAuth());
    /*
      Whatever else this is, it is not a join in progress any more — but only once
      the credential is actually gone. `signOut` rejects on a network blip and
      `browserLocalPersistence` keeps the user, so a marker cleared before it
      would leave a live credential with nothing in front of it. See
      `clearJoinInProgress`'s ordering note.
    */
    endJoin();
    resetAnalytics();
    clearAllLiveSessions();
    setState({ ...SIGNED_OUT, error: SESSION_EXPIRED_MESSAGE });
    // Redirect to login so the expiry message renders deterministically via the
    // URL. The in-context `error` above is unreliable on this path: signOut()
    // triggers onAuthStateChanged(null), whose handler resets `error` to null
    // and can race ahead of this setState. Guard against loops on EITHER sign-in
    // page — `isLoginPath` rather than `startsWith('/login')`, since the agency
    // door does not share that prefix. See `utils/returnPath`.
    if (typeof window !== 'undefined' && !isLoginPath(window.location.pathname)) {
      // Carries where they were — see `sessionExpiredLoginUrl`.
      window.location.href = sessionExpiredLoginUrl();
    }
  }, [endJoin]);

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
    setState(SIGNED_OUT);
  }, [endJoin]);

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
    setState(SIGNED_OUT);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), async (fbUser) => {
      if (fbUser) {
        // Skip if a manual auth operation (signUp/signIn) is handling the session sync.
        if (manualAuthInProgress.current) return;

        /*
          An invite credential this page life established, and is still going to
          claim with. `manualAuthInProgress` covers only the credential CALL, and
          Firebase notifies more than once around it — the persistence write, the
          id-token confirmation, a StrictMode or HMR re-subscribe — so by the
          second notification that flag is back to `false` while the page is still
          sitting on its mismatch confirmation waiting for a human.

          The answer here is `return` and nothing else. Not a sync, which is the
          stray tenant; and not a sign-out, which destroys the credential the page
          is about to claim with and answers the visitor with "No authenticated
          user" on a path where nothing had gone wrong. Consuming the credential
          belongs to a page life that is OVER — the branch below.
        */
        if (holdsInviteCredential.current) return;

        /*
          The half of the suppression a ref cannot provide: a PAGE LOAD, or
          another tab. Firebase persists the credential in `localStorage` and
          shares it across the origin, so a reload on the invite page's mismatch
          confirmation — and equally any other tab the visitor has open — reached
          the sync below with the ref born `false`, and provisioned the stray
          tenant this whole flow removes, permanently binding the visitor's Google
          uid to it.

          Which of the two it is decides what may be done about it. The tab that
          started the join has lost the page that would have claimed, so the
          credential is orphaned and is dropped. Any other tab may only suppress:
          the join may still be live on screen somewhere, and signing out from
          here would kill it. See `utils/inviteJoin.ts`.

          Checked BEFORE the session-cap branch because it is the more specific
          fact and its answer is not "your session expired": there is no session,
          and `expireSession` would navigate away from the token URL.
        */
        if (isJoinInProgress()) {
          if (isThisTabsJoin()) await discardInviteCredential();
          else suppressForeignJoin();
          return;
        }

        // Enforce the 6-hour absolute session cap: if a persisted session has
        // aged out, sign out instead of silently re-syncing on reload.
        if (isSessionExpired()) {
          await expireSession();
          return;
        }

        // Email/password users must verify their email before accessing the app.
        // Google users are always verified.
        const isEmailProvider = fbUser.providerData.some(p => p.providerId === 'password');
        if (isEmailProvider && !fbUser.emailVerified) {
          setState(prev => ({
            ...prev,
            firebaseUser: fbUser,
            pendingEmailVerification: true,
            loading: false,
            error: null,
          }));
          return;
        }

        try {
          await syncSession(fbUser);
        } catch (err) {
          setState(prev => ({
            ...prev,
            firebaseUser: fbUser,
            loading: false,
            error: err instanceof Error ? err.message : 'Session sync failed',
            sessionRefusal: sessionRefusalCode(err),
          }));
        }
      } else {
        clearAllLiveSessions();
        setState(SIGNED_OUT);
      }
    });
    return unsubscribe;
  }, [syncSession, expireSession, discardInviteCredential, suppressForeignJoin]);

  // Watchdog: while signed in, periodically check the 6-hour cap (and on tab
  // focus) so an idle open tab is logged out promptly once the session ages out.
  useEffect(() => {
    if (!state.firebaseUser) return;
    const check = () => { if (isSessionExpired()) void expireSession(); };
    check();
    const intervalId = window.setInterval(check, 60_000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [state.firebaseUser, expireSession]);

  const signInEmail = useCallback(async (email: string, password: string) => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    manualAuthInProgress.current = true;
    // Clear any prior session clock so this sign-in stamps a fresh 6h window
    // (guards against a user switch without an explicit logout in between).
    clearSessionStart();
    try {
      const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);

      // Block unverified email users
      if (!cred.user.emailVerified) {
        await sendEmailVerification(cred.user);
        setState(prev => ({
          ...prev,
          firebaseUser: cred.user,
          pendingEmailVerification: true,
          loading: false,
          error: null,
        }));
        return null;
      }

      return await syncSession(cred.user);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign in failed';
      setState(prev => ({ ...prev, loading: false, error: msg, sessionRefusal: sessionRefusalCode(err) }));
      throw err;
    } finally {
      manualAuthInProgress.current = false;
    }
  }, [syncSession]);

  const signInGoogle = useCallback(async (phoneNumber?: string) => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    manualAuthInProgress.current = true;
    clearSessionStart();
    try {
      const cred = await signInWithPopup(getFirebaseAuth(), getGoogleProvider());
      return await syncSession(cred.user, phoneNumber);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google sign in failed';
      setState(prev => ({ ...prev, loading: false, error: msg, sessionRefusal: sessionRefusalCode(err) }));
      throw err;
    } finally {
      manualAuthInProgress.current = false;
    }
  }, [syncSession]);

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
  }, [endJoin]);

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
  }, [adoptSession]);

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(getFirebaseAuth(), email);
  }, []);

  const completeEmailVerification = useCallback(async () => {
    const fbUser = getFirebaseAuth().currentUser;
    if (!fbUser) throw new Error('No authenticated user');
    await fbUser.reload();
    const refreshed = getAuth().currentUser;
    if (!refreshed?.emailVerified) throw new Error('Email not verified yet');
    // Force a fresh token so the backend sees emailVerified: true
    const idToken = await refreshed.getIdToken(true);
    const session = await createSession(idToken);
    // Fresh sign-in path: stamp a new 6h window from scratch.
    clearSessionStart();
    markSessionStart();
    // The one session-adoption block that does not go through `adoptSession`, so
    // it repeats its invariant: a real session means no join is in progress.
    endJoin();
    setState({
      firebaseUser: refreshed,
      user: session.user,
      tenants: session.tenants,
      memberships: session.memberships,
      loading: false,
      error: null,
      pendingEmailVerification: false,
      settings: session.settings ?? {},
      sessionRefusal: null,
    });
    return session;
  }, [endJoin]);

  const resendVerificationEmail = useCallback(async () => {
    const fbUser = getFirebaseAuth().currentUser;
    if (fbUser && !fbUser.emailVerified) {
      await sendEmailVerification(fbUser);
    }
  }, []);

  const logout = useCallback(async () => {
    clearSessionStart();
    await signOut(getFirebaseAuth());
    /*
      Also the invite page's escape hatches: declining the address mismatch and
      leaving the page mid-join both sign out through here, and each must leave
      the tab in a state where the NEXT page load is an ordinary one. A marker
      left behind would sign the visitor out once more, for no reason they could
      see.

      AFTER the sign-out, and not before it, which is the whole of the fix here.
      `signOut` rejects on `auth/network-request-failed` and
      `browserLocalPersistence` keeps the user, so clearing first left a live
      invite credential with nothing in front of it — and the next
      `onAuthStateChanged`, in this tab or another, synced it into the stray
      tenant. This ordering makes the failure safe instead: the marker stands, the
      rejection propagates to the caller, and the credential stays suppressed
      until something manages to drop it.
    */
    endJoin();
    resetAnalytics();
    clearAllLiveSessions();
    setState(SIGNED_OUT);
  }, [endJoin]);

  const refreshSession = useCallback(async () => {
    try {
      const me = await getMe();
      setState(prev => ({
        ...prev,
        user: me.user,
        tenants: me.tenants,
        memberships: me.memberships,
        settings: me.settings ?? {},
      }));
    } catch {
      // silently fail refresh
    }
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, signInEmail, signInGoogle, logout, refreshSession, resendVerificationEmail, resetPassword, completeEmailVerification, establishInviteCredential, claimInvite }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
