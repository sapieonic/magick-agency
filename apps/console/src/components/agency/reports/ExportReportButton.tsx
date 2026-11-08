import { useState } from 'react';
import { FileDown } from 'lucide-react';
import type { ReportKind } from '@magick-agency/contracts/api/agency/reports';
import { useReportsAccess, type ReportsAccess } from '../../../hooks/useReportsAccess';
import type { ReportEntry } from '../../../analytics/events';
import { ExportReportDialog, type ExportReportTarget } from './ExportReportDialog';

/**
 * What an entry point asks to export: a subject it names (a supervisor's export of an
 * agent, a campaign or the account), or the caller's own review (`self`).
 */
export type ExportEntryTarget =
  | { self: true; name?: string | null }
  | { self?: false; kind: ReportKind; subject: { id: string; name: string | null }; campaignTimezone?: string | null };

/**
 * Whether this person may use an entry point (`docs/reports.md` "Who may run what").
 * The ONE gate every export button goes through:
 * - flag `agency_reports_enabled` off → never;
 * - their own review → anyone who can open a station, once their user id is known;
 * - any other subject (an agent, a campaign, the account) → `agency.supervise` only.
 */
export function mayExport(access: ReportsAccess, target: ExportEntryTarget): boolean {
  if (!access.enabled) return false;
  if (target.self) return access.canSelf && access.userId !== null;
  return access.canSupervise;
}

const BUTTON_LABELS: Record<ReportKind, string> = {
  agent: 'Export agent review',
  campaign: 'Export campaign report',
  account: 'Export account report',
};

/**
 * An export entry point: a button that opens the export dialog with its kind and
 * subject preset. Renders nothing for someone {@link mayExport} refuses, so a page
 * can place it unconditionally.
 */
export function ExportReportButton({
  target,
  entry,
  className = 'btn-secondary',
}: {
  target: ExportEntryTarget;
  entry: ReportEntry;
  className?: string;
}) {
  const access = useReportsAccess();
  const [open, setOpen] = useState(false);
  if (!mayExport(access, target)) return null;

  const dialogTarget: ExportReportTarget = target.self
    ? {
        kind: 'agent',
        subject: { id: access.userId as string, name: target.name ?? access.userName },
        // A supervisor's own review is still the full one: the server picks the
        // audience from the caller, and only says `self` without `agency.supervise`.
        selfAudience: !access.canSupervise,
      }
    : { kind: target.kind, subject: target.subject, campaignTimezone: target.campaignTimezone ?? null };

  const label = target.self ? 'Export my review' : BUTTON_LABELS[target.kind];

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        data-testid={`report-entry-${entry}`}
      >
        <FileDown size={14} aria-hidden="true" />
        {label}
      </button>
      <ExportReportDialog open={open} onClose={() => setOpen(false)} target={dialogTarget} entry={entry} />
    </>
  );
}

export default ExportReportButton;
