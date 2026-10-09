import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { getAuth } from 'firebase/auth';
import { Headset, ClipboardList } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { sessionRefusalCode } from '../../utils/sessionRefusal';
import {
  trackAuthAttempted,
  trackAuthSucceeded,
  trackAuthFailed,
  trackEmailVerificationRequired,
} from '../../analytics/events';
import { SESSION_EXPIRED_MESSAGE } from '../../utils/session';
import { RETURN_PATH_PARAM, safeReturnPath } from '../../utils/returnPath';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { brand } from '../../brand';
import styles from './AgencyLoginPage.module.css';

/**
 * The Agency Dialer's own front door.
 *
 * ── Why the dialer gets a second sign-in page ──────────────────────────────
 * The same identity system, a different entrance. Agency staff are ordinary
 * users of the server — an `agent` or a supervisor is a membership row carrying an RBAC
 * role, and every agency route authorizes on that membership through the server's
 * `tenantContextMiddleware` — so this page calls exactly the same
 * `signInEmail`/`signInGoogle` as `/login` and produces exactly the same session.
 * It is NOT the parallel tree super-admin has (its own JWT in `sessionStorage`,
 * its own `saFetch`, its own middleware in the server); a second credential store
 * would have to duplicate the memberships and would break the inheritance that
 * lets a supervisor cover a shift on a station (see `utils/agencyPersona`).
 *
 * What it changes is the two things `/login` gets wrong for somebody whose whole
 * job is the dialer, and the first of them is a live defect rather than a matter
 * of tone. See {@link AGENCY_LOGIN_PATH} in `utils/returnPath` for both, and for
 * why the door is chosen from the DESTINATION rather than from a role.
 *
 * ── No Sign Up tab, and that is the point ──────────────────────────────────
 * `POST /auth/session` provisions a brand-new tenant for an address the server does
 * not recognise (the unknown-address path of the session route). An invited
 * agent's membership is activated by matching the address they sign in with
 * against the stub row `POST /users/invite` wrote for them — that IS the
 * activation mechanism, per the invite mailer. So on
 * this page a signup is never the thing the visitor wanted: it puts them in a
 * private empty tenant of their own while the membership their supervisor created
 * sits unclaimed, and nothing tells either of them. There is no signup here.
 *
 * The same hazard survives one way in — Google, with an address the server has never
 * seen — and {@link UnrecognisedAccount} below is what this page can do about it
 * without a change in the server. Read its docstring before deciding this page is
 * paranoid: it is the commonest way an agency onboarding goes wrong.
 *
 * ── It serves BOTH personas, and does not try to tell them apart ───────────
 * An agent and a supervisor sign in through the same form. Which of them somebody
 * is only becomes knowable after sign-in, from the RBAC role on their membership
 * — the persona is derived from permissions (`agencyPersona`), and there is no
 * membership to derive it from until the server answers. So this page asks nobody to
 * self-identify, and routes on the answer instead: the default destination is
 * `/agency`, which is `AgencyHomeRedirect`, which already sends a supervisor to
 * their campaign list and an agent to `/dialer`. Adding a role picker here would
 * be asking the visitor for something we are about to be told authoritatively.
 */

/** What the left panel promises, one row per persona. */
const PERSONAS = [
  {
    icon: Headset,
    title: 'Agents',
    desc: 'Sign in and go straight to your station — the campaigns you are staffed on and the calls waiting on them.',
  },
  {
    icon: ClipboardList,
    title: 'Supervisors',
    desc: 'Pick up where you left off: campaign health, the agent floor, and today’s attempts.',
  },
];

/**
 * Where the unrecognised-account diagnosis is remembered across a remount.
 *
 * ── Why it cannot live in component state alone ────────────────────────────
 * The diagnosis was `useState` only, and the signed-in branch below forwards
 * whenever `user` is set and that state is null — which is exactly what a reload
 * produces. So a refresh, a back-navigation, or simply re-opening the bookmarked
 * `/agency/login` skipped the explanation entirely and forwarded the visitor into
 * `/agency` as the owner of the stray tenant, where the capability gate meets them
 * with a bare "not part of your plan" and no hint that the real problem is the
 * address they signed in with.
 *
 * Nothing in the session can recover it, which is the crux: the server answers the
 * SECOND `POST /auth/session` from path 1 (found by `firebase_uid`) with
 * `is_new: false`, because by then the tenant it provisioned genuinely exists.
 * `is_new` is true exactly once, on the response that created it, so if this page
 * does not write that fact down it is gone.
 *
 * ── `sessionStorage`, and the scope that choice buys ──────────────────────
 * Per tab and cleared when the tab closes, which is the right lifetime: this is a
 * fact about ONE sign-in attempt, not about the person or the device. It survives
 * the reload that loses component state and does not follow them into a new tab
 * days later, where a stale diagnosis would be its own confusion. The super-admin
 * tree already keeps its token here, so the mechanism is not new to this app.
 *
 * Reads and writes are guarded: `sessionStorage` throws rather than returning null
 * in some privacy modes, and a storage failure must degrade to today's behaviour
 * (diagnosis shown once, lost on reload) rather than break sign-in.
 */
