import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import { FIREBASE_CONFIG } from '../config';
import { createSession, getMe } from '../api/auth';
import { resetAnalytics } from '../analytics/posthog';
import { markSessionStart, clearSessionStart, isSessionExpired, SESSION_EXPIRED_MESSAGE } from '../utils/session';
import { isLoginPath, sessionExpiredLoginUrl } from '../utils/returnPath';
import { clearAllLiveSessions } from '../utils/agencyLiveSession';
import { isJoinInProgress, isThisTabsJoin } from '../utils/inviteJoin';
import type { User, Tenant, Membership, SessionResponse, SessionRefusalCode } from '../types/auth';
import { sessionRefusalCode } from '../utils/sessionRefusal';
import type { AgencyAccountSettingsMap } from '@magick-agency/contracts/api/platform/settings';
import { useInviteJoin, useInviteCredentialFlow } from './authInvite';
import type { InviteCredentialRequest, InviteCredential } from './authInvite';
import { useSessionWatchdog } from './useSessionWatchdog';

// The invite types are part of this context's API; they live with the flow.
export type { InviteCredentialRequest, InviteCredential } from './authInvite';

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

  // The invite join's two halves of suppression and the one way to end it.
  // See `authInvite.ts`.
  const { holdsInviteCredential, endJoin } = useInviteJoin();

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

  const {
    discardInviteCredential,
    suppressForeignJoin,
    establishInviteCredential,
    claimInvite,
  } = useInviteCredentialFlow({
    getFirebaseAuth,
    getGoogleProvider,
    manualAuthInProgress,
    holdsInviteCredential,
    endJoin,
    adoptSession,
    setState,
    signedOut: SIGNED_OUT,
  });

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

  // Watchdog: while signed in, check the 6-hour cap periodically and on tab
  // focus, so an idle open tab is logged out promptly once the session ages out.
  useSessionWatchdog(state.firebaseUser, expireSession);

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

  // One value per state change, not per render: a re-render of whatever sits
  // above the provider must not re-render every `useAuth()` consumer.
  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signInEmail,
      signInGoogle,
      logout,
      refreshSession,
      resendVerificationEmail,
      resetPassword,
      completeEmailVerification,
      establishInviteCredential,
      claimInvite,
    }),
    [
      state,
      signInEmail,
      signInGoogle,
      logout,
      refreshSession,
      resendVerificationEmail,
      resetPassword,
      completeEmailVerification,
      establishInviteCredential,
      claimInvite,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
