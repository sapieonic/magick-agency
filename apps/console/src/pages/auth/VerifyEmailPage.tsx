import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, RefreshCw, LogOut } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { RETURN_PATH_PARAM, safeReturnPath } from '../../utils/returnPath';
import { brand } from '../../brand';
import styles from './LoginPage.module.css';

export default function VerifyEmailPage() {
  const { firebaseUser, pendingEmailVerification, resendVerificationEmail, completeEmailVerification, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  /**
   * Where to go when this step is done — the destination that was interrupted, or
   * `/` when nothing was carried.
   *
   * ── The hole this closes ────────────────────────────────────────────────────
   * This page used to navigate to `/` unconditionally, which was right while there
   * was one sign-in page and one shell. With the Agency Dialer's own door it
   * stranded the population that door exists to serve, twice over:
   *
   *  - **After verifying.** `/` is `HomeRedirect`, whose docstring says outright
   *    that its pure-agency predicate is strict and "fires rarely". So a
   *    SUPERVISOR who signed in at `/agency/login` and passed through here landed
   *    on `/app` — the shell they had just declined by choosing the agency door.
   *    (An agent was rescued by `AgentLanding`; a supervisor is not a dedicated
   *    agent and is not.)
   *  - **After signing out.** `logout()` clears `pendingEmailVerification`, which
   *    fires the guard below, which navigated to `/` — `RequireAuth` with no user,
   *    i.e. `/login?next=%2F`: the generic door, not the agency one, handed
   *    to exactly the person the agency door was built to keep off it.
   *
   * Both are fixed by the same value, because `loginPathReturningTo` picks the door
   * from the destination: with `next=/agency` in hand, the sign-out path resolves to
   * `/agency/login` and the verified path resolves to `AgencyHomeRedirect`.
   *
   * `/` remains the default, so nothing changes for the primary door, which passes
   * no `next` here. Validated rather than trusted — same open-redirect guard as
   * every other reader of this param.
   */
  const returnTo = safeReturnPath(searchParams.get(RETURN_PATH_PARAM)) ?? '/';
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    Not pending verification — send them on. This is also the SIGN-OUT path:
    `logout()` clears the flag, so the button below lands here rather than
    navigating itself. `returnTo` is what makes that exit land at the right door
    (see its docstring); with none it is `/`, which is `HomeRedirect` picking the
    shell the tenant is entitled to, because `/app` would strand an agency-only
    tenant on the AI dashboard.
  */
  if (!pendingEmailVerification || !firebaseUser) {
    navigate(returnTo, { replace: true });
    return null;
  }

  const handleResend = async () => {
    setResending(true);
    setError(null);
    try {
      await resendVerificationEmail();
      setResent(true);
      setTimeout(() => setResent(false), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend verification email');
    } finally {
      setResending(false);
    }
  };

  const handleCheckVerification = async () => {
    setChecking(true);
    setError(null);
    try {
      await completeEmailVerification();
      /*
        `returnTo` rather than `/app`: a returning user's shell is an entitlement
        decision, and with nothing carried `returnTo` IS `/`, i.e. `HomeRedirect`,
        the one place that makes it.
        There is no onboarding and no sign-up: `POST /auth/session` refuses an
        unknown identity with 403 `no_membership`, so a session that resolves
        always belongs to an invited member, and `is_new` is never true here.
        Every session goes to `returnTo`.
      */
      navigate(returnTo, { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification check failed';
      if (msg.includes('not verified')) {
        setError('Email not verified yet. Please check your inbox and click the verification link.');
      } else {
        setError(msg);
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.bgGlow} />
      <div className={styles.card}>
        <div className={styles.logo}>{brand.name}</div>

        <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
          <Mail size={48} style={{ color: 'var(--accent)', marginBottom: 16 }} />
          <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            Verify your email
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            We sent a verification link to{' '}
            <strong style={{ color: 'var(--text-primary)' }}>{firebaseUser.email}</strong>.
            <br />
            Click the link in the email, then come back here.
          </p>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            className="btn-primary"
            onClick={handleCheckVerification}
            disabled={checking}
            style={{ width: '100%' }}
          >
            <RefreshCw size={14} />
            {checking ? 'Checking...' : "I've verified my email"}
          </button>

          <button
            className="btn-secondary"
            onClick={handleResend}
            disabled={resending || resent}
            style={{ width: '100%' }}
          >
            <Mail size={14} />
            {resent ? 'Verification email sent!' : resending ? 'Sending...' : 'Resend verification email'}
          </button>

          <button
            className="btn-secondary"
            onClick={logout}
            style={{ width: '100%' }}
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
