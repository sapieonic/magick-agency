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
import { hasPermission } from '../../utils/permissions';
import { PageDescription } from '../../components/common';
import type { Account, Membership } from '../../types/auth';
import { CreateAccountModal } from './CreateAccountModal';
import styles from './AccountsPage.module.css';

/**
 * Whether the signed-in person may create accounts here: the `account.create`
 * role (tenant admin or owner) on a TENANT-WIDE membership. The server refuses an
 * account-scoped seat at that role (`tenant_wide_membership_required`), because the
 * account it made would be one it cannot see; the page says so instead of offering
 * a button that can only fail.
 */
export function accountCreateAccess(
  memberships: ReadonlyArray<Pick<Membership, 'tenant_id' | 'account_id' | 'role' | 'status'>>,
  tenantId: string | null,
): 'allowed' | 'account_scoped' | 'not_permitted' {
  const mine = memberships.filter((m) => m.tenant_id === tenantId && m.status === 'active');
  if (mine.some((m) => m.account_id === null && hasPermission(m.role, 'account.create'))) return 'allowed';
  if (mine.some((m) => hasPermission(m.role, 'account.create'))) return 'account_scoped';
  return 'not_permitted';
}

/* ── Accounts Page ────────────────────────────── */

export default function AccountsPage() {
  const { memberships, refreshSession } = useAuth();
  const { tenantId, accountId, setActiveAccountId, reloadAccounts } = useTenant();
  const { accounts, loading, error, reload } = useAccounts();
  const { showToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const access = accountCreateAccess(memberships, tenantId);
  const canCreate = access === 'allowed';

  /**
   * Three refreshes, because three places hold accounts: this page's list, the
   * switcher's (`TenantContext`), and the session's per-account settings map,
   * which is built at sign-in and has no entry for an account made since. Without
   * the session refresh, switching to the new account would read its recording and
   * analysis settings as missing until the next sign-in.
   */
  const handleCreated = (account: Account) => {
    setShowCreate(false);
    showToast(`Account "${account.name}" created`, 'success');
    reload();
    reloadAccounts();
    void refreshSession();
  };

  const createButton = canCreate ? (
    <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
      <Plus size={14} />
      New account
    </button>
  ) : undefined;

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

  return (
    <div className={styles.page}>
      <PageHeader title="Accounts" badge={accounts.length} actions={createButton} />
      <PageDescription
        pageKey="accounts"
        description="Accounts divide your workspace into separate teams. Each account has its own campaigns, settings and call history, and the account switcher at the top moves between them."
        tips={[
          'Invite people to one account, or to the whole workspace, from the Team page.',
          'A new account starts with recording and call analysis off and up to 5 calls at once. Contact support to change its limits.',
        ]}
      />

      {access === 'account_scoped' && (
        <p className={styles.scopedNote} data-testid="accounts-scoped-note">
          Your admin access covers one account rather than the whole workspace, so you
          can’t create accounts. Ask the workspace owner.
        </p>
      )}

      {error && <ErrorAlert message={error} onRetry={reload} />}

      {accounts.length === 0 ? (
        !error && (
          <EmptyState
            icon={<Briefcase size={32} />}
            title="No accounts"
            description="Create an account to start running campaigns."
            action={createButton}
          />
        )
      ) : (
        <div className={styles.tableCard}>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th></th>
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