const UNRECOGNISED_KEY = 'magick-agency-unrecognised';

/** The remembered address, or `null`. An empty string means "seen, but no address". */
function readUnrecognised(): { email: string | null } | null {
  try {
    const raw = sessionStorage.getItem(UNRECOGNISED_KEY);
    return raw === null ? null : { email: raw === '' ? null : raw };
  } catch {
    return null;
  }
}

function writeUnrecognised(email: string | null): void {
  try {
    sessionStorage.setItem(UNRECOGNISED_KEY, email ?? '');
  } catch {
    /* Storage unavailable — the in-memory state below still renders it once. */
  }
}

function clearUnrecognised(): void {
  try {
    sessionStorage.removeItem(UNRECOGNISED_KEY);
  } catch {
    /* Nothing to clear if we could never write. */
  }
}

/**
 * The address of the credential a refused Google sign-in left behind. A refused
 * sign-in has no session, so it is read where `api/client.ts` reads the token — Firebase's current user.
 */
function firebaseUserEmail(): string | null {
  try {
    return getAuth().currentUser?.email ?? null;
  } catch {
    return null;
  }
}

function getAuthFailureReason(error: unknown): 'auth_error' | 'session_error' | 'unknown_error' {
  if (!(error instanceof Error)) return 'unknown_error';
  return error.message.toLowerCase().includes('session') ? 'session_error' : 'auth_error';
}

/**
 * Shown when a sign-in on THIS door was refused because the server does not
 * recognise the address.
 *
 * This screen answers a REFUSAL, not a provisioning. `POST /auth/session` answers
 * 403 `no_membership` for a verified identity it has no user, stub or invite for,
 * so nothing is created. The page renders it on the 403's code
 * (`sessionRefusalCode`), from the button press and from
 * `useAuth().sessionRefusal` after a reload (the listener's refusal). The copy is
 * about the address, which is the cause. There is no escape link to a second
 * sign-in page: `/login` IS this page in the console, so it would lead back here.
 *
 * ── What the refusal means here ─────────────────────────────────────────────
 * For a person who came to the agency door it means the invite was sent to a
 * different address, or they picked the wrong Google account, or the supervisor
 * typo'd it. The membership they are looking for still exists on the stub row,
 * unclaimed, and nothing has been created for them under the address they used.
 *
 * ── Why this is a screen rather than a redirect to onboarding ──────────────
 * Walking somebody through setting up a workspace is the exact wrong
 * instruction: the workspace they want already exists and they are one
 * corrected address away from it. This screen names the problem and offers the
 * way out (sign out, try the right address).
 */
function UnrecognisedAccount({
  email,
  onSignOut,
  signingOut,
  signOutError,
}: {
  email: string | null;
  onSignOut: () => void;
  signingOut: boolean;
  signOutError: string | null;
}) {
  return (
    <div className={styles.card}>
      <div className={styles.logo}>{brand.name}</div>
      <p className={styles.tagline}>Agency Dialer</p>
      <h1 className={styles.noticeTitle}>We don’t recognise that account</h1>
      <p className={styles.noticeBody}>
        {email ? <><strong>{email}</strong> isn’t</> : 'That address isn’t'} on an agency
        workspace yet. Sign-in is matched on the exact address your supervisor invited,
        so this usually means the invite went somewhere else — a work address rather
        than a personal one, or the other way round.
      </p>
      <p className={styles.noticeBody}>
        Check the invite you were sent and try that address. If you can’t find it, ask
        your supervisor to re-send it and to confirm which address they used.
      </p>
      {signOutError && <div className={styles.error} role="alert">{signOutError}</div>}
      <button
        type="button"
        className="btn-primary"
        onClick={onSignOut}
        disabled={signingOut}
        style={{ width: '100%' }}
      >
        {signingOut ? 'Signing out…' : 'Try a different account'}
      </button>
    </div>
  );
}

