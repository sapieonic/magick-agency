import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { brand } from '../../brand';
import styles from './SuperAdminLoginPage.module.css';

/**
 * The admin sign-in page. This app has no Firebase sign-in, so there are no
 * customer tabs, Google button, forgot-password view, promo banner or festive
 * decor. Behaviour: email + password → `login()` → the app root.
 */
export default function SuperAdminLoginPage() {
  const navigate = useNavigate();
  const { login, loading, error } = useSuperAdmin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  const isLoading = submitting || loading;
  const displayError = localError || error;

  return (
    <div className={styles.page}>
      <div className={styles.bgGlow} />
      <div className={styles.layoutCentered}>
        <div className={styles.card}>
          <div className={styles.logo}>{brand.name}</div>
          <p className={styles.tagline}>Platform Administration</p>

          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.field}>
              <label htmlFor="email">Email</label>
              <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.com" required autoComplete="email" />
            </div>

            <div className={styles.field}>
              <label htmlFor="password">Password</label>
              <input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" required autoComplete="current-password" />
            </div>

            {displayError && <div className={styles.error} role="alert">{displayError}</div>}

            <button type="submit" className="btn-primary" disabled={isLoading} style={{ width: '100%' }}>
              {isLoading ? 'Please wait...' : 'Sign In as Admin'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
