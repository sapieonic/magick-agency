import { useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import { useRosterIngest } from '../../hooks/useRosterIngest';
import { hasPermission } from '../../utils/permissions';
import { mappingBlockReason } from '../../utils/agencyColumnMapping';
import { ColumnMapper } from '../campaigns/agency/ColumnMapper';
import { IngestSummary, ReviewNextSteps } from '../campaigns/agency/IngestSummary';
import { SheetNotice } from '../campaigns/agency/SheetNotice';
import { CUSTOMER_FILE_ACCEPT, CUSTOMER_FILE_LABEL, uploadingLine } from '../../utils/agencyCustomerFile';
import { useCustomerFileDrop } from '../../hooks/useCustomerFileDrop';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { CampaignWorkspace, type CampaignWorkspaceSection } from './campaign-detail/CampaignWorkspace';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import type { AgencyCampaign } from '../../types/agency-campaign';
import spine from '../../components/agency/SpineListLayout.module.css';
import styles from './AgencyCampaignContactsPage.module.css';

/**
 * Add more contacts to an existing campaign.
 *
 * The server's ingest already supports this — `campaign_id` on the ingest request
 * targets any campaign, and only a dry run may omit it. Nothing surfaced it, so
 * a roster could be loaded exactly once, at creation. A campaign that exhausted
 * its list had to be recreated, which loses its history and its stats.
 *
 * The flow itself is `useRosterIngest`, the same hook the builder runs, so
 * column mapping, the polling contract and the rejected-rows export cannot
 * drift between the two entry points.
 *
 * ── It moved from `…/contacts` to `…/contacts/add` ───────────────
 * This page used to BE `/agency/campaigns/:id/contacts`, which meant the one
 * URL in the product that named the contacts was the one place you could not
 * see them — its own heading read "Add contacts". That path now serves the
 * roster and this is an explicit action reached from it.
 *
 * The component itself is deliberately unchanged beyond its breadcrumb: the
 * ingest flow, its column mapping and its rejected-rows export cannot have
 * drifted in a move that touched neither.
 *
 * It sits in the campaign's workspace, like every campaign screen, under the
 * Contacts tab: the header (name, status, lifecycle), the health strip and the bar.
 */
export function AgencyCampaignContactsPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return (
    <CampaignWorkspace campaignId={id} active="contacts">
      {(campaign, workspace) => <AddContactsSection id={id} campaign={campaign} workspace={workspace} />}
    </CampaignWorkspace>
  );
}

/**
 * The upload itself, on the workspace's campaign: the form is decided by its status (a finished
 * campaign is refused, a running one warned about), so it waits for the workspace's first read
 * (a failed one is said above, with Retry), and the ingest's start re-reads the campaign and
 * writes it into the workspace (`commitCampaign`), so the form and the header repaint together
 * as closed if it ended meanwhile. No read of its own: the header's is the only one.
 */
