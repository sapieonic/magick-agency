import { useState, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { SuperAdminSidebar } from './SuperAdminSidebar';
import { Menu, LogOut, KeyRound } from 'lucide-react';
import { changePassword } from '../../api/super-admin';
import styles from './SuperAdminLayout.module.css';

export function SuperAdminLayout() {
  const { admin, logout } = useSuperAdmin();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [pwForm, setPwForm] = useState({ current: '', newPw: '', confirm: '' });
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  const handleMenuClick = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleLogout = useCallback(() => {
    logout();
    window.location.href = '/login';
  }, [logout]);

  const openChangePw = useCallback(() => {
    setPwForm({ current: '', newPw: '', confirm: '' });
    setPwError(null);
    setPwSuccess(false);
    setShowChangePw(true);
  }, []);

  const handleChangePw = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(null);

    if (pwForm.newPw !== pwForm.confirm) {
      setPwError('New passwords do not match');
      return;
    }

    setPwSubmitting(true);
    try {
      await changePassword(pwForm.current, pwForm.newPw);
      setPwSuccess(true);
      setPwForm({ current: '', newPw: '', confirm: '' });
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setPwSubmitting(false);
    }
  };

  return (
    <div className={styles.layout}>
      <div className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}>
        <SuperAdminSidebar onClose={handleSidebarClose} />
      </div>

      {sidebarOpen && (
        <div className={styles.overlay} onClick={handleSidebarClose} />
      )}

      <div className={styles.main}>
        <div className={styles.topbar}>
          <button className={styles.menuBtn} onClick={handleMenuClick} aria-label="Toggle menu">
            <Menu size={20} />
          </button>
          <div className={styles.topbarRight}>
            <span className={styles.adminName}>{admin?.name || admin?.email}</span>
            <button className={styles.changePwBtn} onClick={openChangePw} title="Change Password">
              <KeyRound size={16} />
            </button>
            <button className={styles.logoutBtn} onClick={handleLogout} title="Logout">
              <LogOut size={16} />
            </button>
          </div>
        </div>
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>

      {showChangePw && (
        <div className={styles.modal}>
          <div className={styles.modalBackdrop} onClick={() => setShowChangePw(false)} />
          <div className={styles.modalContent}>
            <h3>Change Password</h3>
            {pwSuccess ? (
              <div className={styles.successMsg}>
                Password changed successfully.
                <div className={styles.modalActions}>
                  <button className="btn-primary" onClick={() => setShowChangePw(false)}>Close</button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleChangePw} className={styles.pwForm}>
                <div className={styles.pwField}>
                  <label>Current Password</label>
                  <input
                    type="password"
                    value={pwForm.current}
                    onChange={e => setPwForm(f => ({ ...f, current: e.target.value }))}
                    required
                    autoComplete="current-password"
                  />
                </div>
                <div className={styles.pwField}>
                  <label>New Password</label>
                  <input
                    type="password"
                    value={pwForm.newPw}
                    onChange={e => setPwForm(f => ({ ...f, newPw: e.target.value }))}
                    minLength={8}
                    placeholder="Min 8 characters"
                    required
                    autoComplete="new-password"
                  />
                </div>
                <div className={styles.pwField}>
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    value={pwForm.confirm}
                    onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                    minLength={8}
                    required
                    autoComplete="new-password"
                  />
                </div>
                {pwError && <div className={styles.pwError}>{pwError}</div>}
                <div className={styles.modalActions}>
                  <button type="button" className="btn-secondary" onClick={() => setShowChangePw(false)}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={pwSubmitting}>
                    {pwSubmitting ? 'Changing...' : 'Change Password'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
