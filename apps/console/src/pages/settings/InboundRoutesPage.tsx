import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PhoneIncoming, Plus, Trash2 } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { useTenant } from '../../contexts/TenantContext';
import { usePermission } from '../../hooks/usePermission';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { deleteInboundRoute, listInboundRoutes } from '../../api/inbound';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { PageDescription } from '../../components/common/PageDescription';
import { formatDialNumber } from '../../utils/softphone/phoneInput';
import { STICKY_MODE_LABELS, inboundRefusalCopy } from '../../utils/inbound/inboundCopy';
import { weeklyHoursSummary } from '../../utils/inbound/routeForm';
import type { AgencyInboundRoute } from '../../types/inbound';
import styles from '../../components/agency/inbound/Inbound.module.css';

/**
 * Settings → Inbound calls (`docs/inbound.md` §8.1): the account's inbound routes. A route
 * says which of the account's numbers it answers, when it is open, what callers hear, who their
 * call goes to and what happens when nobody answers. Account admins only
 * (`agency.inbound.write`); behind `agency_inbound_enabled` (the route's `RequireFlag`, read
 * again here so the page fails closed wherever it is mounted).
 *
 * Linking a number to inbound calls is the service's (a super-admin, IB6): the editor shows an
 * unlinked number as unavailable, with "contact support".
 */
export default function InboundRoutesPage() {
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();
  const canWrite = usePermission('agency.inbound.write');
  const flagOn = useFeatureFlagEnabled(INBOUND_FLAG);
  const [routes, setRoutes] = useState<AgencyInboundRoute[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AgencyInboundRoute | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !accountId || !canWrite || !flagOn) return;
    setLoadError(null);
    try {
      setRoutes(await listInboundRoutes(tenantId, accountId));
    } catch (err) {
      setLoadError(getErrorMessage(err, 'We couldn’t load the inbound routes.'));
    }
  }, [tenantId, accountId, canWrite, flagOn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canWrite || !flagOn) return <CapabilityUnavailable />;

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    const result = await deleteInboundRoute(deleting.id, tenantId ?? undefined, accountId ?? undefined);
    setBusy(false);
    if (!result.ok && result.refusal.code !== 'inbound_route_not_found') {
      setDeleteError(inboundRefusalCopy(result.refusal));
      return;
    }
    showToast(`“${deleting.name}” deleted.`, 'success');
    setRoutes((current) => (current ?? []).filter((r) => r.id !== deleting.id));
    setDeleting(null);
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Inbound calls"
        actions={
          <Link to="/settings/inbound/new" className={`btn-primary ${styles.iconLabel}`} data-testid="inbound-new-route">
            <Plus size={15} aria-hidden="true" />
            New route
          </Link>
        }
      />
      <PageDescription
        pageKey="inbound-routes"
        description={
          'When customers ring the numbers you call them from, a route decides what happens: when you are open, what they hear, '
          + 'which agent they reach first, and how a call nobody answers becomes a callback someone owns.'
        }
        tips={[
          'Each number answers one route. Numbers have to be linked to inbound calls by support first.',
          'A call nobody answers appears under Missed calls, assigned to the agent the customer last dealt with.',
        ]}
      />
      {loadError ? <ErrorAlert message={loadError} onRetry={() => void load()} /> : null}
      {routes === null && !loadError ? <LoadingSpinner /> : null}
      {routes !== null && routes.length === 0 ? (
        <EmptyState
          icon={<PhoneIncoming size={32} />}
          title="No inbound routes yet"
          description="Until a number has a route, callers to it hear a short closed message. The call appears under Missed calls only when the caller is recognised as one of this account's customers."
        />
      ) : null}
      {routes && routes.length > 0 ? (
        <ul className={styles.routeList} aria-label="Inbound routes">
          {routes.map((route) => (
            <li key={route.id} className={`card ${styles.routeCard}`} data-testid={`inbound-route-${route.id}`}>
              <div className={styles.routeMain}>
                <h2 className={styles.routeName}>{route.name}</h2>
                <p className={styles.routeMeta}>
                  {route.numbers.length > 0
                    ? route.numbers.map((n) => formatDialNumber(n.phone_number)).join(', ')
                    : 'No numbers yet: it answers nothing'}
                </p>
                <p className={styles.routeMeta}>
                  {weeklyHoursSummary(route)} ({route.timezone})
                  {route.holidays.length > 0 ? ` · ${route.holidays.length} holiday${route.holidays.length === 1 ? '' : 's'}` : ''}
                </p>
                <p className={styles.routeMeta}>Their agent first: {STICKY_MODE_LABELS[route.sticky_mode].label}</p>
              </div>
              <div className={styles.buttonRow}>
                <Link to={`/settings/inbound/${route.id}`} className="btn-secondary" aria-label={`Edit ${route.name}`}>
                  Edit
                </Link>
                <button
                  type="button"
                  className={`btn-secondary ${styles.iconLabel}`}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(route);
                  }}
                  aria-label={`Delete ${route.name}`}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `Delete “${deleting.name}”?` : 'Delete route?'}
        message={
          deleteError
          ?? (deleting && deleting.numbers.length > 0
            ? `Its ${deleting.numbers.length === 1 ? 'number stops' : `${deleting.numbers.length} numbers stop`} answering with this route. Until another route takes ${deleting.numbers.length === 1 ? 'it' : 'them'}, callers hear a short closed message.`
            : 'The route answers no numbers, so no calls are affected.')
        }
        confirmLabel={busy ? 'Deleting…' : 'Delete route'}
        danger
        disabled={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
