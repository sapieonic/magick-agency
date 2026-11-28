import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import type { AgencyCallExportFieldsResponse } from '@magick-agency/contracts/api/agency/call-export-fields';
import { getCallExportFields } from '../../../api/agencySpine';
import { formatCount } from '../../../utils/format/number';
import {
  CALL_EXPORT_ALWAYS_NOTE,
  CALL_EXPORT_ANALYSIS_OFF_NOTE,
  CALL_EXPORT_BASE_COLUMNS_PREVIEW,
  CALL_EXPORT_NOTHING_CHOSEN_HINT,
  callExportCeilingNote,
  callExportFieldsRefusal,
  callExportGroups,
  callExportSubtitle,
  orderedChosenFields,
  rememberedFieldsToStore,
  rememberedStillOffered,
  type CallExportGroup,
  type CallLogExportQuery,
} from '../../../utils/agency/callExportFields';
import { readRememberedFields, writeRememberedFields } from '../../../utils/agency/callExportFieldsStore';
import styles from './ExportFieldsDialog.module.css';

export interface ExportFieldsDialogProps {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  /** The export's query (`callLogExportQuery`): the field list is read for exactly these calls. */
  query: CallLogExportQuery;
  /** The dates and the chip in words, for the subtitle. */
  dates: string;
  type: string;
  /** Where the choice is remembered (`callExportFieldsKey`), or null when it cannot be (no user yet). */
  storageKey: string | null;
  tenantId?: string;
  accountId?: string;
  /** Download the file with these fields, in this order. Rejects with the server's refusal. */
  onDownload: (fields: string[]) => Promise<void>;
}

/**
 * Export with fields (`docs/call-log.md` §10, CL43–CL52): what can be added to the campaign call
 * export for the calls the Call log shows, read when the dialog opens, in four groups (what the
 * file always has, the agent's call details, the call analysis, the custom dimensions), with the
 * file's columns previewed in the order they will be written, the lower ceiling AI fields bring
 * (CL48) and the choice remembered per person (CL50).
 *
 * Unmounted while closed, so every opening reads the list again for the view as it is then.
 */
export function ExportFieldsDialog(props: ExportFieldsDialogProps) {
  if (!props.open) return null;
  return <OpenExportFieldsDialog {...props} />;
}

