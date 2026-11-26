import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { FileText, Upload } from 'lucide-react';
import {
  AdvancedFold,
  SetupCard,
  SetupSection,
  StatusChip,
  StatusChipRow,
  Switch,
} from '../../../../components/campaign-setup';
import { ColumnMapper } from '../ColumnMapper';
import { SheetNotice } from '../SheetNotice';
import { IngestSummary } from '../IngestSummary';
import type { UploadPhase, useRosterIngest } from '../../../../hooks/useRosterIngest';
import { MAPPING_BLOCK_COPY, mappingBlockReason } from '../../../../utils/agencyColumnMapping';
import { buildIngestSummary, checkComparison } from '../../../../utils/agencyIngestSummary';
import { formatSpineTimestamp } from '../../../../utils/agencySpineCopy';
import { CUSTOMER_FILE_ACCEPT, CUSTOMER_FILE_LABEL, uploadingLine } from '../../../../utils/agencyCustomerFile';
import { useCustomerFileDrop } from '../../../../hooks/useCustomerFileDrop';
import { formatCount } from '../../../../utils/format/number';
import {
  fileRowLine,
  ingestChips,
  phoneColumnIsSure,
  shouldAutoCheck,
  type IngestChip,
} from '../../../../utils/campaignSetup/ingestChips';
import {
  CARD_FULL_REASON,
  cardColumns,
  cardIsFull,
  cardSummaryLine,
  previewCell,
  sampleRows,
  toggleCardColumn,
} from '../../../../utils/campaignSetup/cardColumns';
import styles from './CustomersStep.module.css';

/** What the step reads from `useRosterIngest`: pass the hook's return object as it is. */
export type CustomersIngest = Pick<
  ReturnType<typeof useRosterIngest>,
  | 'limits'
  | 'phase'
  | 'setPhase'
  | 'running'
  | 'finished'
  | 'reviewing'
  | 'retryable'
  | 'checkJob'
  | 'importing'
  | 'uploadingWorkbook'
  | 'upload'
  | 'analysis'
  | 'mapping'
  | 'setMapping'
  | 'job'
  | 'error'
  | 'downloading'
  | 'downloadError'
  | 'startIngest'
  | 'onCancelIngest'
  | 'onDownloadRejected'
  | 'onDownloadSkipped'
  | 'reset'
>;

export interface CustomersStepProps {
  ingest: CustomersIngest;
  /** Whether the campaign has its name and a number: an import needs the draft, a check does not. */
  basicsReady: boolean;
  /** Why the checked file cannot be added yet ("Name the campaign first."), or null. */
  blockReason: string | null;
  /**
   * Take a file. The step ignores a second file while one is being taken (its own lock, and
   * the phase); the page may hold its own lock too.
   */
  onPickFile: (file: File) => Promise<void> | void;
  /**
   * Show the card switches (CS9). New campaign only: a list added to an existing campaign leaves
   * the card to its Settings.
   */
  cardChoice?: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
}

const UPLOAD_PHASES: readonly UploadPhase[] = ['idle', 'uploading', 'analyzing'];

/**
 * Step 2 of the campaign setup, "Customers" (CS6–CS9): upload an Excel or CSV file (CS7), which
 * is checked straight away when the phone column is sure (CS8; otherwise the column mapper asks),
 * then the check's counts as chips, and the columns agents see as switches over sample rows. The
 * footer's primary action (Add 1,240 customers, Continue, Skip for now) is the page's, from
 * `customersContinue`.
 *
 * Controlled: every piece of state is the roster ingest's (`useRosterIngest`), except the drag
 * feedback and the note that the step started the check itself.
 */
