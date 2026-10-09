import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, Plus } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { listAgencyCampaigns } from '../../api/agencyCampaigns';
import { hasPermission } from '../../utils/permissions';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { PageDescription } from '../../components/common/PageDescription';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import type { AgencyCampaign } from '../../types/agency-campaign';
import styles from './AgencyCampaignsPage.module.css';

/**
 * The campaign list.
 *
 * Deliberately thin: name, status, and a way in. The counters that would make
 * this a dashboard (`contacts_pending`, `attempts_connected`, agents live) come
 * from a per-campaign `/stats` call, and firing N of them to decorate a list
 * would be N round trips for numbers nobody reads at this level. The detail
 * page fetches them for the one campaign being looked at.
 */
export function AgencyCampaignsPage() {
  const { tenantId, accountId, role } = useTenant();
  const [campaigns, setCampaigns] = useState<AgencyCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!tenantId || !accountId) return;
    setLoading(true);
    setError(null);
    listAgencyCampaigns(tenantId, accountId)
      .then((rows) => setCampaigns(rows))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not load campaigns.'),
      )
      .finally(() => setLoading(false));
  }, [tenantId, accountId]);

  useEffect(load, [load]);

  const canCreate = hasPermission(role, 'agency.campaigns.write');

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Campaigns</h1>
        </div>
        {canCreate && (
          <Link to="/agency/campaigns/new" className="btn-primary">
            <Plus size={16} />
            New campaign
          </Link>
        )}
      </div>

      <PageDescription
        pageKey="agency-campaigns"
        description={
          'An agency campaign dials a roster of contacts and connects answered calls to a live agent. '
          + 'Agents join from the agent station; the campaign decides who gets dialed, when, and how often.'
        }
        tips={[
          'A campaign starts as a draft. Nothing is dialed until you start it.',
          'Only one campaign can run at a time per account.',
          'Stopping a campaign lets calls already in progress finish.',
        ]}
      />

      {error && <ErrorAlert message={error} onRetry={load} />}

      {loading && !campaigns && <LoadingSpinner />}

      {!loading && campaigns?.length === 0 && (
        <EmptyState
          icon={<ListChecks size={32} />}
          title="No campaigns yet"
          description="Create a campaign, upload a roster, and your agents can start taking calls."
          action={
            canCreate ? (
              <Link to="/agency/campaigns/new" className="btn-primary">
                New campaign
              </Link>
            ) : undefined
          }
        />
      )}

      {campaigns && campaigns.length > 0 && (
        <div className={styles.list}>
          {campaigns.map((campaign) => (
            <Link
              key={campaign.id}
              to={`/agency/campaigns/${campaign.id}`}
              className={styles.row}
            >
              <div className={styles.rowMain}>
                <span className={styles.rowName}>{campaign.name}</span>
                {/* No description: the API stores none, so this row rendered the
                    name and then nothing. See the note on `AgencyCampaign`. */}
              </div>
              <AgencyCampaignStatusBadge status={campaign.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default AgencyCampaignsPage;