function OpenExportFieldsDialog({
  onClose, campaignId, query, dates, type, storageKey, tenantId, accountId, onDownload,
}: ExportFieldsDialogProps) {
  const ids = useId();
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [remember, setRemember] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // `query` is the page's memoised value, so the list is read once per opening; Retry reloads.
  const fetchFields = useCallback(
    () => getCallExportFields(campaignId, query, tenantId, accountId),
    [campaignId, query, tenantId, accountId],
  );
  const fields = useAsyncResource<AgencyCallExportFieldsResponse | null>(fetchFields, {
    initialData: null,
    errorMessage: 'Could not read the fields for these calls.',
  });
  const response = fields.loading ? null : fields.data;
  const groups = useMemo(() => (response ? callExportGroups(response) : null), [response]);

  // The remembered fields this view offers are ticked; the rest are kept for a later view that
  // offers them (CL50, `rememberedFieldsToStore`).
  useEffect(() => {
    if (groups) setChosen(rememberedStillOffered(readRememberedFields(storageKey), groups));
  }, [groups, storageKey]);

  const ordered = useMemo(() => (groups ? orderedChosenFields(groups, chosen) : []), [groups, chosen]);
  const ceiling = response ? callExportCeilingNote(ordered, response) : null;

  const toggle = useCallback((name: string, on: boolean) => {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((group: CallExportGroup, on: boolean) => {
    setChosen((current) => {
      const next = new Set(current);
      for (const option of group.options) {
        if (on) next.add(option.name);
        else next.delete(option.name);
      }
      return next;
    });
  }, []);

  const download = async () => {
    if (!groups || ordered.length === 0) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await onDownload(ordered);
      // Saved on Download only; unticking Remember and downloading forgets the choice. A
      // remembered field this view did not offer is kept, so a later view can tick it again.
      writeRememberedFields(
        storageKey,
        remember ? rememberedFieldsToStore(ordered, readRememberedFields(storageKey), groups) : null,
      );
      onClose();
    } catch (err: unknown) {
      setDownloadError(callExportFieldsRefusal(err) ?? getErrorMessage(err, 'Could not export these calls.'));
      setDownloading(false);
    }
  };

  // While the file is being prepared nothing closes the dialog: not Escape, the close button,
  // Cancel or the overlay. The Modal calls this on each of them.
  const closeUnlessDownloading = () => {
    if (!downloading) onClose();
  };
  const nothingChosen = groups !== null && ordered.length === 0;

  const subtitle = callExportSubtitle(response ? response.calls : null, dates, type);
  const analysisOff = response !== null && !response.analysis_available;

  return (
    <Modal
      open
      onClose={closeUnlessDownloading}
      title="Export with fields"
      subtitle={subtitle}
      size="md"
      closeOnOverlayClick={!downloading}
      footer={
        <div className={styles.footerActions}>
          <div className={styles.footerButtons}>
            <button type="button" className="btn-secondary" onClick={closeUnlessDownloading} disabled={downloading}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void download()}
              disabled={!groups || downloading || nothingChosen}
              aria-describedby={nothingChosen ? `${ids}-nothing` : undefined}
              data-testid="export-fields-download"
            >
              {downloading ? 'Preparing…' : 'Download CSV'}
            </button>
          </div>
          {nothingChosen && (
            <p className={styles.footerHint} id={`${ids}-nothing`} data-testid="export-fields-nothing-chosen">
              {CALL_EXPORT_NOTHING_CHOSEN_HINT}
            </p>
          )}
        </div>
      }
    >
      <div className={styles.body}>
        <p className={styles.intro}>The file keeps its usual columns; what you tick here is added at the end.</p>

        {fields.loading && (
          <div className={styles.loading} data-testid="export-fields-loading">
            <LoadingSpinner size="sm" />
          </div>
        )}

        {!fields.loading && fields.error && (
          <div data-testid="export-fields-error">
            <ErrorAlert message={fields.error} onRetry={() => void fields.reload()} />
          </div>
        )}

        {groups && (
          <>
            <section className={styles.group} aria-labelledby={`${ids}-always`}>
              <h3 className={styles.groupTitle} id={`${ids}-always`}>Always in the file</h3>
              <p className={styles.always} data-testid="export-fields-always">{CALL_EXPORT_ALWAYS_NOTE}</p>
            </section>

            {groups.map((group) => {
              const all = group.options.every((option) => chosen.has(option.name));
              const titleId = `${ids}-${group.id}`;
              return (
                <section key={group.id} className={styles.group} aria-labelledby={titleId} data-testid={`export-fields-group-${group.id}`}>
                  <div className={styles.groupHead}>
                    <div>
                      <h3 className={styles.groupTitle} id={titleId}>{group.title}</h3>
                      {group.hint && <p className={styles.groupHint}>{group.hint}</p>}
                    </div>
                    <button
                      type="button"
                      className={styles.groupToggle}
                      onClick={() => toggleGroup(group, !all)}
                      aria-label={`${all ? 'Clear' : 'Select all'}: ${group.title}`}
                    >
                      {all ? 'Clear' : 'Select all'}
                    </button>
                  </div>
                  <ul className={styles.options}>
                    {group.options.map((option) => {
                      const id = `${ids}-${option.name}`;
                      return (
                        <li key={option.name} className={styles.option} title={option.description ?? undefined}>
                          <input
                            type="checkbox"
                            id={id}
                            checked={chosen.has(option.name)}
                            onChange={(e) => toggle(option.name, e.target.checked)}
                            aria-labelledby={`${id}-name`}
                            aria-describedby={`${id}-detail ${id}-count`}
                            data-field={option.name}
                          />
                          <label htmlFor={id} className={styles.optionText}>
                            <span className={styles.optionName}>
                              <span id={`${id}-name`}>{option.label}</span>
                              {option.badge && (
                                <span className={styles.badge} data-testid={`export-fields-badge-${option.name}`}>{option.badge}</span>
                              )}
                            </span>
                            <span className={styles.optionDetail} id={`${id}-detail`}>{option.detail ?? ''}</span>
                          </label>
                          <span className={styles.count} id={`${id}-count`} title="Calls with a value" data-testid={`export-fields-count-${option.name}`}>
                            {formatCount(option.calls)}
                            <span className="sr-only"> calls with a value</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}

            {analysisOff && (
              <p className={styles.note} data-testid="export-fields-analysis-off">{CALL_EXPORT_ANALYSIS_OFF_NOTE}</p>
            )}
            {groups.length === 0 && !analysisOff && (
              <p className={styles.note} data-testid="export-fields-empty">
                These calls have nothing to add yet: no call analysis and no call details.
              </p>
            )}

            <section className={styles.group} aria-labelledby={`${ids}-preview`}>
              <h3 className={styles.groupTitle} id={`${ids}-preview`}>Columns in the file</h3>
              <p className={styles.preview} data-testid="export-fields-preview">
                <span>{CALL_EXPORT_BASE_COLUMNS_PREVIEW}</span>
                {ordered.map((name) => (
                  <span key={name}>
                    {', '}
                    <mark className={styles.chosenColumn} data-testid="export-fields-preview-chosen">{name}</mark>
                  </span>
                ))}
              </p>
              {ceiling && (
                <p className={styles.ceiling} data-testid="export-fields-ceiling">
                  {ceiling.limit}
                  {ceiling.overLimit && <> <span data-testid="export-fields-over-limit">{ceiling.overLimit}</span></>}
                </p>
              )}
            </section>

            <label className={styles.remember}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                data-testid="export-fields-remember"
              />
              Remember these fields for this campaign
            </label>
          </>
        )}

        {downloadError && (
          <p className={styles.downloadError} role="alert" data-testid="export-fields-download-error">{downloadError}</p>
        )}
      </div>
    </Modal>
  );
}
