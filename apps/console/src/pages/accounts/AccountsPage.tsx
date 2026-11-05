import { useState } from 'react';
import { Briefcase, Plus } from 'lucide-react';
import { formatRelativeTime } from '@magick-agency/web-ui/format';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { useAccounts } from '../../hooks/useAccounts';
import { accountCreateAccess } from '../../utils/accountCreateAccess';
import { trackSetupEvent } from '../../analytics/events';
import { PageDescription } from '../../components/common';
import type { Account } from '../../types/auth';
import { CreateAccountModal } from './CreateAccountModal';
import styles from './AccountsPage.module.css';

/**
 * The Call limit cell, from the session's per-account settings (the effective values the
 * server resolves). A new account a tenant admin made reads 0 until a super admin sets
 * its limit (decision AA4), and the cell says so in words rather than leaving a bare 0
 * for someone to wonder about. Absent: the session has no entry (it is refreshed after a
 * create; an account made elsewhere since sign-in has none until the next one).
 */
function CallLimit({ limit }: { limit: number | undefined }) {
  if (limit === undefined) return <span className={styles.muted}>—</span>;
  if (limit === 0) return <span className={styles.muted}>Not set yet</span>;
  return <span className={styles.muted}>{limit} at once</span>;
}

/* ── Accounts Page ────────────────────────────── */

export default function AccountsPage() {
  const { memberships, settings, refreshSession } = useAuth();
  const { tenantId, accountId, setActiveAccountId, reloadAccounts } = useTenant();
  const { accounts, loading, error, reload } = useAccounts();
  const { showToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const access = accountCreateAccess(memberships, tenantId);
  const canCreate = access === 'allowed';

  /**
   * Three refreshes, because three places hold accounts: this page's list, the
   * switcher's (`TenantContext`), and the session's per-account settings map, which is
   * built at sign-in and has no entry for an account made since. Without the session
   * refresh, the new account's governance map and call limit would read as missing.
   */
  const handleCreated = (account: Account) => {
    setShowCreate(false);
    trackSetupEvent('account_created', { account_count: accounts.length + 1 });
    showToast(`Account "${account.name}" created`, 'success');
    reload();
    reloadAccounts();
    void refreshSession();
  };

  const openCreate = () => setShowCreate(true);
  const createButton = (
    <button type="button" className="btn-primary" onClick={openCreate}>
      <Plus size={14} />
      New account
    </button>
  );

  if (loading && accounts.length === 0) {
    return (
      <div className={styles.page}>
        <PageHeader title="Accounts" />
        <div className={styles.loadingWrap}>
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }

  const empty = accounts.length === 0;

  return (
    <div className={styles.page}>
      {/* With no accounts the empty state carries the one button; two would compete. */}
      <PageHeader title="Accounts" badge={accounts.length} actions={canCreate && !empty ? createButton : undefined} />
      <PageDescription
        pageKey="accounts"
        description="Accounts divide your workspace into separate teams. Each account has its own campaigns, settings and call history, and the account switcher at the top moves between them."
        tips={[
          'Invite people to one account, or to the whole workspace, from the Team page.',
          'A new account can’t place calls until support sets its call limit. You can set up its campaigns and team in the meantime.',
        ]}
      />

      {access === 'account_scoped' && (
        <p className={styles.scopedNote} data-testid="accounts-scoped-note">
          Your admin access covers one account rather than the whole workspace, so you
          can’t create accounts. Ask an admin with access to the whole workspace.
        </p>
      )}

      {error && <ErrorAlert message={error} onRetry={reload} />}

      {empty ? (
        !error && (
          <EmptyState
            icon={<Briefcase size={32} />}
            title="No accounts"
            description={canCreate
              ? 'Create an account to start running campaigns.'
              : 'Ask an admin with access to the whole workspace to create one.'}
            action={canCreate ? createButton : undefined}
          />
        )
      ) : (
        <div className={styles.tableCard}>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Call limit</th>
                  <th>Created</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const current = a.id === accountId;
                  return (
                    <tr key={a.id} data-testid={`account-row-${a.id}`}>
                      <td>
                        <div className={styles.nameCell}>
                          <span className={styles.name}>{a.name}</span>
                          {current && <span className={styles.currentBadge}>Current</span>}
                        </div>
                      </td>
                      <td>
                        <CallLimit limit={settings[a.id]?.max_concurrent_calls} />
                      </td>
                      <td>
                        <span className={styles.muted}>{formatRelativeTime(a.created_at)}</span>
                      </td>
                      <td className={styles.actionsCell}>
                        {!current && (
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => setActiveAccountId(a.id)}
                            aria-label={`Switch to ${a.name}`}
                          >
                            Switch to
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateAccountModal onClose={() => setShowCreate(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}