export default function AgencyLoginPage() {
  const { signInEmail, signInGoogle, resetPassword, logout, loading, error, user, pendingEmailVerification, sessionRefusal, firebaseUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionExpired = searchParams.get('session') === 'expired';

  /**
   * Where to go once signed in: the URL they originally asked for, or `/agency`.
   *
   * `RequireAuth` puts the `next` here when it turns an unauthenticated agency deep
   * link away, so a bookmarked `/station?campaign=…` survives the sign-in it
   * triggers — the case `utils/returnPath` exists for, reached through the door
   * that suits it.
   *
   * ── The fallback is `/agency`, not `/dialer` and not `/` ───────────────────
   * `/agency` is `AgencyHomeRedirect`, which resolves the persona from the RBAC
   * role and sends a supervisor to `/agency/campaigns` and an agent to `/dialer`.
   * So the landing path lives in ONE place for every entrance into the product,
   * and this page does not become a second copy of a rule that has already moved
   * once.
   *
   * `/dialer` would be wrong for a supervisor, who would arrive at their own
   * (usually empty) staffing list — `AgencyHomeRedirect`'s docstring names that as
   * the reason it branches at all. `/` would be wrong for both: `HomeRedirect`
   * decides between the two SHELLS on the tenant's entitlement, and its own
   * docstring is explicit that the predicate is strict and "fires rarely", so a
   * supervisor at an ordinary both-products tenant would be sent to `/app` after
   * asking, by their choice of door, for the dialer.
   *
   * Validated rather than trusted: the value is in the URL, so anyone can put
   * anything in it. `safeReturnPath` rejects off-site targets and refuses both
   * login paths, so it cannot loop back here either.
   */
  const returnTo = safeReturnPath(searchParams.get(RETURN_PATH_PARAM)) ?? '/agency';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  /*
    Seeded from storage rather than starting null, so the diagnosis survives the
    reload that would otherwise forward this visitor into the stray tenant. Lazy
    initialiser: `sessionStorage` is read once on mount, not on every render.
  */
  const [unrecognised, setUnrecognised] = useState<{ email: string | null } | null>(readUnrecognised);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  /**
   * The one place this page decides what a successful session means.
   *
   * The unrecognised-account diagnosis comes from the 403 `no_membership`
   * refusal, in {@link showUnrecognised}. An unverified address has a step to
   * finish first, and honouring a deep link past it would drop somebody into a
   * station mid-setup.
   */
  const landAfterSignIn = () => {
    /*
      Cleared on the way through, not only on sign-out: an agent who is handed the
      right address and signs in with it in the same tab must not carry the old
      diagnosis into their next reload.
    */
    clearUnrecognised();
    navigate(returnTo);
  };

  /**
   * Handles the refusal: reported
   * as a FAILURE (`unrecognised_account`), remembered for a reload, and rendered.
   * Returns whether `err` was that refusal.
   */
  const showUnrecognised = (
    err: unknown,
    signedInAs: string | null,
    provider: 'email' | 'google',
  ): boolean => {
    if (sessionRefusalCode(err) !== 'no_membership') return false;
    trackAuthFailed({ action: 'login', provider, reason: 'unrecognised_account', door: 'agency' });
    writeUnrecognised(signedInAs);
    setUnrecognised({ email: signedInAs });
    return true;
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotError(null);
    trackAuthAttempted({ action: 'password_reset', provider: 'email', door: 'agency' });
    if (!forgotEmail) {
      trackAuthFailed({ action: 'password_reset', provider: 'email', reason: 'validation_error', door: 'agency' });
      setForgotError('Please enter your email address');
      return;
    }
    setForgotLoading(true);
    try {
      await resetPassword(forgotEmail);
      trackAuthSucceeded({ action: 'password_reset', provider: 'email', is_new: false, needs_phone: false, door: 'agency' });
      setForgotSent(true);
    } catch (err) {
      trackAuthFailed({ action: 'password_reset', provider: 'email', reason: getAuthFailureReason(err), door: 'agency' });
      const msg = err instanceof Error ? err.message : 'Failed to send reset email';
      if (msg.includes('user-not-found') || msg.includes('invalid-email')) {
        setForgotError('No account found with this email address');
      } else {
        setForgotError(msg);
      }
    } finally {
      setForgotLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    try {
      trackAuthAttempted({ action: 'login', provider: 'email', door: 'agency' });
      const session = await signInEmail(email, password);
      if (!session) {
        /*
          Unverified email — `signInEmail` sends verification and sets the state.

          `returnTo` is carried through as `?next=`, which the primary door does not
          do and which this door has to. `/verify-email` used to end at `/` for
          everybody: after verifying that is `HomeRedirect`, which sends a
          SUPERVISOR to `/app` (its predicate for agency-only tenants "fires
          rarely", by its own docstring), and after signing out from that page it
          is `/login` — the marketing page this door exists to keep agency staff
          off. Carrying the destination fixes both, because the door is chosen from
          it. See `VerifyEmailPage`.
        */
        trackEmailVerificationRequired({ source: 'login', door: 'agency' });
        navigate(`/verify-email?${RETURN_PATH_PARAM}=${encodeURIComponent(returnTo)}`);
        return;
      }
      trackAuthSucceeded({
        action: 'login',
        provider: 'email',
        is_new: session.is_new,
        needs_phone: false,
        door: 'agency',
      });
      landAfterSignIn();
    } catch (err) {
      if (showUnrecognised(err, email, 'email')) return;
      trackAuthFailed({ action: 'login', provider: 'email', reason: getAuthFailureReason(err), door: 'agency' });
      // `error` is set in AuthContext.
    }
  };

  const handleGoogle = async () => {
    try {
      trackAuthAttempted({ action: 'login', provider: 'google', door: 'agency' });
      const session = await signInGoogle();
      trackAuthSucceeded({
        action: 'login',
        provider: 'google',
        is_new: session.is_new,
        needs_phone: false,
        door: 'agency',
      });
      landAfterSignIn();
    } catch (err) {
      if (showUnrecognised(err, firebaseUserEmail(), 'google')) return;
      trackAuthFailed({ action: 'login', provider: 'google', reason: getAuthFailureReason(err), door: 'agency' });
      // `error` is set in AuthContext.
    }
  };

  const handleSignOut = async () => {
    setSignOutError(null);
    setSigningOut(true);
    try {
      await logout();
      clearUnrecognised();
      setUnrecognised(null);
      setEmail('');
      setPassword('');
    } catch (err) {
      /*
        Guarded, unlike the first version of this handler. `logout()` calls
        Firebase `signOut()`, which rejects on a network blip — and with the
        `await` unguarded the state reset never ran, so the screen's only control
        silently did nothing and nothing said why. The message plus the escape link
        in `UnrecognisedAccount` are the two things that keep this from being a
        dead end.
      */
      setSignOutError(
        err instanceof Error ? err.message : 'Could not sign out. Check your connection and try again.',
      );
    } finally {
      setSigningOut(false);
    }
  };

  const displayError = localError || error || (sessionExpired ? SESSION_EXPIRED_MESSAGE : null);

  /**
   * The refusal can also arrive WITHOUT a button
   * press — a reload, or a Firebase credential restored on a cold open, is synced
   * by `AuthContext`'s listener, which records the 403's code as
   * `sessionRefusal`. That is the reload hole the
   * `sessionStorage` seed below closes, so it renders the same screen.
   */
  const refusedOnSync = unrecognised === null && sessionRefusal === 'no_membership' && !user;
  const shownUnrecognised = refusedOnSync ? { email: firebaseUser?.email ?? null } : unrecognised;

  /**
   * Somebody who is ALREADY signed in gets sent on rather than shown a form.
   *
   * ── Why a door has to do this ──────────────────────────────────────────────
   * The premise of this page is that an agency hands staff one URL to bookmark.
   * Without this branch that bookmark is worse than the old one: an agent who
   * opens it on their second morning is signed in already, and met by an empty
   * sign-in form asking for credentials the browser has no reason to think are
   * needed. `/login` has the same gap, but `/login` is not the address anybody is
   * told to bookmark.
   *
   * It is also what makes the claim in `TeamPage`'s invite docstring true —
   * "supervisors are first-class at the agency door, they can bookmark it and it
   * routes them to their campaigns". That was written before this branch existed
   * and was false without it.
   *
   * ── The three states this must NOT swallow ────────────────────────────────
   *  1. `loading` — `AuthContext` starts there while it resolves Firebase. Wait,
   *     or a cold open redirects on a `user` that is merely not-yet-known.
   *  2. `unrecognised` — that screen renders while SIGNED IN, to somebody in a
   *     stray tenant. Redirecting them into `/agency` would replace the diagnosis
   *     with a capability refusal and lose the only explanation they get. Tested
   *     above, so the ordering here is load-bearing — and the state is seeded from
   *     `sessionStorage`, so a RELOAD reaches this branch with the flag already
   *     set. Without that seed the reload was the hole: state resets to null,
   *     `user` is still set, and this branch forwarded the very person it is
   *     ordered to protect.
   *  3. `pendingEmailVerification` — `RequireAuth` bounces that to
   *     `/verify-email` anyway, so sending them into `returnTo` would just add a
   *     hop; the branch below hands them there directly, with the destination
   *     carried so the trip back lands at this door rather than `/login`.
   *
   * Deliberately NOT gated on the agency capability or the dialer flag. Those are
   * per-tenant reads that need a resolved account, and a plan-gate refusal is a
   * better answer than a sign-in form for somebody who is already authenticated —
   * it at least says what is wrong. `RequireCapability` on `/agency` is where that
   * is decided, and it is decided the same way whether they arrived here or typed
   * `/agency` directly.
   */
  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.bgGlow} />
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (user && shownUnrecognised === null) {
    return (
      <Navigate
        to={
          pendingEmailVerification
            ? `/verify-email?${RETURN_PATH_PARAM}=${encodeURIComponent(returnTo)}`
            : returnTo
        }
        replace
      />
    );
  }

  if (shownUnrecognised !== null) {
    return (
      <div className={styles.page}>
        <div className={styles.bgGlow} />
        <UnrecognisedAccount
          email={shownUnrecognised.email}
          onSignOut={handleSignOut}
          signingOut={signingOut}
          signOutError={signOutError}
        />
      </div>
    );
  }

  if (showForgotPassword) {
    return (
      <div className={styles.page}>
        <div className={styles.bgGlow} />
        <div className={styles.card}>
          <div className={styles.logo}>{brand.name}</div>
          <p className={styles.tagline}>Reset your password</p>
          {forgotSent ? (
            <div className={styles.noticeBlock}>
              <p className={styles.noticeBody}>
                We sent a password reset link to{' '}
                <strong className={styles.strong}>{forgotEmail}</strong>. Check your inbox
                and follow the link to reset it.
              </p>
              <button
                className="btn-primary"
                onClick={() => { setShowForgotPassword(false); setForgotSent(false); setForgotEmail(''); }}
                style={{ width: '100%' }}
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgotPassword} className={styles.form}>
              <p className={styles.formHint}>
                Enter the email address your supervisor invited and we’ll send you a link
                to reset your password.
              </p>
              <div className={styles.field}>
                <label htmlFor="agency-forgot-email">Email</label>
                <input
                  id="agency-forgot-email"
                  type="email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  placeholder="you@agency.com"
                  required
                  autoComplete="email"
                  autoFocus
                />
              </div>
              {forgotError && <div className={styles.error} role="alert">{forgotError}</div>}
              <button type="submit" className="btn-primary" disabled={forgotLoading} style={{ width: '100%' }}>
                {forgotLoading ? 'Sending…' : 'Send reset link'}
              </button>
              <button
                type="button"
                className={styles.forgotLink}
                onClick={() => { setShowForgotPassword(false); setForgotError(null); setForgotEmail(''); }}
              >
                Back to sign in
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.bgGlow} />

      <div className={styles.layout}>
        <div className={styles.leftPanel}>
          <div className={styles.brand}>
            <div className={styles.brandLogo}>{brand.name}</div>
            <p className={styles.brandProduct}>Agency Dialer</p>
            <p className={styles.brandTagline}>
              The workspace your calling floor runs on.
            </p>
          </div>

          <div className={styles.personas}>
            {PERSONAS.map(({ icon: Icon, title, desc }) => (
              <div key={title} className={styles.persona}>
                <div className={styles.personaIcon}>
                  <Icon size={18} />
                </div>
                <div>
                  <div className={styles.personaTitle}>{title}</div>
                  <div className={styles.personaDesc}>{desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div className={styles.leftFooter}>
            Signing in takes you to your own workspace — agents to their station,
            supervisors to their campaigns.
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.logo}>{brand.name}</div>
          <p className={styles.tagline}>Sign in to the Agency Dialer</p>

          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.field}>
              <label htmlFor="agency-email">Email</label>
              <input
                id="agency-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@agency.com"
                required
                autoComplete="email"
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="agency-password">Password</label>
              <input
                id="agency-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                className={styles.forgotLink}
                onClick={() => { setShowForgotPassword(true); setForgotEmail(email); }}
              >
                Forgot password?
              </button>
            </div>

            {displayError && <div className={styles.error} role="alert">{displayError}</div>}

            <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Please wait…' : 'Sign in'}
            </button>
          </form>

          <div className={styles.divider}><span>or</span></div>
          <button type="button" className={styles.googleBtn} onClick={handleGoogle} disabled={loading}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </button>

          {/*
            No cross-link to a second sign-in page: the console has one door,
            and `/login` is this page.
          */}
        </div>
      </div>
    </div>
  );
}
