import { useState } from 'react';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import type { AgencyInsightsUpload, AgencyInsightsUploads } from '../../../../types/agency-insights';
import { downloadRejectedRows } from '../../../../api/agencyCampaigns';
import { formatCount } from '../../../../utils/format/number';
import { actorName, formatZoned, rejectReasonLabel } from '../../../../utils/agency/insights/copy';
import { insightsCsvFilename } from '../../../../utils/agency/insights/csv';
import { outcomeReportFilename } from '../../../../api/exportCsv';
import { CsvButton, InsightsTable, Panel, tableCsv, type InsightsColumn } from './InsightsParts';
import styles from './Insights.module.css';

/** The reasons a job's rows were rejected, largest first: `Invalid phone number 180, Duplicate 32`. */
export function rejectedBreakdown(upload: AgencyInsightsUpload): string {
  return Object.entries(upload.rejected_by_reason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${rejectReasonLabel(code)} ${formatCount(n)}`)
    .join(', ');
}

/**
 * The roster's upload history. The rejected rows of a job are a server file
 * (`GET /proxy/agency/ingest/jobs/:id/rejected.csv`) that needs the auth headers,
 * so the link is a button that fetches it as a blob, like the upload screen does.
 */
export function UploadsSection({
  campaignId,
  campaignName,
  uploads,
  timezone,
  tenantId,
  accountId,
}: {
  campaignId: string;
  campaignName: string;
  uploads: AgencyInsightsUploads;
  timezone: string;
  tenantId: string | null;
  accountId: string | null;
}) {
  const { showErrorToast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const download = async (upload: AgencyInsightsUpload) => {
    setBusy(upload.job_id);
    try {
      const blob = await downloadRejectedRows(upload.job_id, tenantId ?? undefined, accountId ?? undefined);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `rejected-${outcomeReportFilename(upload.file_name, upload.job_id)}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      showErrorToast(err, 'Could not download the rejected rows.');
    } finally {
      setBusy(null);
    }
  };

  const columns: InsightsColumn<AgencyInsightsUpload>[] = [
    { key: 'file', header: 'File', render: (u) => u.file_name ?? 'Unnamed file', csv: (u) => u.file_name },
    { key: 'by', header: 'Uploaded by', render: (u) => actorName(u.uploaded_by, 'Unknown'), csv: (u) => u.uploaded_by?.name ?? u.uploaded_by?.user_id ?? null },
    { key: 'at', header: 'When', render: (u) => formatZoned(u.created_at, timezone), csv: (u) => u.created_at },
    { key: 'status', header: 'Status', render: (u) => u.status.replace(/_/g, ' '), csv: (u) => u.status },
    { key: 'mode', header: 'Mode', render: (u) => u.mode, csv: (u) => u.mode },
    { key: 'rows', header: 'Rows read', numeric: true, render: (u) => formatCount(u.rows_read), csv: (u) => u.rows_read },
    { key: 'accepted', header: 'Accepted', numeric: true, render: (u) => formatCount(u.accepted), csv: (u) => u.accepted },
    {
      key: 'rejected',
      header: 'Rejected',
      numeric: true,
      render: (u) => <span title={rejectedBreakdown(u) || undefined}>{formatCount(u.rejected)}</span>,
      csv: (u) => u.rejected,
    },
    { key: 'reasons', header: 'Rejected because', render: (u) => rejectedBreakdown(u) || '—', csv: (u) => rejectedBreakdown(u) },
    {
      key: 'duplicates',
      header: 'Duplicates',
      numeric: true,
      render: (u) => `${formatCount(u.duplicates)} on ${u.dedupe_columns.length > 0 ? u.dedupe_columns.join(' + ') : 'phone'}`,
      csv: (u) => u.duplicates,
    },
    {
      key: 'export',
      header: 'Rejected rows',
      render: (u) =>
        u.has_rejected_export ? (
          <button
            type="button"
            className={styles.disclosure}
            onClick={() => void download(u)}
            disabled={busy === u.job_id}
            aria-label={`Download the rejected rows of ${u.file_name ?? 'this upload'}`}
          >
            {busy === u.job_id ? 'Downloading…' : 'Download'}
          </button>
        ) : '—',
      csv: (u) => (u.has_rejected_export ? `/proxy/agency/ingest/jobs/${u.job_id}/rejected.csv` : null),
    },
  ];

  return (
    <Panel
      id="uploads"
      title="Upload history"
      sub={`${formatCount(uploads.uploads.length)} committed ${uploads.uploads.length === 1 ? 'upload' : 'uploads'}, newest first`}
      actions={uploads.uploads.length ? <CsvButton filename={insightsCsvFilename(campaignName, 'uploads', campaignId)} build={() => tableCsv(columns, uploads.uploads)} /> : undefined}
    >
      {uploads.uploads.length === 0 ? (
        <p className={styles.muted}>No contacts have been uploaded to this campaign.</p>
      ) : (
        <InsightsTable caption="Roster uploads" columns={columns} rows={uploads.uploads} rowKey={(u) => u.job_id} testId="uploads-table" />
      )}
    </Panel>
  );
}
