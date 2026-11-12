import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { useTenant } from '../../../contexts/TenantContext';
import { useGovernance } from '../../../contexts/GovernanceContext';
import { ColumnMapper } from './ColumnMapper';
import { IngestSummary } from './IngestSummary';
import { CampaignBehaviourSection } from './CampaignBehaviourSection';
import { CallerIdPicker } from '../../agency/CallerIdPicker';
import { CampaignCarrierField } from '../../../components/agency/CampaignCarrierField';
import { useAgencyCarriers } from '../../../hooks/useAgencyCarriers';
import { usePhoneNumbers } from '../../../hooks/usePhoneNumbers';
import {
  CarrierRefusalError,
  SERVICE_CARRIER,
  carrierOptions,
  sameCarrier,
  withCarrierRefusalCopy,
  type CarrierChoice,
} from '../../../utils/agencyCarriers';
import { CampaignRecordingField } from '../../../components/agency/CampaignRecordingField';
import {
  AGENCY_RECORDING_CAPABILITY,
  NO_ANALYSIS_PROFILE,
  campaignSaveRefusal,
  recordingPayload,
  type CampaignRecordingState,
} from '../../../utils/agencyCampaignRecording';
import { createAgencyCampaign, updateAgencyCampaign } from '../../../api/agencyCampaigns';
import { buildContextDisplay, mappingBlockReason } from '../../../utils/agencyColumnMapping';
import { useRosterIngest } from '../../../hooks/useRosterIngest';
import { useFeatureFlagEnabled } from '../../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../../utils/inbound/inboundFlag';
import { ASSIGNMENT_MODE_COPY, CONTACT_ASSIGNMENT_FLAG } from '../../../utils/agencyAssignmentCopy';
import {
  trackAgencyCampaignBuilderStepViewed,
  trackAgencyCampaignConfigBlocked,
  trackAgencyCampaignConfigSaved,
} from '../../../analytics/events';
import {
  emptyCampaignConfig,
  buildConfigPayload,
  callingWindowEcho,
  ceilingStateError,
  configBlockReason,
  isBuiltInCode,
  validateConfig,
  CONFIG_BLOCK_COPY,
  fieldErrorsFromResponse,
  type CampaignConfigState,
} from '../../../utils/agencyCampaignConfigForm';
import {
  BUILDER_STEPS,
  basicsBlockReason,
  defaultBuilderCarrier,
  canVisitStep,
  contactsContinueLabel,
  nextStep,
  prevStep,
  stepById,
  stepIndex,
  type BuilderStepId,
} from './builderFlow';
import { BuilderStepper } from './BuilderStepper';
import { BuilderSummary } from './BuilderSummary';
import { ceilingAboveReference, ceilingSummary } from '../../../utils/agency/abandonmentCeiling';
import { changedSettings, samePool, type CampaignSettingsForm } from '../../../utils/campaignSettingsChanges';
import { useUnsavedChangesGuard } from '../../../hooks/useUnsavedChangesGuard';
import { LeaveUnsavedDialog } from '../../../components/agency/UnsavedChangesBar';
import styles from './CampaignBuilderPage.module.css';

/**
 * Guided campaign create (`/agency/campaigns/new`).
 *
 * One decision at a time, with a living summary and a stepper that can jump
 * back. The old page put every section on screen at once so a mapping mistake
 * was recoverable; that recoverability is kept (state lives on the page, the
 * contacts step is re-enterable) without making hours, retries and wrap-up
 * compete for the first look.
 *
 * Upload → map → ingest still lives inside the contacts step as a progression,
 * because you cannot map columns you have not uploaded.
 *
 * Everything the page decides is still delegated to the pure modules —
 * `agencyColumnMapping`, `agencyIngestSummary`, `agencyCampaignConfigForm`,
 * `builderFlow` — so the page is composition.
 *
 * Leaving with input not yet saved asks first, as campaign Settings does
 * (`useUnsavedChangesGuard`): what is typed is compared with what the server has (nothing
 * at first; the name, numbers and carrier once a roster upload creates the draft; the whole
 * form once Save campaign succeeds), and a roster upload still being mapped counts too.
 */