export function CustomersStep({
  ingest,
  basicsReady,
  blockReason,
  onPickFile,
  cardChoice = true,
  headingRef,
}: CustomersStepProps) {
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
    uploadingWorkbook,
    upload,
    analysis,
    mapping,
    setMapping,
    job,
    error,
    downloading,
    downloadError,
    startIngest,
    onCancelIngest,
    onDownloadRejected,
    onDownloadSkipped,
    reset,
  } = ingest;

  const fileInputRef = useRef<HTMLInputElement>(null);
  // One file at a time, while idle; the picker cleared after each pick (shared with Add contacts).
  const { dropzoneProps, onInputChange } = useCustomerFileDrop(phase === 'idle', onPickFile);

  /*
    CS8: a fresh analysis that is sure of the phone column starts the check here. Until the check
    job exists the phase is still `mapping`; `autoCheckFor` keeps the mapper from flashing up in
    that gap. A refused start (the hook's `error`) shows the mapper, the way to go on by hand.
  */
  const previousPhase = useRef<UploadPhase | null>(null);
  const [autoCheckFor, setAutoCheckFor] = useState<string | null>(null);
  useEffect(() => {
    const previous = previousPhase.current;
    previousPhase.current = phase;
    if (phase !== 'mapping') {
      setAutoCheckFor(null);
      return;
    }
    if (upload && shouldAutoCheck(previous, phase, analysis, mapping)) {
      setAutoCheckFor(upload.s3_key);
      void startIngest(true);
    }
  }, [phase, analysis, mapping, upload, startIngest]);
  const autoPending = phase === 'mapping' && upload !== null && autoCheckFor === upload.s3_key && error === null;

  const importedDone = finished && job !== null && !job.dry_run && job.status === 'completed';
  const canChangeColumns = finished && job !== null && !importedDone && !importing && analysis !== null;
  const changeColumns = () => setPhase('mapping');
  const changeColumnsButton = canChangeColumns ? (
    <button type="button" className="btn-secondary" onClick={changeColumns} data-testid="change-columns">
      Change columns
    </button>
  ) : null;

  const showDropzone = UPLOAD_PHASES.includes(phase);
  const showFileRow = !showDropzone && upload !== null;
  const showMapper = phase === 'mapping' && !autoPending && analysis !== null && mapping !== null;
  const block = mapping ? mappingBlockReason(mapping) : null;

  return (
    <SetupCard
      title="Customers"
      helper="Upload an Excel or CSV file. We check it for you."
      headingRef={headingRef}
      testId="customers-step"
    >
      {showDropzone ? (
        <div
          className={styles.dropzone}
          data-testid="contacts-dropzone"
          {...dropzoneProps}
        >
          <span className={styles.dropIcon} aria-hidden="true">
            <Upload size={22} />
          </span>
          <p className={styles.dropCopy}>
            Drop an Excel or CSV file here, or choose one. We find the phone number column for you.
          </p>
          {limits ? (
            <p className={styles.muted} data-testid="ingest-limits">
              Up to {formatCount(limits.max_rows)} rows and{' '}
              {formatCount(Math.floor(limits.max_file_bytes / (1024 * 1024)))} MB per file.
            </p>
          ) : null}
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept={CUSTOMER_FILE_ACCEPT}
            aria-label={CUSTOMER_FILE_LABEL}
            disabled={phase !== 'idle'}
            onChange={onInputChange}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={phase !== 'idle'}
            onClick={() => fileInputRef.current?.click()}
          >
            Choose a file
          </button>
          {phase === 'uploading' ? <p className={styles.busy} role="status">{uploadingLine(uploadingWorkbook)}</p> : null}
          {phase === 'analyzing' ? <p className={styles.busy} role="status">Reading the columns…</p> : null}
        </div>
      ) : null}

      {showFileRow && upload ? (
        <div className={styles.fileRow} data-testid="file-row">
          <span className={styles.fileIcon} aria-hidden="true">
            <FileText size={20} />
          </span>
          <div className={styles.fileText}>
            <strong className={styles.fileName}>{upload.file_name}</strong>
            <span className={styles.muted}>
              {fileRowLine(upload, analysis, finished ? job : null)}
            </span>
            <SheetNotice
              upload={upload}
              className={styles.sheetNotice}
              readClassName={styles.muted}
              othersClassName={styles.note}
            />
          </div>
          {!importedDone ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={reset}
              disabled={running || importing || autoPending}
            >
              Replace file
            </button>
          ) : null}
        </div>
      ) : null}

      {showMapper && analysis && mapping ? (
        <div className={styles.mapper} data-testid="customers-mapper">
          {!phoneColumnIsSure(analysis) && !analysis.phone_column_ambiguous ? (
            <p className={styles.note} role="status">
              We could not tell which column holds the phone number. Pick it below, then check the file.
            </p>
          ) : null}
          <ColumnMapper
            analysis={analysis}
            state={mapping}
            onChange={setMapping}
            fileName={upload?.file_name ?? ''}
            cardChoice={cardChoice}
          />
          <div className={styles.actions}>
            <button
              type="button"
              className="btn-primary"
              disabled={block !== null}
              onClick={() => void startIngest(true)}
            >
              Check the file
            </button>
            {block ? <span className={styles.muted}>{MAPPING_BLOCK_COPY[block]}</span> : null}
          </div>
        </div>
      ) : null}

      {running || autoPending ? (
        <div className={styles.progress} data-testid="ingest-progress" role="status">
          <p className={styles.progressTitle}>
            {autoPending || job?.dry_run ? 'Checking the file…' : job ? 'Adding customers…' : 'Starting…'}
          </p>
          <progress
            max={100}
            {...(job && job.progress_pct !== null ? { value: job.progress_pct } : {})}
            aria-label={job && !job.dry_run ? 'Import progress' : 'Check progress'}
          />
          {job ? (
            <p className={styles.progressLine}>
              {`${formatCount(job.rows_read)} rows read${job.progress_pct !== null ? ` · ${job.progress_pct}%` : ''}`}
            </p>
          ) : null}
          {running ? (
            <button type="button" className="btn-secondary" onClick={() => void onCancelIngest()}>
              {job?.dry_run ? 'Stop the check' : 'Stop the import'}
            </button>
          ) : null}
        </div>
      ) : null}

      {finished && job ? (
        job.status === 'completed' ? (
          <CompletedJob
            ingest={ingest}
            basicsReady={basicsReady}
            blockReason={blockReason}
            changeColumnsButton={changeColumnsButton}
            onChangeColumns={canChangeColumns ? changeColumns : undefined}
            cardChoice={cardChoice}
          />
        ) : (
          <>
            {job.dry_run ? (
              <p className={styles.note} data-testid="dry-run-note">
                Nothing was added. This was a check of the file.
              </p>
            ) : null}
            <IngestSummary
              job={job}
              checkJob={checkJob}
              onBackToMapping={canChangeColumns ? changeColumns : undefined}
              onDownloadRejected={() => void onDownloadRejected()}
              onDownloadSkipped={() => void onDownloadSkipped()}
              downloading={downloading}
              downloadError={downloadError}
            >
              {retryable && checkJob ? (
                <p className={styles.note} data-testid="ingest-retry-note">
                  The import did not finish. Adding again reads the same checked file with the same
                  columns; any rows that did land are skipped, never added twice.
                </p>
              ) : (
                <div className={styles.actions} data-testid="ingest-recovery">
                  <button type="button" className="btn-secondary" onClick={reset}>
                    Upload a corrected file
                  </button>
                  {changeColumnsButton}
                </div>
              )}
            </IngestSummary>
            {cardChoice && retryable ? <CardPicker ingest={ingest} editable /> : null}
          </>
        )
      ) : null}
    </SetupCard>
  );
}