function AddContactsSection({
  id,
  campaign,
  workspace,
}: {
  id: string;
  campaign: AgencyCampaign | null;
  workspace: CampaignWorkspaceSection;
}) {
  const { tenantId, accountId, role } = useTenant();
  const { loading, commitCampaign } = workspace;
  // "Campaigns / <name> / Contacts / Add contacts": back to the roster, where this page is
  // reached from and where an operator who has finished uploading looks at what landed.
  useCampaignCrumbs(id, campaign, 'contacts', [{ label: 'Add contacts' }]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canAdd = hasPermission(role, 'agency.campaigns.write');

  const {
    limits,
    phase,
    setPhase,
    running,
    finished,
    reviewing,
    retryable,
    checkJob,
    importing,
    importChecked,
    uploadingWorkbook,
    upload,
    analysis,
    mapping,
    setMapping,
    job,
    error,
    downloading,
    downloadError,
    onPickFile,
    startIngest,
    onCancelIngest,
    onDownloadRejected,
    onDownloadSkipped,
    reset,
  } = useRosterIngest(tenantId ?? undefined, accountId ?? undefined, {
    source: 'top_up',
    // A check compares the file with this campaign's roster and its Do Not Call list.
    peekCampaignId: useCallback(() => id, [id]),
    /**
     * Already known — no draft to create, unlike the builder. But re-read the
     * campaign first.
     *
     * The refusal below is decided from the status fetched when the page
     * loaded, and a supervisor can stop the campaign from another tab, or the
     * pacing leader can finalize it to `completed`, while this page sits open on
     * a mapping screen. The server accepts the ingest either way and the rows land
     * somewhere that will never dial them — which looks exactly like a
     * successful import.
     *
     * This narrows the window, it does not close it: the check and the ingest
     * are still two requests, and only a terminal-status guard inside the server's
     * ingest route would make the refusal atomic. That belongs in the server and is
     * filed rather than faked here — throwing from this callback is caught by
     * the hook and surfaces as a failed start, which is the honest outcome.
     */
    resolveCampaignId: useCallback(async () => {
      if (!id || !tenantId || !accountId) return id;
      // A failed read throws: the start fails rather than trusting the status from page load.
      const fresh = await getAgencyCampaign(id, tenantId, accountId);
      commitCampaign(fresh);
      if (fresh.status === 'stopped' || fresh.status === 'completed') {
        throw new Error(
          `This campaign is ${fresh.status} — contacts added now would never be dialled. Nothing was imported.`,
        );
      }
      return id;
    }, [id, tenantId, accountId, commitCampaign]),
  });

  // Dropped or picked, one file at a time, as on New campaign's Customers step.
  const { dropzoneProps, onInputChange } = useCustomerFileDrop(canAdd && phase === 'idle', onPickFile);

  if (loading) return <LoadingSpinner />;
  // The workspace says why above, with Retry.
  if (!campaign) return null;

  const mappingBlock = mapping ? mappingBlockReason(mapping) : null;
  const isLive = campaign.status === 'running';

  return (
    <div className={styles.page}>

      <header className={spine.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true"><Upload size={20} /></span>
          <h2 className={spine.title}>Add contacts</h2>
        </div>
      </header>

      {isLive && (
        <p className={styles.liveNote}>
          This campaign is dialling. New contacts join the queue as they load, so agents may start
          receiving them before the import finishes.
        </p>
      )}

      {/*
        Not offered on a campaign that can never dial again. The server would accept
        the ingest and the rows would sit unreachable forever, which looks like
        a successful import and is not one.
      */}
      {campaign.status === 'stopped' || campaign.status === 'completed' ? (
        <p className={styles.closedNote}>
          This campaign has finished, so contacts added now would never be dialled. Create a new
          campaign for the remaining list.
        </p>
      ) : (
        <>
          {error && <ErrorAlert message={error} />}

          {phase === 'idle' || phase === 'uploading' || phase === 'analyzing' ? (
            <div className={styles.dropzone} data-testid="contacts-dropzone" {...dropzoneProps}>
              <p className={styles.dropzoneCopy}>
                Drop an Excel or CSV file here, or choose one. Any columns you like — you pick the
                phone column next.
              </p>
              {limits && (
                <p className={styles.limits}>
                  Up to {limits.max_rows.toLocaleString()} rows and{' '}
                  {Math.floor(limits.max_file_bytes / (1024 * 1024)).toLocaleString()} MB per file.
                </p>
              )}
              {/* Hidden behind a button, as in the builder's contacts step: the browser's own
                  control ("Choose File · No file chosen") read as unstyled, in US English. */}
              <input
                ref={fileInputRef}
                type="file"
                accept={CUSTOMER_FILE_ACCEPT}
                aria-label={CUSTOMER_FILE_LABEL}
                className={styles.fileInput}
                disabled={!canAdd || phase !== 'idle'}
                onChange={onInputChange}
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={!canAdd || phase !== 'idle'}
                onClick={() => fileInputRef.current?.click()}
              >
                Choose a file
              </button>
              {phase === 'uploading' && <p className={styles.progressLine} role="status">{uploadingLine(uploadingWorkbook)}</p>}
              {phase === 'analyzing' && <p className={styles.progressLine}>Reading the columns…</p>}
            </div>
          ) : upload?.sheet ? (
            // An Excel upload: which sheet was read, and any that were not (CS7). Kept through
            // the check and the import, until the file is replaced.
            <SheetNotice
              upload={upload}
              className={styles.sheetNotice}
              readClassName={styles.limits}
              othersClassName={styles.sheetOthers}
            />
          ) : null}

          {analysis && mapping && (phase === 'mapping' || phase === 'ingesting') ? (
            <>
              <ColumnMapper
                analysis={analysis}
                state={mapping}
                onChange={setMapping}
                fileName={upload?.file_name ?? ''}
                disabled={phase === 'ingesting'}
              />
              {phase === 'mapping' && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void startIngest(true)}
                    disabled={mappingBlock !== null}
                  >
                    Check the file
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void startIngest(false)}
                    disabled={mappingBlock !== null}
                  >
                    Import without checking
                  </button>
                  {/* The wrong file, or the wrong sheet: back to the picker, as the builder's Replace file. */}
                  <button type="button" className="btn-secondary" onClick={reset}>
                    Choose another file
                  </button>
                </div>
              )}
            </>
          ) : null}

          {running ? (
            <div className={styles.progress}>
              <progress
                max={100}
                {...(job && job.progress_pct !== null ? { value: job.progress_pct } : {})}
                aria-label="Import progress"
              />
              <p className={styles.progressLine}>
                {job
                  ? `${job.rows_read.toLocaleString()} rows read${
                      job.progress_pct !== null ? ` — ${job.progress_pct}%` : ''
                    }`
                  : 'Starting…'}
              </p>
              <button type="button" className="btn-secondary" onClick={() => void onCancelIngest()}>
                {job?.dry_run ? 'Stop the check' : 'Stop the import'}
              </button>
            </div>
          ) : null}

          {finished && job ? (
            <>
              {job.dry_run ? (
                <p className={styles.checkNote} data-testid="dry-run-note">
                  This was a check: nothing has been imported yet.
                </p>
              ) : null}
              <IngestSummary
                job={job}
                checkJob={checkJob}
                onBackToMapping={() => setPhase('mapping')}
                onDownloadRejected={() => void onDownloadRejected()}
                onDownloadSkipped={() => void onDownloadSkipped()}
                downloading={downloading}
                downloadError={downloadError}
              >
                {reviewing ? (
                  <ReviewNextSteps
                    check={job}
                    importing={importing}
                    onImport={() => void importChecked()}
                    onChangeMapping={() => setPhase('mapping')}
                    onUploadCorrected={reset}
                  />
                ) : retryable && checkJob ? (
                  // The import of a checked file failed or was stopped, and the check is
                  // still valid: import it again, or start over with a corrected file.
                  <ReviewNextSteps
                    check={checkJob}
                    retry
                    importing={importing}
                    onImport={() => void importChecked()}
                    onUploadCorrected={reset}
                  />
                ) : (
                  <div className={styles.actions}>
                    <button type="button" className="btn-secondary" onClick={reset}>
                      {job.dry_run ? 'Upload a corrected file' : 'Add another file'}
                    </button>
                  </div>
                )}
              </IngestSummary>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

export default AgencyCampaignContactsPage;
