import { useId, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import type { AgencyCreateReportRequest, ReportFormat, ReportKind } from '@magick-agency/contracts/api/agency/reports';
import { REPORT_FORMATS, reportWindowDays } from '@magick-agency/contracts/api/agency/reports';
import { useTenant } from '../../../contexts/TenantContext';
import { createReport, reportErrorCode, reportErrorMessage } from '../../../api/reports';
import { reportRunPath } from '../../../hooks/useReportsAccess';
import { trackAgencyReportRefused, trackAgencyReportRequested, type ReportEntry } from '../../../analytics/events';
import {
  REPORT_WINDOW_PRESETS,
  browserZone,
  presetWindow,
  reportWindowError,
  reportZoneOptions,
  todayIn,
  type ReportWindowPreset,
} from '../../../utils/reports/reportWindow';
import {
  REPORT_FORMAT_LABELS,
  REPORT_KIND_LABELS,
  SELF_REVIEW_NOTE,
  formatReportWindow,
} from '../../../utils/reports/reportCopy';
import styles from './Reports.module.css';

/** What an export is about, preset by the entry point that opened the dialog. */
export interface ExportReportTarget {
  kind: ReportKind;
  subject: { id: string; name: string | null };
  /** Campaign reports only: the campaign's own zone, which the server always uses (RP3). */
  campaignTimezone?: string | null;
  /**
   * The caller's own agent review requested without `agency.supervise`: the server
   * builds it with the reduced `self` audience (RP5), and the dialog says so.
   */
  selfAudience?: boolean;
}

export interface ExportReportDialogProps {
  open: boolean;
  onClose: () => void;
  target: ExportReportTarget;
  /** Where it was opened from, for analytics. */
  entry: ReportEntry;
  /** Injectable for tests: the clock the presets and "today" are read from. */
  now?: Date;
}

export function exportDialogTitle(target: ExportReportTarget): string {
  if (target.kind === 'agent') return target.selfAudience ? 'Export my review' : 'Export agent review';
  return target.kind === 'campaign' ? 'Export campaign report' : 'Export account report';
}

/**
 * The export dialog, one for every kind (`docs/reports.md`): a window (four presets
 * or two dates, held to the contract's rule), the zone (the browser's by default for
 * agent and account reports; the campaign's, read-only, for a campaign report), the
 * formats (at least one), and whether to email the requester. Submitting queues the
 * run; the 202 closes the dialog with a toast that links to the run. A refusal stays
 * in the dialog, beside the fields.
 *
 * Unmounted while closed, so every opening starts from the defaults.
 */
export function ExportReportDialog(props: ExportReportDialogProps) {
  if (!props.open) return null;
  return <OpenExportReportDialog {...props} />;
}

function OpenExportReportDialog({ onClose, target, entry, now }: ExportReportDialogProps) {
  const { tenantId, accountId, role } = useTenant();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const ids = useId();
  const formId = `${ids}-form`;
  const windowErrorId = `${ids}-window-error`;
  const formatErrorId = `${ids}-format-error`;
  const submitErrorId = `${ids}-submit-error`;

  const isCampaign = target.kind === 'campaign';
  const [preset, setPreset] = useState<ReportWindowPreset>('last_7_days');
  const [zone, setZone] = useState<string>(() => browserZone());
  // A campaign whose zone this page does not know yet bounds its dates by the browser's zone;
  // the server cuts the days in the campaign's own zone either way (RP3).
  const campaignZone = isCampaign ? target.campaignTimezone || null : null;
  const reportZone = campaignZone ?? zone;
  const [clock] = useState<Date>(() => now ?? new Date());
  const today = todayIn(reportZone, clock);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [formats, setFormats] = useState<Record<ReportFormat, boolean>>({ pdf: true, xlsx: true });
  const [emailMe, setEmailMe] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const dates = preset === 'custom' ? { from: customFrom, to: customTo } : presetWindow(preset, today);
  const windowError = reportWindowError(dates.from, dates.to, today);
  // A half-typed custom window is not an error yet; a submit attempt makes it one.
  const showWindowError = windowError !== null && (attempted || (preset === 'custom' && customFrom !== '' && customTo !== ''));
  const chosenFormats = REPORT_FORMATS.filter((f) => formats[f]);
  const formatError = chosenFormats.length === 0 ? 'Choose at least one format.' : null;
  const zoneOptions = useMemo(() => reportZoneOptions(zone), [zone]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setSubmitError(null);
    if (windowError !== null || formatError !== null || !tenantId || !accountId) return;
    const request: AgencyCreateReportRequest = {
      kind: target.kind,
      subject_id: target.subject.id,
      from: dates.from,
      to: dates.to,
      formats: chosenFormats,
      ...(isCampaign ? {} : { timezone: zone }),
      ...(emailMe ? { email_me: true } : {}),
    };
    setSubmitting(true);
    try {
      const run = await createReport(request, tenantId, accountId);
      trackAgencyReportRequested({
        kind: target.kind,
        entry,
        preset,
        days: reportWindowDays(dates.from, dates.to) ?? 0,
        pdf: formats.pdf,
        xlsx: formats.xlsx,
        email_me: emailMe,
        self: target.selfAudience === true,
      });
      const path = reportRunPath(role, run.id);
      showToast(
        emailMe
          ? `Your ${REPORT_KIND_LABELS[target.kind].toLowerCase()} is being prepared. We’ll email you when it’s ready.`
          : `Your ${REPORT_KIND_LABELS[target.kind].toLowerCase()} is being prepared.`,
        'success',
        8000,
        { label: 'View report', onClick: () => navigate(path) },
      );
      onClose();
    } catch (err) {
      trackAgencyReportRefused({ kind: target.kind, entry, code: reportErrorCode(err) });
      setSubmitError(reportErrorMessage(err, 'We couldn’t start this export. Try again.'));
      setSubmitting(false);
    }
  };

  const subjectName = target.subject.name ?? REPORT_KIND_LABELS[target.kind];

  return (
    <Modal
      open
      onClose={onClose}
      title={exportDialogTitle(target)}
      subtitle={subjectName}
      size="md"
      closeOnOverlayClick={!submitting}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn-primary" disabled={submitting} data-testid="report-export-submit">
            {submitting ? 'Exporting…' : 'Export'}
          </button>
        </>
      }
    >
      <form id={formId} className={styles.dialogForm} onSubmit={(e) => void submit(e)} noValidate>
        {target.selfAudience ? (
          <p className={styles.note} data-testid="report-self-note">
            {SELF_REVIEW_NOTE}
          </p>
        ) : null}

        <fieldset className={styles.fieldset} aria-describedby={showWindowError ? windowErrorId : undefined}>
          <legend className={styles.legend}>Window</legend>
          <div className={styles.presets}>
            {REPORT_WINDOW_PRESETS.map((p) => (
              <label key={p.id} className={styles.presetOption}>
                <input
                  type="radio"
                  name={`${ids}-preset`}
                  value={p.id}
                  checked={preset === p.id}
                  onChange={() => setPreset(p.id)}
                  data-autofocus={preset === p.id ? 'true' : undefined}
                />
                {p.label}
              </label>
            ))}
          </div>
          {preset === 'custom' ? (
            <div className={styles.customDates}>
              <div className="form-group">
                <label htmlFor={`${ids}-from`}>From</label>
                <input
                  id={`${ids}-from`}
                  type="date"
                  value={customFrom}
                  max={today}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  aria-invalid={showWindowError ? 'true' : undefined}
                />
              </div>
              <div className="form-group">
                <label htmlFor={`${ids}-to`}>To</label>
                <input
                  id={`${ids}-to`}
                  type="date"
                  value={customTo}
                  max={today}
                  onChange={(e) => setCustomTo(e.target.value)}
                  aria-invalid={showWindowError ? 'true' : undefined}
                />
              </div>
            </div>
          ) : null}
          {windowError === null ? (
            <p className={styles.hint} data-testid="report-window-summary">
              {formatReportWindow(dates)}
            </p>
          ) : null}
          <p className="field-hint">At most 30 days, or exactly one calendar month.</p>
          {showWindowError ? (
            <p id={windowErrorId} className={styles.inlineError} role="alert" data-testid="report-window-error">
              {windowError}
            </p>
          ) : null}
        </fieldset>

        {isCampaign ? (
          <p className={styles.hint} data-testid="report-campaign-zone">
            {campaignZone ? `Days are cut in ${campaignZone}, the campaign’s time zone.` : 'Days are cut in the campaign’s time zone.'}
          </p>
        ) : (
          <div className="form-group">
            <label htmlFor={`${ids}-zone`}>Time zone</label>
            <select id={`${ids}-zone`} value={zone} onChange={(e) => setZone(e.target.value)}>
              {zoneOptions.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        )}

        <fieldset className={styles.fieldset} aria-describedby={attempted && formatError ? formatErrorId : undefined}>
          <legend className={styles.legend}>Formats</legend>
          <div className={styles.checkRow}>
            {REPORT_FORMATS.map((format) => (
              <label key={format} className={styles.checkOption}>
                <input
                  type="checkbox"
                  checked={formats[format]}
                  onChange={(e) => setFormats((prev) => ({ ...prev, [format]: e.target.checked }))}
                />
                {REPORT_FORMAT_LABELS[format]}
              </label>
            ))}
          </div>
          {attempted && formatError ? (
            <p id={formatErrorId} className={styles.inlineError} role="alert" data-testid="report-format-error">
              {formatError}
            </p>
          ) : null}
        </fieldset>

        <label className={styles.checkOption}>
          <input type="checkbox" checked={emailMe} onChange={(e) => setEmailMe(e.target.checked)} />
          Email me when it’s ready
        </label>

        {submitError ? (
          <p id={submitErrorId} className={styles.inlineError} role="alert" data-testid="report-submit-error">
            {submitError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export default ExportReportDialog;
