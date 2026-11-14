import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import { useRosterIngest } from '../../hooks/useRosterIngest';
import { hasPermission } from '../../utils/permissions';
import { mappingBlockReason } from '../../utils/agencyColumnMapping';
import { ColumnMapper } from '../campaigns/agency/ColumnMapper';
import { IngestSummary } from '../campaigns/agency/IngestSummary';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { CampaignWorkspace } from './campaign-detail/CampaignWorkspace';
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
      <AddContactsSection id={id} />
    </CampaignWorkspace>
  );
}

/**
 * The upload itself. It keeps its OWN read of the campaign rather than the workspace's:
 * the form is decided by the campaign's status (a finished campaign is refused, a running
 * one warned about), so it waits for that read and offers Retry when it fails, and the
 * ingest's start re-reads the campaign and repaints this form as closed if it ended
 * meanwhile. The workspace's read answers neither (it hands a failure over as `null`, and
 * this section cannot write into it). One extra read when the page opens, never polled.
 */
function AddContactsSection({ id }: { id: string }) {
  const { tenantId, accountId, role } = useTenant();

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // "Campaigns / <name> / Contacts / Add contacts": back to the roster, where this page is
  // reached from and where an operator who has finished uploading looks at what landed.
  useCampaignCrumbs(id, campaign, 'contacts', [{ label: 'Add contacts' }]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canAdd = hasPermission(role, 'agency.campaigns.write');

  const load = useCallback(async () => {
    if (!id || !tenantId || !accountId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setCampaign(await getAgencyCampaign(id, tenantId, accountId));
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Could not load this campaign.');
    } finally {
      setLoading(false);
    }
  }, [id, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const {
    limits,
    phase,
    setPhase,
    running,
    finished,
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
    reset,
  } = useRosterIngest(tenantId ?? undefined, accountId ?? undefined, {
    source: 'top_up',
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
      const fresh = await getAgencyCampaign(id, tenantId, accountId);
      setCampaign(fresh);
      if (fresh.status === 'stopped' || fresh.status === 'completed') {
        throw new Error(
          `This campaign is ${fresh.status} — contacts added now would never be dialled. Nothing was imported.`,
        );
      }
      return id;
    }, [id, tenantId, accountId]),
  });

  if (loading) return <LoadingSpinner />;
  if (loadError && !campaign) return <ErrorAlert message={loadError} onRetry={() => void load()} />;
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
            <div className={styles.dropzone}>
              <p className={styles.dropzoneCopy}>
                Upload a CSV. Any columns you like — you pick the phone column next.
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
                accept=".csv,text/csv"
                aria-label="CSV file"
                className={styles.fileInput}
                disabled={!canAdd || phase !== 'idle'}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onPickFile(file);
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={!canAdd || phase !== 'idle'}
                onClick={() => fileInputRef.current?.click()}
              >
                Choose a CSV
              </button>
              {phase === 'uploading' && <p className={styles.progressLine}>Uploading…</p>}
              {phase === 'analyzing' && <p className={styles.progressLine}>Reading the columns…</p>}
            </div>
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
                    className="btn-secondary"
                    onClick={() => void startIngest(true)}
                    disabled={mappingBlock !== null}
                  >
                    Check without importing
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void startIngest(false)}
                    disabled={mappingBlock !== null}
                  >
                    Add to campaign
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
                Stop the import
              </button>
            </div>
          ) : null}

          {finished && job ? (
            <>
              <IngestSummary
                job={job}
                onBackToMapping={() => setPhase('mapping')}
                onDownloadRejected={() => void onDownloadRejected()}
                downloading={downloading}
                downloadError={downloadError}
              />
              <div className={styles.actions}>
                <button type="button" className="btn-secondary" onClick={reset}>
                  Add another file
                </button>
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

export default AgencyCampaignContactsPage;