/**
 * What the builder holds that a save sends, as campaign Settings counts it, except that the
 * carrier is `null` while the page's default stands: that default moves as the carriers and
 * numbers load, and is not an edit.
 */
type BuilderForm = Omit<CampaignSettingsForm, 'carrier'> & { carrier: CarrierChoice | null };

/** The builder's recording as a form holds it: on or off, never with an analysis profile. */
const builderRecording = (record: boolean): CampaignRecordingState => ({ record, profileId: NO_ANALYSIS_PROFILE });

export default function CampaignBuilderPage() {
  const { tenantId, accountId } = useTenant();
  // Contact assignment: the Assignment group and outcome overrides, flag-gated.
  // The builder's campaign is always a draft, so the mode is never locked here.
  const assignmentEnabled = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);
  const inboundEnabled = useFeatureFlagEnabled(INBOUND_FLAG);

  const [step, setStep] = useState<BuilderStepId>('basics');
  const [name, setName] = useState('');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [callerIds, setCallerIds] = useState<string[]>([]);
  /**
   * The carrier account the campaign dials on. `null` until the operator picks one: the
   * campaign then takes the first listed that has a number available to this account
   * (`defaultBuilderCarrier`), or the service's own when the list cannot be read.
   */
  const { carriers } = useAgencyCarriers();
  const { phoneNumbers } = usePhoneNumbers();
  const [chosenCarrier, setChosenCarrier] = useState<CarrierChoice | null>(null);
  const carrier: CarrierChoice = chosenCarrier ?? defaultBuilderCarrier(carriers, phoneNumbers);
  const carrierChoices = useMemo(() => carrierOptions(carriers ?? [], null), [carriers]);
  const carrierLabel = carriers?.find((c) => sameCarrier(c, carrier))?.label ?? null;
  /**
   * Recording, set on the behaviour step and saved with the config. The account's
   * `agency.recording` decides whether it can be switched on (UX gating; the API's
   * 403 is the enforcement, and `useGovernance` fails open).
   */
  const [recordCalls, setRecordCalls] = useState(false);
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const recordingEnabled = isCapabilityEnabled(AGENCY_RECORDING_CAPABILITY);

  const [config, setConfig] = useState<CampaignConfigState>(emptyCampaignConfig);
  /**
   * Analytics-only: the disposition order the wizard started with, to detect
   * whether the row arrows moved anything before the one save this page makes.
   */
  const initialDispositionOrderRef = useRef(config.dispositions.map((d) => d.code));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  /** The form as the server has it: empty until a draft is created, then as last saved. */
  const [savedForm, setSavedForm] = useState<BuilderForm>(() => ({
    name: '',
    callerIds: [],
    carrier: null,
    recording: builderRecording(false),
    config,
  }));
  /**
   * The draft's basics as the server has them (null until the draft exists): the name, the
   * caller IDs and the carrier account sent on create, then on each Save campaign. Once the
   * draft exists the save is a PATCH, and it carries any of the three that moved since, or a
   * rename on Basics after a roster upload would never reach the server. A ref, not state:
   * the save reads it straight after `ensureCampaign` may have set it.
   */
  const serverBasicsRef = useRef<{ name: string; callerIds: readonly string[]; carrier: CarrierChoice } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // `phase` is render state, so two drop/change events can both observe
  // `idle` before React commits `uploading`. This immediate lock prevents a
  // second upload in that gap; `phase` remains the user-visible gate.
  const acceptingFileRef = useRef(false);

  /**
   * Steps the operator has actually been on.
   *
   * Half of "is this step complete?" — see {@link completed}. Seeded with the
   * step the wizard opens on, because that one has been reached by definition.
   */
  const [visited, setVisited] = useState<ReadonlySet<BuilderStepId>>(
    () => new Set<BuilderStepId>(['basics']),
  );

  const goTo = useCallback((next: BuilderStepId) => {
    setStep(next);
    setVisited((current) => (current.has(next) ? current : new Set([...current, next])));
    headingRef.current?.focus();
    trackAgencyCampaignBuilderStepViewed({ step: next, step_index: stepIndex(next) });
  }, []);

  /*
    The ceiling rides on the create, not only on the config save's PATCH: a roster
    upload creates the draft before any config save, and a draft that is never
    config-saved would otherwise keep the server's 3% however far the line was
    moved. Sent only when the value passes the field's own check; an emptied box
    (NaN) or an out-of-range value is left out, so the server's default applies
    and the config save that follows is where the field's error is met.
  */
  // `undefined` is dropped from the JSON body, so the server's default applies.
  const ceilingForCreate = ceilingStateError(config) === null ? config.abandonmentCeilingPct : undefined;

  /** Create the campaign on first need, so a draft exists to attach the roster to. */
  const ensureCampaign = useCallback(async (): Promise<string> => {
    if (campaignId) return campaignId;
    let created;
    try {
      created = await createAgencyCampaign(
        {
          name: name.trim(),
          // No `description`: the API stores no such column and its update whitelist
          // does not list it, so sending one wrote nothing. See the note on
          // `AgencyCampaign`.
          // `caller_ids` is rejected when empty. The carrier account is named in full
          // (carrier AND credential, null for the service's own): the caller IDs must
          // be numbers on that account, and the server checks them against it.
          caller_ids: callerIds,
          telephony_provider: carrier.telephony_provider,
          telephony_credential_id: carrier.telephony_credential_id,
          abandonment_ceiling_pct: ceilingForCreate,
        },
        tenantId ?? undefined,
        accountId ?? undefined,
      );
    } catch (err: unknown) {
      // A carrier refusal carries the operator's sentence, so the roster import (which
      // shows `err.message`) and the config save both say it.
      throw withCarrierRefusalCopy(err);
    }
    setCampaignId(created.id);
    serverBasicsRef.current = { name: name.trim(), callerIds: [...callerIds], carrier };
    // The draft has the basics now; the rest is saved by Save campaign.
    setSavedForm((saved) => ({ ...saved, name, callerIds, carrier: chosenCarrier }));
    return created.id;
  }, [campaignId, name, callerIds, carrier, chosenCarrier, ceilingForCreate, tenantId, accountId]);

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
    setError,
    downloading,
    downloadError,
    onPickFile,
    startIngest,
    onCancelIngest,
    onDownloadRejected,
  } = useRosterIngest(tenantId ?? undefined, accountId ?? undefined, {
    source: 'builder',
    resolveCampaignId: ensureCampaign,
    // Hero fields are campaign config, not ingest config — they are what the
    // Agent Console reads to decide which fields get the big type.
    onIngestStarted: async (id, currentMapping) => {
      const display = buildContextDisplay(currentMapping);
      if (display.hero) {
        await updateAgencyCampaign(
          id,
          { context_display: display } as never,
          tenantId ?? undefined,
          accountId ?? undefined,
        );
      }
    },
  });

  const onSaveConfig = useCallback(async () => {
    const block = configBlockReason(config);
    if (block !== null) {
      /*
        The Save control is already disabled while this is non-null, so reaching
        here means a keyboard or programmatic submit. Populate the per-field
        errors on the way out regardless: the block copy says "Fix the
        highlighted fields", and until now nothing was highlighted —
        `fieldErrors` was only ever filled from a server response, so a purely
        client-side finding (a duplicate code, an unlabelled outcome) produced a
        banner pointing at fields that looked fine. `validateConfig` keys
        exactly as the server does, so the two land in the same place.
      */
      const errors = validateConfig(config);
      setFieldErrors(errors);
      trackAgencyCampaignConfigBlocked({
        source: 'builder',
        field_error_count: Object.keys(errors).length,
      });
      return;
    }
    setSavingConfig(true);
    setConfigSaved(false);
    setFieldErrors({});
    // A refusal from an earlier save must not outlive the save that fixed it.
    setError(null);
    // The builder has no call-summary picker, so only `record_calls` is taken: the
    // same omit-when-it-would-be-refused rule the settings page uses.
    const { record_calls } = recordingPayload({
      recordingEnabled,
      analyticsEnabled: false,
      next: builderRecording(recordCalls),
    });
    try {
      const id = await ensureCampaign();
      /*
        The basics the draft was created with, or last saved with. Any that moved since go in
        this PATCH (a draft takes all three); the carrier re-judges the pool, so a carrier move
        sends the caller IDs as well, the rule campaign Settings saves by.
      */
      const server = serverBasicsRef.current;
      const trimmedName = name.trim();
      const sendName = server === null || trimmedName !== server.name;
      const sendCarrier = server === null || !sameCarrier(carrier, server.carrier);
      const sendCallerIds = sendCarrier || server === null || !samePool(callerIds, server.callerIds);
      try {
        await updateAgencyCampaign(
          id,
          {
            ...buildConfigPayload(config, assignmentEnabled ? 'all' : 'none'),
            ...(record_calls !== undefined ? { record_calls } : {}),
            ...(sendName ? { name: trimmedName } : {}),
            ...(sendCallerIds ? { caller_ids: callerIds } : {}),
            ...(sendCarrier
              ? {
                telephony_provider: carrier.telephony_provider,
                telephony_credential_id: carrier.telephony_credential_id,
              }
              : {}),
          },
          tenantId ?? undefined,
          accountId ?? undefined,
        );
      } catch (err: unknown) {
        // A carrier refusal says the operator's sentence and goes to Basics, as on create.
        throw withCarrierRefusalCopy(err);
      }
      serverBasicsRef.current = { name: trimmedName, callerIds: [...callerIds], carrier };
      setConfigSaved(true);
      setSavedForm({ name, callerIds, carrier: chosenCarrier, recording: builderRecording(recordCalls), config });
      {
        const priorOrder = initialDispositionOrderRef.current;
        const nextOrder = config.dispositions.map((d) => d.code);
        const reordered =
          priorOrder.length !== nextOrder.length ||
          priorOrder.some((code, i) => code !== nextOrder[i]);
        trackAgencyCampaignConfigSaved({
          campaign_id: id,
          source: 'builder',
          disposition_count: config.dispositions.length,
          custom_disposition_count: config.dispositions.filter((d) => !isBuiltInCode(d.code))
            .length,
          suppress_and_terminal_pairs: config.dispositions.filter((d) => d.suppress && d.terminal)
            .length,
          disposition_retry_rule_count: config.dispositions.filter((d) => d.retry != null).length,
          retry_policy_outcome_count: Object.keys(config.retryPolicy).length,
          wrapup_seconds: config.wrapupSeconds,
          auto_return: config.autoReturn,
          wrapup_redial: config.allowWrapupRedial,
          abandonment_ceiling_pct: config.abandonmentCeilingPct,
          ...(assignmentEnabled
            ? {
              assignment_mode: config.assignment.mode,
              agent_retry: config.assignment.allowAgentRetry,
              override_outcome_count: config.dispositions.filter((d) => d.override != null).length,
            }
            : {}),
          recording_enabled: recordCalls,
          // The builder has no call-summary picker; only the settings page sets one.
          analysis_profile_set: false,
          reordered,
        });
      }
    } catch (err: unknown) {
      if (err instanceof CarrierRefusalError) {
        setError(err.message);
        goTo('basics');
        return;
      }
      // A `capability_disabled` 403 (recording switched on for an account that may
      // not record) carries no `details`; say what happened, on the step that has the box.
      const refusal = campaignSaveRefusal(err, { sentAnalysisProfile: false });
      if (refusal !== null) {
        setError(refusal);
        goTo('behaviour');
        return;
      }
      // The server answers `{ details: { field: message } }` keyed by the path into
      // the body, so the message lands on the field that caused it rather than
      // in one banner the operator has to map back by hand.
      const mapped = fieldErrorsFromResponse(err);
      // The name and the caller IDs are on Basics, which shows the refusal as the page's banner.
      const basicsRefusal = mapped.name ?? mapped.caller_ids;
      if (basicsRefusal !== undefined) {
        setError(basicsRefusal);
        goTo('basics');
      } else if (Object.keys(mapped).length > 0) {
        setFieldErrors(mapped);
        if (mapped.default_timezone || mapped.calling_window_start || mapped.calling_window_end || mapped.calling_days) {
          goTo('hours');
        } else {
          goTo('behaviour');
        }
      } else {
        setError(err instanceof Error ? err.message : 'Could not save the campaign.');
      }
    } finally {
      setSavingConfig(false);
    }
  }, [
    config, recordCalls, recordingEnabled, assignmentEnabled, ensureCampaign, tenantId, accountId, goTo, setError,
    name, callerIds, carrier, chosenCarrier,
  ]);

  const backToMapping = useCallback(() => {
    setPhase('mapping');
    goTo('contacts');
  }, [goTo, setPhase]);

  const pickFile = useCallback(
    async (file: File | undefined) => {
      if (!file || phase !== 'idle' || acceptingFileRef.current) return;
      acceptingFileRef.current = true;
      setDragOver(false);
      try {
        await onPickFile(file);
      } finally {
        acceptingFileRef.current = false;
      }
    },
    [onPickFile, phase],
  );

  const configBlock = configBlockReason(config);
  const basicsReady = name.trim().length > 0 && callerIds.length > 0;
  const basicsBlock = basicsBlockReason(name, callerIds);
  const contactsLabel = contactsContinueLabel(phase);
  const currentMeta = stepById(step);
  const contactsImported = phase === 'done' && job !== null && !job.dry_run;

  /**
   * Which steps show a tick.
   *
   * **A step is complete when it is both valid AND has been visited**, and the
   * second half is the one that was missing. `hours` and `behaviour` are keyed
   * on `configBlock === null` — the config passing validation — and the config
   * the wizard seeds *already* passes, because `emptyCampaignConfig()` is a
   * working default. So on step 1 of 5, before the operator had been anywhere,
   * steps 3 and 4 rendered ticks while step 2 did not.
   *
   * That is not a cosmetic wrong. A tick says "there is nothing for you here",
   * and these two steps are where the calling window and the disposition
   * catalog get decided — including which outcomes carry `suppress`, which is
   * what takes a contact off the list for good. Telling an operator those are
   * settled before they have read them is the most expensive place in the wizard
   * to say it.
   *
   * `basics` and `contacts` were always honest, because `basicsReady` and
   * `contactsImported` cannot be true without the operator having done
   * something. `visited` is what gives the other two the same property.
   */
  const completed = useMemo(() => {
    const next = new Set<BuilderStepId>();
    if (basicsReady) next.add('basics');
    if (contactsImported) next.add('contacts');
    if (configBlock === null) {
      if (visited.has('hours')) next.add('hours');
      if (visited.has('behaviour')) next.add('behaviour');
    }
    if (configSaved) next.add('review');
    return next;
  }, [basicsReady, contactsImported, configBlock, configSaved, visited]);

  const selectStep = useCallback(
    (id: BuilderStepId) => {
      if (!canVisitStep(id, basicsReady)) return;
      goTo(id);
    },
    [basicsReady, goTo],
  );

  const onContinue = useCallback(() => {
    if (step === 'basics' && basicsBlock) return;
    const next = nextStep(step);
    if (next && canVisitStep(next, basicsReady || step === 'basics')) {
      goTo(next);
    }
  }, [step, basicsBlock, basicsReady, goTo]);

  const onBack = useCallback(() => {
    const previous = prevStep(step);
    if (previous) goTo(previous);
  }, [step, goTo]);

  /*
    Unsaved input, for the leave guard: any setting that differs from what the server has
    (the carrier as the page would send it, so a default it settles on is not an edit), or a
    roster upload not yet imported.
  */
  const unsaved = changedSettings(
    { ...savedForm, carrier: savedForm.carrier ?? carrier },
    { name, callerIds, carrier, recording: builderRecording(recordCalls), config },
  ).length > 0 || phase === 'uploading' || phase === 'analyzing' || phase === 'mapping';
  const leaveGuard = useUnsavedChangesGuard(unsaved);

  const continueDisabled = step === 'basics' && basicsBlock !== null;
  const saveDisabled = savingConfig || configBlock !== null || !basicsReady;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>New campaign</h1>
        <p className={styles.subtitle}>
          Set up one thing at a time. You can jump back to any finished step.
        </p>
      </header>

      <BuilderStepper
        current={step}
        basicsReady={basicsReady}
        completed={completed}
        onSelect={selectStep}
      />

      {error ? (
        <p className={styles.error} role="alert" data-testid="builder-error">
          {error}
        </p>
      ) : null}

      <div className={styles.workspace}>
        <div className={styles.main}>
          <section className={styles.card} data-testid="builder-step" data-step={step}>
            <header className={styles.cardHeader}>
              <p className={styles.cardKicker}>
                Step {BUILDER_STEPS.findIndex((entry) => entry.id === step) + 1} of {BUILDER_STEPS.length}
              </p>
              <h2 className={styles.cardTitle} ref={headingRef} tabIndex={-1}>
                {currentMeta.title}
              </h2>
              <p className={styles.cardHelper}>{currentMeta.helper}</p>
            </header>

            <div className={styles.cardBody}>
              {step === 'basics' ? (
                <>
                  <div className="form-group">
                    <label htmlFor="campaign-name">
                      Campaign name<span className="required-star">*</span>
                    </label>
                    <input
                      id="campaign-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Collections — August"
                      autoFocus
                    />
                    <p className={styles.fieldHint}>A name your team will recognise in the campaign list.</p>
                  </div>
                  {/* Shown only when there is a choice: with one carrier account the
                      campaign takes it, and the step reads as it always did. */}
                  {carrierChoices.length > 1 ? (
                    <CampaignCarrierField
                      options={carrierChoices}
                      value={carrier}
                      onChange={setChosenCarrier}
                      disabled={campaignId !== null}
                      notice={campaignId !== null
                        ? 'The draft is saved on this carrier. Change it in the campaign’s settings.'
                        : null}
                    />
                  ) : null}
                  <div className="form-group">
                    <label htmlFor="campaign-caller-ids">
                      Numbers to call from<span className="required-star">*</span>
                    </label>
                    <p className={styles.fieldHint}>
                      Customers see these as the caller ID. Pick at least one — calls rotate through them.
                    </p>
                    <CallerIdPicker
                      selected={callerIds}
                      onChange={setCallerIds}
                      carrier={carrier}
                      carrierLabel={carrierLabel}
                    />
                  </div>
                </>
              ) : null}

              {step === 'contacts' ? (
                <div className={styles.stepFill}>
                  {phase === 'idle' || phase === 'uploading' || phase === 'analyzing' ? (
                    <div
                      className={`${styles.dropzone} ${dragOver ? styles.dropzoneActive : ''}`}
                      data-testid="contacts-dropzone"
                      data-drag-over={dragOver || undefined}
                      onDragOver={(event) => {
                        event.preventDefault();
                        if (phase === 'idle' && !acceptingFileRef.current) {
                          setDragOver(true);
                        }
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragOver(false);
                        void pickFile(event.dataTransfer.files[0]);
                      }}
                    >
                      <Upload size={22} aria-hidden="true" />
                      <p className={styles.dropzoneCopy}>
                        Drop a CSV here, or choose a file. You&apos;ll pick the phone column on the next
                        screen.
                      </p>
                      {limits ? (
                        <p className={styles.limits} data-testid="ingest-limits">
                          Up to {limits.max_rows.toLocaleString()} rows and{' '}
                          {Math.floor(limits.max_file_bytes / (1024 * 1024)).toLocaleString()} MB per file.
                        </p>
                      ) : null}
                      <input
                        ref={fileInputRef}
                        className={styles.fileInput}
                        type="file"
                        accept=".csv,text/csv"
                        aria-label="CSV file"
                        disabled={phase !== 'idle'}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          void pickFile(file);
                        }}
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={phase !== 'idle'}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Choose a CSV
                      </button>
                      {phase === 'uploading' ? <p className={styles.busy}>Uploading…</p> : null}
                      {phase === 'analyzing' ? <p className={styles.busy}>Reading the columns…</p> : null}
                    </div>
                  ) : null}

                  {analysis && mapping && (phase === 'mapping' || phase === 'ingesting' || phase === 'done') ? (
                    <>
                      <ColumnMapper
                        analysis={analysis}
                        state={mapping}
                        onChange={setMapping}
                        fileName={upload?.file_name ?? ''}
                        disabled={phase === 'ingesting'}
                      />
                      {phase === 'mapping' ? (
                        <div className={styles.ingestActions}>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={mappingBlockReason(mapping) !== null}
                            onClick={() => void startIngest(true)}
                          >
                            Check the file first
                          </button>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={mappingBlockReason(mapping) !== null || !basicsReady}
                            onClick={() => void startIngest(false)}
                          >
                            Import contacts
                          </button>
                          {!basicsReady ? (
                            <span className={styles.blockReason}>
                              {name.trim().length === 0
                                ? 'Name the campaign first.'
                                : 'Pick at least one caller ID first.'}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {running ? (
                    <div className={styles.progress} data-testid="ingest-progress">
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
                      {job.dry_run ? (
                        <p className={styles.dryRunNote} data-testid="dry-run-note">
                          Nothing was imported — this was a check. Import when the numbers look right.
                        </p>
                      ) : null}
                      <IngestSummary
                        job={job}
                        onBackToMapping={backToMapping}
                        onDownloadRejected={() => void onDownloadRejected()}
                        downloading={downloading}
                        downloadError={downloadError}
                      />
                    </>
                  ) : null}
                </div>
              ) : null}

              {step === 'hours' ? (
                <>
                  <p className={styles.recommend}>
                    Most teams call Monday to Friday, 09:00–20:00. Change the timezone if your
                    contacts are not in India.
                  </p>
                  <CampaignBehaviourSection
                    state={config}
                    onChange={(next) => {
                      setConfig(next);
                      setConfigSaved(false);
                    }}
                    fieldErrors={fieldErrors}
                    layout="plain"
                    include={['hours']}
                  />
                </>
              ) : null}

              {step === 'behaviour' ? (
                <>
                  <p className={styles.recommend}>
                    Recommended settings are already in place. Continue if they look right.
                  </p>
                  <CampaignBehaviourSection
                    state={config}
                    onChange={(next) => {
                      setConfig(next);
                      setConfigSaved(false);
                    }}
                    fieldErrors={fieldErrors}
                    layout="plain"
                    include={['behaviour']}
                    assignment={assignmentEnabled ? { modeLocked: false } : undefined}
                    inbound={inboundEnabled}
                  />
                  <CampaignRecordingField
                    checked={recordCalls}
                    onChange={(next) => {
                      setRecordCalls(next);
                      setConfigSaved(false);
                    }}
                    capabilityEnabled={recordingEnabled}
                    error={fieldErrors['record_calls']}
                  />
                </>
              ) : null}

              {step === 'review' ? (
                <div className={styles.review} data-testid="builder-review">
                  <ReviewRow
                    label="Name"
                    value={name.trim() || 'Not named yet'}
                    onEdit={() => goTo('basics')}
                  />
                  <ReviewRow
                    label="Call from"
                    value={
                      callerIds.length === 0
                        ? 'No numbers yet'
                        : callerIds.join(', ')
                    }
                    onEdit={() => goTo('basics')}
                  />
                  <ReviewRow
                    label="Contacts"
                    value={
                      contactsImported && job
                        ? `${job.accepted.toLocaleString()} ready to dial`
                        : 'None imported yet — you can add a list after saving.'
                    }
                    warning={!contactsImported}
                    onEdit={() => goTo('contacts')}
                  />
                  <ReviewRow
                    label="Hours"
                    value={callingWindowEcho(config.window)}
                    onEdit={() => goTo('hours')}
                  />
                  <ReviewRow
                    label="Outcomes"
                    value={config.dispositions.map((entry) => entry.label || entry.code).join(', ')}
                    onEdit={() => goTo('behaviour')}
                  />
                  <ReviewRow
                    label="Wrap-up"
                    value={`${
                      config.wrapupSeconds === 0
                        ? 'None — agents go straight back to available.'
                        : `${config.wrapupSeconds}s${
                            config.autoReturn
                              ? ', then agents return on their own'
                              : ', then agents mark themselves ready'
                          }`
                    }${config.allowWrapupRedial ? ' · Redial from wrap-up allowed' : ''}`}
                    onEdit={() => goTo('behaviour')}
                  />
                  {assignmentEnabled ? (
                    <ReviewRow
                      label="Assignment"
                      value={`${ASSIGNMENT_MODE_COPY[config.assignment.mode].label}${
                        config.assignment.allowAgentRetry
                          ? ` · Agents may retry missed contacts (up to ${config.assignment.agentRetryRounds}×)`
                          : ''
                      }`}
                      onEdit={() => goTo('behaviour')}
                    />
                  ) : null}
                  <ReviewRow
                    label="Abandonment limit"
                    value={ceilingSummary(config.abandonmentCeilingPct)}
                    warning={ceilingAboveReference(config.abandonmentCeilingPct)}
                    onEdit={() => goTo('behaviour')}
                  />
                  <ReviewRow
                    label="Recording"
                    value={recordCalls ? 'Every call is recorded' : 'Off'}
                    onEdit={() => goTo('behaviour')}
                  />
                  <p className={styles.reviewNote}>
                    Saving creates a draft. Nothing is dialled until you open the campaign and start it.
                  </p>
                </div>
              ) : null}
            </div>

          <div className={styles.footer}>
            {prevStep(step) ? (
              <button type="button" className="btn-secondary" onClick={onBack}>
                Back
              </button>
            ) : null}

            {step !== 'review' && (step !== 'contacts' || contactsLabel) ? (
              <button
                type="button"
                className="btn-primary"
                onClick={onContinue}
                disabled={continueDisabled}
              >
                {step === 'contacts' ? contactsLabel : 'Continue'}
              </button>
            ) : null}

            <button
              type="button"
              className={step === 'review' ? 'btn-primary' : 'btn-secondary'}
              onClick={() => void onSaveConfig()}
              disabled={saveDisabled}
            >
              {savingConfig ? 'Saving…' : 'Save campaign'}
            </button>

            {step === 'basics' && basicsBlock ? (
              <span className={styles.blockReason}>{basicsBlock}</span>
            ) : null}
            {configBlock ? (
              <span className={styles.blockReason} data-testid="config-block">
                {CONFIG_BLOCK_COPY[configBlock]}
              </span>
            ) : null}
            {configSaved ? (
              <span className={styles.saved} role="status">
                Saved.
                {campaignId ? (
                  <>
                    {' '}
                    <Link to={`/agency/campaigns/${campaignId}`} className={styles.savedLink}>
                      Open campaign
                    </Link>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
          </section>
        </div>

        <div className={styles.railSlot}>
          <BuilderSummary
            name={name}
            callerIds={callerIds}
            phase={phase}
            job={job}
            config={config}
            current={step}
            onJump={selectStep}
          />
        </div>
      </div>

      <LeaveUnsavedDialog
        guard={leaveGuard}
        message="What you have entered for this new campaign is not saved. Leave now and it is lost; Cancel keeps you here to save it."
      />
    </div>
  );
}

function ReviewRow({
  label,
  value,
  warning = false,
  onEdit,
}: {
  label: string;
  value: string;
  warning?: boolean;
  onEdit: () => void;
}) {
  return (
    <div className={styles.reviewRow} data-warning={warning || undefined}>
      <div>
        <p className={styles.reviewLabel}>{label}</p>
        <p className={styles.reviewValue}>{value}</p>
      </div>
      <button type="button" className="btn-secondary" onClick={onEdit} aria-label={`Edit ${label}`}>
        Edit
      </button>
    </div>
  );
}
