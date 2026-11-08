import { StatusBadge } from '@magick-agency/web-ui/components/StatusBadge';
import type { ReportRunStatus } from '@magick-agency/contracts/api/agency/reports';
import { isPendingStatus, REPORT_STATUS_META } from '../../../utils/reports/reportCopy';

/**
 * A run's status as one pill: "Preparing…" for the three in-flight statuses
 * (queued, assembling, rendering — the reader has nothing to do differently between
 * them; the tooltip says which), then Ready, Failed or Expired.
 */
export function ReportStatusPill({ status }: { status: ReportRunStatus }) {
  const meta = REPORT_STATUS_META[status];
  // The badge picks its icon from the status key: a spinner while in flight.
  const iconKey = isPendingStatus(status) ? 'executing' : status === 'ready' ? 'success' : status === 'failed' ? 'failed' : 'inactive';
  return (
    <span data-testid="report-status" data-status={status}>
      <StatusBadge label={meta.label} color={meta.color} tooltip={meta.tooltip} status={iconKey} />
    </span>
  );
}

export default ReportStatusPill;