/** A completed check or import: the chips, what to do next, the card switches and the details. */
function CompletedJob({
  ingest,
  basicsReady,
  blockReason,
  changeColumnsButton,
  onChangeColumns,
  cardChoice,
}: {
  ingest: CustomersIngest;
  basicsReady: boolean;
  blockReason: string | null;
  changeColumnsButton: ReactNode;
  onChangeColumns: (() => void) | undefined;
  cardChoice: boolean;
}) {
  const { job, checkJob, reviewing, downloading, downloadError, onDownloadRejected, onDownloadSkipped } = ingest;
  if (!job) return null;
  const chips = ingestChips(job);
  const summary = buildIngestSummary(job);
  const comparison = !job.dry_run && checkJob ? checkComparison(checkJob, job) : null;

  const chipAction = (chip: IngestChip) => {
    if (chip.download === null) return undefined;
    const rejected = chip.download === 'rejected';
    return (
      <button
        type="button"
        onClick={() => void (rejected ? onDownloadRejected() : onDownloadSkipped())}
        disabled={downloading}
        aria-label={rejected ? 'Download the rejected rows' : 'Download the skipped rows'}
      >
        {downloading ? 'Preparing…' : 'Download'}
      </button>
    );
  };

  return (
    <>
      {summary.highRejectionWarning ? (
        <div className={styles.warning} role="alert" data-testid="high-rejection">
          <p className={styles.warningText}>{summary.highRejectionWarning}</p>
          {onChangeColumns ? (
            <button type="button" className="btn-secondary" onClick={onChangeColumns}>
              Check the columns
            </button>
          ) : null}
        </div>
      ) : null}

      <StatusChipRow live testId="ingest-chips">
        {chips.map((chip) => (
          <StatusChip key={chip.key} tone={chip.tone} action={chipAction(chip)} testId={`chip-${chip.key}`}>
            {chip.text}
          </StatusChip>
        ))}
      </StatusChipRow>
      {downloadError ? <p className="error-text">{downloadError}</p> : null}

      {job.dry_run ? (
        <p className={styles.note} data-testid="dry-run-note">
          {reviewing && job.accepted > 0
            ? 'Nothing is added yet: this was a check. Continue adds the ready customers.'
            : 'Nothing was added. This was a check of the file.'}
        </p>
      ) : null}
      {reviewing && job.accepted > 0 && !basicsReady && blockReason ? (
        <p className={styles.blockReason} data-testid="customers-block">
          {blockReason}
        </p>
      ) : null}
      {reviewing && job.check_expires_at ? (
        <p className={styles.muted} data-testid="check-expires">
          You can add these customers until {formatSpineTimestamp(job.check_expires_at)}. After that, the
          file is checked again.
        </p>
      ) : null}
      {comparison ? (
        <p className={styles.note} role="status" data-testid="check-comparison">
          {comparison}
        </p>
      ) : null}

      {/* The card is picked while a checked file waits to be added, and shown as saved after. */}
      {cardChoice && ((reviewing && job.accepted > 0) || !job.dry_run) ? (
        <CardPicker
          ingest={ingest}
          editable={reviewing}
          actions={changeColumnsButton}
          lockedNote={job.dry_run ? null : 'The card was saved with the customers. Change it in the campaign’s Settings.'}
        />
      ) : null}

      <AdvancedFold summary="Details" testId="ingest-details">
        <IngestSummary
          job={job}
          checkJob={checkJob}
          onBackToMapping={onChangeColumns}
          onDownloadRejected={() => void onDownloadRejected()}
          onDownloadSkipped={() => void onDownloadSkipped()}
          downloading={downloading}
          downloadError={null}
        />
      </AdvancedFold>
    </>
  );
}

