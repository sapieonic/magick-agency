import { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, Search } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { hasPermission } from '../../utils/permissions';
import { setAgencyCampaignArchived } from '../../api/agencyCampaigns';
import { ARCHIVE_TOASTS, archivedLine, trackArchiveAction } from '../../utils/agencyCampaignArchive';
import { filterCampaigns, SEARCH_THRESHOLD } from '../../utils/agencyCampaignsHome';
import { formatCount } from '../../utils/format/number';
import { useArchivedCampaigns } from './campaigns-home/useArchivedCampaigns';
import { CampaignRow } from './campaigns-home/CampaignRow';
import styles from './AgencyCampaignsPage.module.css';

/**
 * Archived campaigns (decisions AR1–AR7): the drafts and stopped campaigns taken off the
 * Campaigns page, newest archived first. Each row opens the campaign, whose results are all still
 * there, and Restore puts it back on the Campaigns page as it was (for whoever may archive,
 * `agency.campaigns.write`, the server's gate). Reached from the Campaigns page's link under its
 * list, and from search.
 */
export function AgencyArchivedCampaignsPage() {
  const { tenantId, accountId, role, accounts } = useTenant();
  const { showToast, showErrorToast } = useToast();
  const { campaigns, total, error, loading, loadingMore, moreError, load, loadMore, removed } =
    useArchivedCampaigns(tenantId, accountId);
  const [query, setQuery] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  /*
    Synchronous with the click, as `useCampaignArchive`'s: two clicks in one frame both see
    `restoring === null`, and the second POST would 409 right after the first succeeded.
  */
  const busyRef = useRef(false);
  /** Where focus goes once a restored row has gone (its button went with it). */
  const headingRef = useRef<HTMLHeadingElement>(null);
  const canRestore = hasPermission(role, 'agency.campaigns.write');
  const accountName = accounts?.find((a) => a.id === accountId)?.name;

  const visible = useMemo(() => filterCampaigns(campaigns ?? [], 'all', query), [campaigns, query]);
  const partial = (campaigns?.length ?? 0) < total;

  const restore = async (id: string) => {
    if (!tenantId || !accountId || busyRef.current) return;
    busyRef.current = true;
    setRestoring(id);
    try {
      const restored = await setAgencyCampaignArchived(id, 'unarchive', tenantId, accountId);
      removed(id);
      trackArchiveAction({ id, status: restored.status }, 'unarchive', 'archived_list');
      showToast(ARCHIVE_TOASTS.restored, 'success');
      headingRef.current?.focus();
    } catch (err: unknown) {
      showErrorToast(err, ARCHIVE_TOASTS.restoreFailed);
      // A 409 means it is not archived any more (restored from elsewhere): re-read the list.
      void load(true);
    } finally {
      busyRef.current = false;
      setRestoring(null);
    }
  };

  /*
    Every loaded row restored while older ones remain: read the list again rather than show an
    empty list above "Show older".
  */
  const drained = campaigns !== null && campaigns.length === 0 && total > 0;
  useEffect(() => {
    if (drained) void load(true);
  }, [drained, load]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          {accountName && <p className={styles.eyebrow}>{accountName}</p>}
          <h1 className={styles.title} ref={headingRef} tabIndex={-1}>Archived campaigns</h1>
          <p className={styles.subtitle}>
            {campaigns && total > 0
              ? `${formatCount(total)} archived ${total === 1 ? 'campaign' : 'campaigns'}. Open one to see its results${canRestore ? ', or restore it to the Campaigns page' : ''}.`
              : 'Drafts and stopped campaigns taken off the Campaigns page.'}
          </p>
        </div>
      </header>

      {error && <ErrorAlert message={error} onRetry={() => void load()} />}

      {loading && !campaigns && <LoadingSpinner />}

      {campaigns && total === 0 && !error && (
        <p className={styles.noMatch} data-testid="archived-empty">
          No archived campaigns.
          {canRestore && ' Archive a draft or a stopped campaign from its page to take it off the Campaigns page.'}
        </p>
      )}

      {campaigns && total > 0 && (
        <div className={styles.mainCol}>
          <section className={styles.section} aria-labelledby="campaigns-archived-heading">
            <h2 id="campaigns-archived-heading" className={styles.sectionTitle}>
              Archived
            </h2>
            {total > SEARCH_THRESHOLD && (
              <div className={styles.toolbar}>
                <label className={styles.search}>
                  <Search size={15} aria-hidden="true" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name"
                    aria-label="Search archived campaigns by name"
                  />
                </label>
              </div>
            )}

            {visible.length > 0 ? (
              <ul className={styles.list} role="list" aria-labelledby="campaigns-archived-heading">
                {visible.map((c) => (
                  <li key={c.id} className={styles.archivedItem}>
                    <CampaignRow campaign={c} lead={archivedLine(c)} />
                    {canRestore && (
                      <button
                        type="button"
                        className={`btn-secondary ${styles.restoreAction}`}
                        onClick={() => void restore(c.id)}
                        disabled={restoring !== null}
                        aria-label={`${restoring === c.id ? 'Restoring' : 'Restore'} ${c.name}`}
                      >
                        <ArchiveRestore size={15} aria-hidden="true" />
                        {restoring === c.id ? 'Restoring…' : 'Restore'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.noMatch}>
                {query.trim() ? `No archived campaigns match “${query.trim()}”.` : 'No archived campaigns shown.'}
              </p>
            )}

            {partial && (
              <div className={styles.more}>
                <p className={styles.moreText}>
                  Showing the latest {formatCount(campaigns.length)} of {formatCount(total)}. Search covers the
                  campaigns shown.
                </p>
                <button type="button" className="btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Show older campaigns'}
                </button>
                {moreError && <p className={styles.moreError}>{moreError}</p>}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default AgencyArchivedCampaignsPage;