/**
 * "Tick what goes on the customer card" (CS9): the sample rows with a switch on each
 * column. The rules are `utils/campaignSetup/cardColumns.ts`; this is assembly.
 */
function CardPicker({
  ingest,
  editable,
  actions,
  lockedNote = null,
}: {
  ingest: CustomersIngest;
  editable: boolean;
  actions?: ReactNode;
  /** Said under the table while the switches cannot be changed. */
  lockedNote?: string | null;
}) {
  const uid = useId();
  const { analysis, mapping, setMapping } = ingest;
  if (!analysis || !mapping) return null;
  const columns = cardColumns(analysis, mapping);
  const rows = sampleRows(analysis);
  const full = cardIsFull(mapping);
  const fullId = `${uid}-full`;
  const hintId = `${uid}-hint`;

  return (
    <SetupSection
      title="Tick what goes on the customer card"
      helper={cardSummaryLine(mapping)}
      actions={actions}
      testId="card-columns"
    >
      {editable && full ? (
        <p className={styles.muted} id={fullId} role="status" data-testid="card-full">
          {CARD_FULL_REASON}
        </p>
      ) : null}
      <div className={styles.tableWrap} role="region" aria-label="Sample rows" tabIndex={0}>
        <table className={styles.preview} aria-describedby={hintId}>
          <caption className="sr-only">The first values in each column of the file</caption>
          <thead>
            <tr>
              {columns.map((column, index) => {
                const reasonId = `${uid}-reason-${index}`;
                const fullReason = editable && column.lockedReason !== null && column.kind === 'fact';
                return (
                  <th key={column.name} scope="col" data-kind={column.kind} data-on={column.on || undefined}>
                    <div className={styles.head}>
                      <span className={styles.headName}>{column.name}</span>
                      <Switch
                        checked={column.on}
                        disabled={!editable || column.locked}
                        ariaLabel={`Put ${column.name} on the card`}
                        describedBy={fullReason ? fullId : column.lockedReason ? reasonId : undefined}
                        testId={`card-switch-${index}`}
                        onChange={(next) => setMapping(toggleCardColumn(mapping, column.name, next))}
                      />
                    </div>
                    {column.factNumber !== null ? (
                      <span className={styles.headNote}>Fact {column.factNumber}</span>
                    ) : column.lockedReason && !fullReason ? (
                      <span className={styles.headNote} id={reasonId}>
                        {column.lockedReason}
                      </span>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((value, c) => (
                  // Uploaded file content: rendered as text, always.
                  <td key={columns[c]!.name} data-masked={columns[c]!.masked || undefined}>
                    {previewCell(value, columns[c]!.masked)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.muted} id={hintId}>
        The ticked columns become the customer card on the agent screen. Agents see every other
        column under More details, below the card; you can turn any of them off in the campaign's
        Settings. Phone numbers stay partly hidden from agents unless you change it in step 4.
      </p>
      {!editable && lockedNote ? (
        <p className={styles.muted} data-testid="card-locked">
          {lockedNote}
        </p>
      ) : null}
    </SetupSection>
  );
}
