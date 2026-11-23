import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AGENCY_PHONE_DISPLAY_DEFAULT, type AgencyPhoneDisplay } from '@magick-agency/contracts/agency';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { useTenant } from '../../../contexts/TenantContext';
import { useGovernance } from '../../../contexts/GovernanceContext';
import { useAgencyCarriers } from '../../../hooks/useAgencyCarriers';
import { usePhoneNumbers } from '../../../hooks/usePhoneNumbers';
import {
  CarrierRefusalError,
  carrierOptions,
  sameCarrier,
  withCarrierRefusalCopy,
  type CarrierChoice,
} from '../../../utils/agencyCarriers';
import {
  AGENCY_ANALYTICS_CAPABILITY,
  AGENCY_RECORDING_CAPABILITY,
  NO_ANALYSIS_PROFILE,
  campaignSaveRefusal,
  payloadSetsProfile,
  recordingPayload,
  resolveProfileId,
  type CampaignRecordingState,
} from '../../../utils/agencyCampaignRecording';
import { useCallAnalysisProfiles } from '../../../hooks/useCallAnalysisProfiles';
import {
  createAgencyCampaign,
  transitionAgencyCampaign,
  updateAgencyCampaign,
} from '../../../api/agencyCampaigns';
import { buildContextDisplay } from '../../../utils/agencyColumnMapping';
import { useRosterIngest } from '../../../hooks/useRosterIngest';
import { useFeatureFlagEnabled } from '../../../hooks/useFeatureFlagEnabled';
import { useCampaignStaffing, staffingFailureMessage, type StaffingApplyResult } from '../../../hooks/useCampaignStaffing';
import { INBOUND_FLAG } from '../../../utils/inbound/inboundFlag';
import { CONTACT_ASSIGNMENT_FLAG } from '../../../utils/agencyAssignmentCopy';
import {
  trackAgencyCampaignBuilderStepViewed,
  trackAgencyCampaignConfigBlocked,
  trackAgencyCampaignConfigSaved,
  trackAgencyCampaignLifecycleAction,
  trackAgencyCampaignLifecycleFailed,
} from '../../../analytics/events';
import { ApiError } from '../../../api/client';
import {
  emptyCampaignConfig,
  buildConfigPayload,
  ceilingStateError,
  isBuiltInCode,
  validateConfig,
  fieldErrorsFromResponse,
  type CampaignConfigState,
} from '../../../utils/agencyCampaignConfigForm';
import { isKnownCampaignStatus, lifecycleRefusalMessage } from '../../../utils/agencyCampaignControls';
import { dailyTargetError, dailyTargetPayload } from '../../../utils/agency/stationSettings';
import {
  breakReasonsErrors,
  breakReasonsFormOf,
  breakReasonsPayload,
  sameBreakLimits,
  type BreakReasonsForm,
} from '../../../utils/agency/breakLimits';
import { SETUP_STEPS, isSetupStepId, type SetupStepId } from '../../../utils/campaignSetup/setupSteps';
import { customersContinue } from '../../../utils/campaignSetup/ingestChips';
import { isPurposePresetId, withPreset } from '../../../utils/campaignSetup/purposePresets';
import { isAdvancedField, readyLine } from '../../../utils/campaignSetup/agentsTiming';
import { StepCards } from '../../../components/campaign-setup';
import { NameNumberStep } from './setup/NameNumberStep';
import { CustomersStep } from './setup/CustomersStep';
import { PurposeButtonsStep } from './setup/PurposeButtonsStep';
import { AgentsTimingStep } from './setup/AgentsTimingStep';
import { BreakLimitsEditor } from './BreakLimitsEditor';
import {
  basicsBlockReason,
  defaultBuilderCarrier,
  canVisitStep,
  nextStep,
  prevStep,
  stepIndex,
} from './builderFlow';
import {
  findingsByStep,
  firstOtherStepWithFindings,
  goToStepLabel,
  saveBlockCopy,
} from './builderErrors';
import { focusFirstFieldError } from './configFieldErrors';
import { changedSettings, samePool, type CampaignSettingsForm } from '../../../utils/campaignSettingsChanges';
import { useUnsavedChangesGuard } from '../../../hooks/useUnsavedChangesGuard';
import { LeaveUnsavedDialog } from '../../../components/agency/UnsavedChangesBar';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { useBuilderTemplate } from '../../../components/agency/campaignTemplates/useBuilderTemplate';
import { StartFromPanel } from '../../../components/agency/campaignTemplates/StartFromPanel';
import { BuilderScriptCard } from '../../../components/agency/campaignTemplates/BuilderScriptCard';
import { sectionSourcesOf } from '../../../components/agency/campaignTemplates/SectionSource';
import styles from './CampaignBuilderPage.module.css';

/**
 * New campaign (`/agency/campaigns/new`) on the four setup steps (CS1, `docs/campaign-setup.md`):
 * Name & number, Customers, Purpose & buttons, Agents & timing. Each step is a controlled
 * component in `./setup/`, shared with campaign Settings; this page owns the state, the draft, the
 * saves, the staffing (CS10), Start (CS15) and the leave guard, so it is composition.
 *
 * There is no Review step: the step cards mark a step that needs fixing, the footer names the
 * step that holds a finding with a way to it, and the last step's footer reads "Ready: …".
 *
 * With campaign templates on (`docs/campaign-templates.md` §7, CS17–CS20), "Start from" sits above
 * the step cards and fills every step (`useBuilderTemplate`); each section's source chip and Reset
 * sit at the block that edits it, through the steps' `sectionSources`; a template's script is on
 * Purpose & buttons, under the buttons. With the flag off or the read failing, none of it shows.
 *
 * Leaving with input not yet saved asks first, as campaign Settings does
 * (`useUnsavedChangesGuard`): what is typed is compared with what the server has (nothing
 * at first; the name, numbers and carrier once a roster import creates the draft; the whole
 * form once Save as draft succeeds), and a roster upload still being mapped counts too.
 */

/**
 * What the builder holds that a save sends, as campaign Settings counts it, except that the
 * carrier is `null` while the page's default stands: that default moves as the carriers and
 * numbers load, and is not an edit.
 */
type BuilderForm = Omit<CampaignSettingsForm, 'carrier'> & { carrier: CarrierChoice | null };

/** The agent screen's two settings step 4 offers (AS6, AS9): the daily target and the number display. */
interface AgentScreenForm {
  dailyTarget: string;
  phoneDisplay: AgencyPhoneDisplay;
}

/** A new campaign records nothing and has no call summary until the operator picks them. */
const NEW_CAMPAIGN_RECORDING: CampaignRecordingState = { record: false, profileId: NO_ANALYSIS_PROFILE };
/** A new campaign has no daily target and shows the whole number, as the server's defaults. */
const NEW_AGENT_SCREEN: AgentScreenForm = { dailyTarget: '', phoneDisplay: AGENCY_PHONE_DISPLAY_DEFAULT };
/** The built-in break reasons a new campaign is offered (LF20): sent only once a limit changes. */
const NEW_BREAK_REASONS: BreakReasonsForm = breakReasonsFormOf(undefined);

/** Start's reason while no customers have been added (the server refuses an empty campaign). */
export const START_NEEDS_CUSTOMERS =
  'Add customers on the Customers step first: a campaign with no customers cannot start. You can save it as a draft now.';
/** Start's reason while customers are still being added. */
export const START_WAITS_FOR_IMPORT = 'Wait for the customers to finish being added.';
/** Why the saves wait while a template's script does not fit (CS19, CTC10), from another step and on its own. */
export const SCRIPT_BLOCK_ELSEWHERE = 'Change the script on Purpose & buttons before you save.';
export const SCRIPT_BLOCK_HERE = 'Change the script below before you save.';

/** A save's refusal that lives under a step's Advanced fold, so that fold is held open. */
interface RefusedInAdvanced {
  purpose: boolean;
  agents: boolean;
}
const NOTHING_REFUSED: RefusedInAdvanced = { purpose: false, agents: false };

/** The fields step 3 keeps under its Advanced fold (its full outcome editor and the automatic outcomes). */
function isPurposeFoldField(field: string): boolean {
  return field === 'disposition_catalog'
    || field.startsWith('outcome_dispositions')
    || /^disposition_catalog\[\d+\]\.(code|override(\..+)?|promise_follow_up_days)$/.test(field);
}

/** Who the server has on the campaign after an apply: what was asked for, less what failed. */
function staffedAfter(before: readonly string[], asked: readonly string[], result: StaffingApplyResult): string[] {
  if (result.readError) return [...before];
  const staffed = new Set(asked);
  for (const failure of result.failures) {
    if (failure.action === 'add') staffed.delete(failure.userId);
    else staffed.add(failure.userId);
  }
  return [...staffed];
}

/** A save that went through: the draft's id, and what staffing it could not do (null: all of it). */
interface SavedDraft {
  id: string;
  staffingFailure: string | null;
}

export default function CampaignBuilderPage() {
  const { tenantId, accountId } = useTenant();
  const navigate = useNavigate();
  // Contact assignment: the Assignment group and outcome overrides, flag-gated.
  // The builder's campaign is always a draft, so the mode is never locked here.
  const assignmentEnabled = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);
  const inboundEnabled = useFeatureFlagEnabled(INBOUND_FLAG);

  const [step, setStep] = useState<SetupStepId>('basics');
  const [name, setName] = useState('');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [callerIds, setCallerIds] = useState<string[]>([]);
  /** A save's refusal of the name or the numbers, said under the field on Name & number. */
  const [nameError, setNameError] = useState<string | null>(null);
  const [callerIdsError, setCallerIdsError] = useState<string | null>(null);
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
   * Recording and the call summary (the analysis profile, whose custom dimensions each
   * connected call is summarised against), set on Agents & timing and saved with the config.
   * The account's `agency.recording` decides whether recording can be switched on, and
   * `agency.analytics` whether a profile can be picked (UX gating; the API's 403 is the
   * enforcement, and `useGovernance` fails open), as on campaign Settings.
   */
  const [recording, setRecording] = useState<CampaignRecordingState>(NEW_CAMPAIGN_RECORDING);
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const recordingEnabled = isCapabilityEnabled(AGENCY_RECORDING_CAPABILITY);
  const analyticsEnabled = isCapabilityEnabled(AGENCY_ANALYTICS_CAPABILITY);
  const {
    profiles: analysisProfiles,
    loading: profilesLoading,
    error: profilesError,
  } = useCallAnalysisProfiles({ enabled: analyticsEnabled });

  const [config, setConfig] = useState<CampaignConfigState>(emptyCampaignConfig);
  /**
   * Analytics-only: the disposition order the wizard started with, to detect whether anything
   * moved the buttons before the save. A starting point on Purpose & buttons (CS2) starts it
   * again from that preset's order.
   */
  const initialDispositionOrderRef = useRef(config.dispositions.map((d) => d.code));
  /**
   * The daily target, the number display (step 4's agent screen) and the break limits (its
   * Advanced fold). The same campaign PATCH campaign Settings saves them with takes them, so a
   * save sends each that differs from what the draft has (the server's defaults at first).
   */
  const [agentScreen, setAgentScreen] = useState<AgentScreenForm>(NEW_AGENT_SCREEN);
  const [savedAgentScreen, setSavedAgentScreen] = useState<AgentScreenForm>(NEW_AGENT_SCREEN);
  const [breakReasons, setBreakReasons] = useState<BreakReasonsForm>(NEW_BREAK_REASONS);
  /**
   * Bumped when a campaign template replaced the buttons (filled in, or Reset): Purpose & buttons
   * then forgets what it held about the old rows (`buttonsReplaced`).
   */
  const [buttonsReplaced, setButtonsReplaced] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [refusedInAdvanced, setRefusedInAdvanced] = useState<RefusedInAdvanced>(NOTHING_REFUSED);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  /** Whether Save as draft has gone through at least once: what the draft holds, for the notes. */
  const [savedOnce, setSavedOnce] = useState(false);
  /**
   * Whether an import has been sent into the draft. Set as it starts, never by a check, and
   * kept: rows that landed stay in the draft even if the import later fails or is cancelled,
   * and a second file being checked does not take them out.
   */
  const [importSent, setImportSent] = useState(false);
  /** The form as the server has it: empty until a draft is created, then as last saved. */
  const [savedForm, setSavedForm] = useState<BuilderForm>(() => ({
    name: '',
    callerIds: [],
    carrier: null,
    recording: NEW_CAMPAIGN_RECORDING,
    config,
    breakReasons: NEW_BREAK_REASONS,
  }));
  /**
   * The draft's basics as the server has them (null until the draft exists): the name, the
   * caller IDs and the carrier account sent on create, then on each save. Once the draft exists
   * the save is a PATCH, and it carries any of the three that moved since, or a rename after a
   * roster import would never reach the server. A ref, not state: the save reads it straight
   * after `ensureCampaign` may have set it.
   */
  const serverBasicsRef = useRef<{ name: string; callerIds: readonly string[]; carrier: CarrierChoice } | null>(null);
  /**
   * The agent screen and break limits a template's create sent, for the save that follows it in
   * the same click (its state is not read yet); cleared once a save has used it.
   */
  const createdWithRef = useRef<{ agentScreen?: AgentScreenForm; breakReasons?: BreakReasonsForm } | null>(null);

  /*
    Who calls (CS10). The ticks are the page's; they reach the campaign when a save goes
    through (the draft must exist first), through the assignment routes the campaign page uses.
    `staffedIds` is who the server has after the last apply, for the leave guard.
  */
  const staffing = useCampaignStaffing(campaignId);
  const applyStaffing = staffing.applyStaffing;
  const [selected, setSelected] = useState<string[]>(() => staffing.assignedIds);
  const [staffedIds, setStaffedIds] = useState<string[]>(() => staffing.assignedIds);
  const [staffingError, setStaffingError] = useState<string | null>(null);

  /** Start (CS15): in flight, and its refusal, said with a link to the draft it left. */
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [startRefusal, setStartRefusal] = useState<{ id: string; message: string } | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);

  // `phase` is render state, so two drop/change events can both observe `idle` before React
  // commits `uploading`. This immediate lock prevents a second upload in that gap; `phase`
  // remains the user-visible gate (the step holds a lock of its own too).
  const acceptingFileRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * Steps the operator has actually been on. Half of "is this step complete?" — see
   * {@link completed}. Seeded with the step the page opens on, reached by definition.
   */
  const [visited, setVisited] = useState<ReadonlySet<SetupStepId>>(() => new Set<SetupStepId>(['basics']));

  /*
    A step change moves focus to the new step's heading (each step's first card heading takes
    `tabIndex={-1}`), or, for "Go to …", on to the first field with an error. Counted, so a move
    to the step already on screen (a refusal on Name & number) still lands.
  */
  const [navTick, setNavTick] = useState(0);
  const focusFindingRef = useRef(false);
  const goTo = useCallback((next: SetupStepId) => {
    setStep(next);
    setVisited((current) => (current.has(next) ? current : new Set([...current, next])));
    setNavTick((n) => n + 1);
    trackAgencyCampaignBuilderStepViewed({ step: next, step_index: stepIndex(next) });
  }, []);
  useEffect(() => {
    if (navTick === 0) return;
    const body = bodyRef.current;
    if (!body) return;
    if (focusFindingRef.current) {
      focusFindingRef.current = false;
      if (focusFirstFieldError(body)) return;
    }
    body.querySelector<HTMLElement>('h2[tabindex="-1"]')?.focus();
  }, [navTick]);
  const goToFinding = useCallback(
    (target: SetupStepId) => {
      if (target === step) {
        if (bodyRef.current) focusFirstFieldError(bodyRef.current);
        return;
      }
      // The same gate as the step cards: no step past Name & number until its basics are in.
      if (!canVisitStep(target, name.trim().length > 0 && callerIds.length > 0)) return;
      focusFindingRef.current = true;
      goTo(target);
    },
    [goTo, step, name, callerIds],
  );

  /*
    The ceiling rides on the create, not only on the config save's PATCH: a roster import
    creates the draft before any config save, and a draft that is never config-saved would
    otherwise keep the server's 3% however far the line was moved. Sent only when the value
    passes the field's own check; an emptied box (NaN) or an out-of-range value is left out, so
    the server's default applies and the config save that follows is where the field's error is
    met.
  */
  // `undefined` is dropped from the JSON body, so the server's default applies.
  const ceilingForCreate = ceilingStateError(config) === null ? config.abandonmentCeilingPct : undefined;

  /*
    Campaign templates (`docs/campaign-templates.md` §7). With the flag on and the right to create
    campaigns, the form opens filled in from the account's default chain and "Start from" switches
    it; the create names the template (`template_id`, CT8). With the flag off, or either read
    failing, nothing of it runs and the page is as it was before templates.
  */
  const template = useBuilderTemplate({
    campaignId,
    config,
    recording,
    callerIds,
    chosenCarrier,
    breakReasons,
    agentScreen,
    carrier,
    recordingEnabled,
    analyticsEnabled,
    assignmentEnabled,
    apply: (next, how) => {
      if (next.config) setConfig(next.config);
      // The flag and the call summary profile together: the template's recording section (CT5).
      if (next.recording) setRecording(next.recording);
      if (next.callerIds) setCallerIds(next.callerIds);
      if ('chosenCarrier' in next) setChosenCarrier(next.chosenCarrier ?? null);
      if (next.breakReasons) setBreakReasons(next.breakReasons);
      if (next.agentScreen) setAgentScreen(next.agentScreen);
      if (how.outcomes) setButtonsReplaced((n) => n + 1);
      setConfigSaved(false);
      const baseline = how.baseline;
      if (baseline) {
        initialDispositionOrderRef.current = baseline.config.dispositions.map((d) => d.code);
        // Before a draft exists, what the template fills in is the starting point, not an edit.
        setSavedForm((saved) => ({
          ...saved,
          callerIds: baseline.callerIds,
          carrier: baseline.chosenCarrier,
          recording: baseline.recording,
          config: baseline.config,
          breakReasons: baseline.breakReasons,
        }));
        setSavedAgentScreen(baseline.agentScreen);
      }
    },
    onReadFailed: (message) => setError(message),
  });

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
          ...template.createFields,
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
    const sent: Record<string, unknown> = template.createFields;
    template.draft.created(sent);
    serverBasicsRef.current = { name: name.trim(), callerIds: [...callerIds], carrier };
    /*
      The draft has the basics now; the rest is saved by Save as draft. A template's create also
      carried the agent screen and the break limits as on the form: the draft holds those (else it
      holds what the template filled in, the baseline already there).
    */
    setSavedForm((saved) => ({
      ...saved,
      name,
      callerIds,
      carrier: chosenCarrier,
      ...('break_reasons' in sent ? { breakReasons } : {}),
    }));
    if ('daily_target_calls' in sent) setSavedAgentScreen(agentScreen);
    createdWithRef.current = {
      ...('daily_target_calls' in sent ? { agentScreen } : {}),
      ...('break_reasons' in sent ? { breakReasons } : {}),
    };
    return created.id;
  }, [
    campaignId, name, callerIds, carrier, chosenCarrier, ceilingForCreate, template.createFields, template.draft,
    breakReasons, agentScreen, tenantId, accountId,
  ]);

  const rosterIngest = useRosterIngest(tenantId ?? undefined, accountId ?? undefined, {
    source: 'builder',
    resolveCampaignId: ensureCampaign,
    // A check never creates the draft; once the draft exists (a second file), it is
    // compared with the draft's roster like any other campaign's.
    peekCampaignId: () => campaignId ?? undefined,
    // The card's facts are campaign config, not ingest config (AS19): the columns ticked on
    // Customers are what agents see on the customer card, until Settings changes them.
    onIngestStarted: async (id, currentMapping) => {
      setImportSent(true);
      const display = buildContextDisplay(currentMapping);
      if (display.facts) {
        await updateAgencyCampaign(
          id,
          // A template's script that uses keys this card lacks is held back (CTC10): Purpose & buttons says so.
          { context_display: display, ...template.draft.cardFields(display) } as never,
          tenantId ?? undefined,
          accountId ?? undefined,
        );
      }
    },
  });
  const {
    phase,
    running,
    finished,
    checkJob,
    importing,
    importChecked,
    job,
    error,
    setError,
    onPickFile,
  } = rosterIngest;

  /*
    The customers each finished import added, by job: the Ready line's count (CS15) and Start's
    gate. A second file's import adds to the first's; a failed or stopped one counts the rows
    that landed before it stopped.
  */
  const [importedByJob, setImportedByJob] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    if (!finished || !job || job.dry_run) return;
    setImportedByJob((current) => (current[job.job_id] === job.accepted ? current : { ...current, [job.job_id]: job.accepted }));
  }, [finished, job]);
  const importCounts = Object.values(importedByJob);
  const importedCount = importCounts.length === 0 ? null : importCounts.reduce((total, n) => total + n, 0);
  const customersAdded = importedCount !== null && importedCount > 0;
  const importRunning = running && job !== null && !job.dry_run;

  /*
    Every finding that holds the save, keyed by body path: the config's own (`validateConfig`),
    the daily target's, and each break limit's. Each is shown live on its field by its step.
  */
  const configErrors = useMemo(() => validateConfig(config), [config]);
  const dailyTargetFinding = dailyTargetError(agentScreen.dailyTarget);
  const breakErrors = useMemo(() => breakReasonsErrors(breakReasons), [breakReasons]);
  const breakLimitsInvalid = Object.keys(breakErrors).length > 0;
  const findings = useMemo(() => {
    const out: Record<string, string> = { ...configErrors };
    if (dailyTargetFinding) out.daily_target_calls = dailyTargetFinding;
    for (const [code, message] of Object.entries(breakErrors)) out[`break_reasons.${code}`] = message;
    return out;
  }, [configErrors, dailyTargetFinding, breakErrors]);

  const saveDraft = useCallback(async (): Promise<SavedDraft | null> => {
    if (Object.keys(findings).length === 0 && template.scriptBlocked) {
      // The template's script does not fit yet (CS19): it is fixed on Purpose & buttons.
      goToFinding('purpose');
      return null;
    }
    if (Object.keys(findings).length > 0) {
      /*
        Save is disabled while anything is found, so this is a keyboard or programmatic
        submit. The findings are already on their fields (each step shows them live), so take
        the operator to the first one. They are not copied into `fieldErrors`, which holds the
        server's answer and wins over a live finding: a copy would keep a field red after it
        was fixed.
      */
      trackAgencyCampaignConfigBlocked({
        source: 'builder',
        field_error_count: Object.keys(findings).length,
      });
      const first = findingsByStep(findings).keys().next();
      if (!first.done) goToFinding(first.value);
      return null;
    }
    setSavingConfig(true);
    setConfigSaved(false);
    setFieldErrors({});
    setRefusedInAdvanced(NOTHING_REFUSED);
    setNameError(null);
    setCallerIdsError(null);
    setStaffingError(null);
    // A refusal from an earlier save must not outlive the save that fixed it.
    setError(null);
    // The same omit-when-it-would-be-refused rule the settings page uses.
    const recordingFields = recordingPayload({ recordingEnabled, analyticsEnabled, next: recording });
    let id: string;
    try {
      id = await ensureCampaign();
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
      // The agent screen and the break limits only where they differ from what the draft has,
      // so a campaign left on the built-in breaks keeps them (served at read time, LF20).
      const heldScreen = createdWithRef.current?.agentScreen ?? savedAgentScreen;
      const heldBreaks = createdWithRef.current?.breakReasons ?? savedForm.breakReasons;
      const sendTarget = agentScreen.dailyTarget.trim() !== heldScreen.dailyTarget.trim();
      const sendDisplay = agentScreen.phoneDisplay !== heldScreen.phoneDisplay;
      const sendBreaks = heldBreaks !== undefined && !sameBreakLimits(heldBreaks, breakReasons);
      // A template's script changed (or fixed for the card) since the draft got it (CTC10).
      const scriptFields = template.draft.saveFields();
      try {
        await updateAgencyCampaign(
          id,
          {
            ...buildConfigPayload(config, assignmentEnabled ? 'all' : 'none'),
            ...recordingFields,
            ...(sendName ? { name: trimmedName } : {}),
            ...(sendCallerIds ? { caller_ids: callerIds } : {}),
            ...(sendCarrier
              ? {
                telephony_provider: carrier.telephony_provider,
                telephony_credential_id: carrier.telephony_credential_id,
              }
              : {}),
            ...(sendTarget ? { daily_target_calls: dailyTargetPayload(agentScreen.dailyTarget) } : {}),
            ...(sendDisplay ? { phone_display: agentScreen.phoneDisplay } : {}),
            ...(sendBreaks ? { break_reasons: breakReasonsPayload(breakReasons) } : {}),
            ...scriptFields,
          },
          tenantId ?? undefined,
          accountId ?? undefined,
        );
      } catch (err: unknown) {
        // A carrier refusal says the operator's sentence and goes to Name & number, as on create.
        throw withCarrierRefusalCopy(err);
      }
      serverBasicsRef.current = { name: trimmedName, callerIds: [...callerIds], carrier };
      createdWithRef.current = null;
      template.draft.saved(scriptFields);
      setConfigSaved(true);
      setSavedOnce(true);
      setSavedForm({ name, callerIds, carrier: chosenCarrier, recording, config, breakReasons });
      setSavedAgentScreen(agentScreen);
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
          recording_enabled: recording.record,
          analysis_profile_set: resolveProfileId(recording.profileId) !== null,
          reordered,
        });
      }
    } catch (err: unknown) {
      setSavingConfig(false);
      if (err instanceof CarrierRefusalError) {
        setError(err.message);
        goTo('basics');
        return null;
      }
      // A `capability_disabled` 403 (recording or a summary profile the account may not
      // set) carries no `details`; say what happened, on the step that has the two fields.
      const refusal = campaignSaveRefusal(err, { sentAnalysisProfile: payloadSetsProfile(recordingFields) });
      if (refusal !== null) {
        setError(refusal);
        goTo('agents');
        return null;
      }
      // The server answers `{ details: { field: message } }` keyed by the path into the body,
      // so the message lands on the field that caused it rather than in one banner the
      // operator has to map back by hand.
      const mapped = fieldErrorsFromResponse(err);
      const { name: nameRefusal, caller_ids: callerIdsRefusal, ...rest } = mapped;
      const keys = Object.keys(rest);
      if (keys.length > 0) {
        setFieldErrors(rest);
        setRefusedInAdvanced({ purpose: keys.some(isPurposeFoldField), agents: keys.some(isAdvancedField) });
      }
      if (nameRefusal !== undefined || callerIdsRefusal !== undefined) {
        // The name and the numbers are on Name & number, under their own fields.
        setNameError(nameRefusal ?? null);
        setCallerIdsError(callerIdsRefusal ?? null);
        goTo('basics');
      } else if (keys.length > 0) {
        goTo(findingsByStep(rest).keys().next().value ?? 'agents');
      } else {
        setError(err instanceof Error ? err.message : 'Could not save the campaign.');
      }
      return null;
    }

    // CS10: who calls, now that the draft exists and holds the settings.
    let staffingFailure: string | null;
    try {
      const result = await applyStaffing(id, selected);
      staffingFailure = staffingFailureMessage(result);
      setStaffedIds((before) => staffedAfter(before, selected, result));
    } catch (err: unknown) {
      staffingFailure = getErrorMessage(err, 'Could not change who calls on this campaign.');
    }
    setStaffingError(staffingFailure);
    setSavingConfig(false);
    return { id, staffingFailure };
  }, [
    findings, config, recording, recordingEnabled, analyticsEnabled, assignmentEnabled, ensureCampaign, tenantId, accountId,
    goTo, setError, name, callerIds, carrier, chosenCarrier, goToFinding, agentScreen, savedAgentScreen, breakReasons,
    savedForm.breakReasons, applyStaffing, selected, template.draft, template.scriptBlocked,
  ]);

  /**
   * Start campaign (CS15): save (creating the draft if need be), staff, then start. A step that
   * fails stops the rest and leaves the draft saved; its refusal is said in words, with a link
   * to the campaign. Started, the page opens the campaign.
   */
  const onStart = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStartRefusal(null);
    try {
      const saved = await saveDraft();
      if (!saved) return;
      if (saved.staffingFailure) {
        setStartRefusal({
          id: saved.id,
          message: `${saved.staffingFailure} The campaign is saved as a draft and has not started.`,
        });
        return;
      }
      try {
        const started = await transitionAgencyCampaign(saved.id, 'start', tenantId ?? undefined, accountId ?? undefined);
        if (isKnownCampaignStatus(started.status)) {
          trackAgencyCampaignLifecycleAction({
            campaign_id: saved.id,
            action: 'start',
            from_status: 'draft',
            to_status: started.status,
            confirmed: false,
            from_tab: 'new_campaign',
          });
        }
        setStartedId(saved.id);
      } catch (err: unknown) {
        setStartRefusal({
          id: saved.id,
          message: `${lifecycleRefusalMessage(err)} The campaign is saved as a draft and has not started.`,
        });
        trackAgencyCampaignLifecycleFailed({
          campaign_id: saved.id,
          action: 'start',
          from_status: 'draft',
          status_code: err instanceof ApiError ? err.statusCode : 0,
        });
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [saveDraft, tenantId, accountId]);

  // Started: open the campaign, once the save's state has landed (so the guard has nothing to hold).
  useEffect(() => {
    if (startedId) navigate(`/agency/campaigns/${startedId}`);
  }, [startedId, navigate]);

  const pickFile = useCallback(
    async (file: File) => {
      if (phase !== 'idle' || acceptingFileRef.current) return;
      acceptingFileRef.current = true;
      try {
        await onPickFile(file);
      } finally {
        acceptingFileRef.current = false;
      }
    },
    [onPickFile, phase],
  );

  /*
    Customers' "Add 1,240 customers" imports the checked file and moves on only once that import
    has finished and completed; one that fails or is stopped stays on the step, which says what
    happened and offers the retry.
  */
  const [advanceAfterImport, setAdvanceAfterImport] = useState(false);
  useEffect(() => {
    if (!advanceAfterImport) return;
    if (finished && job && !job.dry_run) {
      setAdvanceAfterImport(false);
      if (job.status === 'completed' && step === 'contacts') goTo('purpose');
    } else if (!running && !importing && error !== null) {
      setAdvanceAfterImport(false);
    }
  }, [advanceAfterImport, finished, job, running, importing, error, step, goTo]);

  const byStep = useMemo(() => findingsByStep(findings), [findings]);
  const configBlock = byStep.size > 0;
  const invalidSteps = useMemo(() => {
    const invalid = new Set<SetupStepId>(byStep.keys());
    if (nameError || callerIdsError) invalid.add('basics');
    // A template's script the roster's card cannot fill is fixed on Purpose & buttons (CS19).
    if (template.scriptBlocked) invalid.add('purpose');
    return invalid;
  }, [byStep, nameError, callerIdsError, template.scriptBlocked]);
  const blockCopy = saveBlockCopy(byStep, step);
  const otherStepWithFindings = firstOtherStepWithFindings(byStep, step);
  const basicsReady = name.trim().length > 0 && callerIds.length > 0;
  const basicsBlock = basicsBlockReason(name, callerIds);
  const customersNext = customersContinue(phase, job, checkJob, { importing });

  /**
   * Which step cards show a tick.
   *
   * **A step is complete when it is both valid AND has been visited**, and the second half is
   * the one that was once missing. Purpose & buttons and Agents & timing are judged on their
   * findings, and the config the page seeds *already* passes, because `emptyCampaignConfig()` is
   * a working default. So on step 1, before the operator had been anywhere, the later steps
   * rendered ticks while Customers did not.
   *
   * That is not a cosmetic wrong. A tick says "there is nothing for you here", and these two
   * steps are where the calling window and the buttons get decided, including which outcomes
   * carry `suppress`, which is what takes a customer off the list for good. Telling an operator
   * those are settled before they have read them is the most expensive place to say it.
   *
   * Name & number and Customers were always honest, because `basicsReady` and `customersAdded`
   * cannot be true without the operator having done something. `visited` gives the other two
   * the same property. Each is judged on its own findings: a mistake in the buttons leaves
   * Agents & timing ticked, and the step cards mark the step that has it.
   */
  const completed = useMemo(() => {
    const next = new Set<SetupStepId>();
    if (basicsReady) next.add('basics');
    if (customersAdded) next.add('contacts');
    if (visited.has('purpose') && !invalidSteps.has('purpose')) next.add('purpose');
    if (visited.has('agents') && !invalidSteps.has('agents')) next.add('agents');
    return next;
  }, [basicsReady, customersAdded, invalidSteps, visited]);
  const closedSteps = useMemo(
    () => new Set<SetupStepId>(SETUP_STEPS.map((s) => s.id).filter((id) => !canVisitStep(id, basicsReady))),
    [basicsReady],
  );

  const selectStep = useCallback(
    (id: string) => {
      if (!isSetupStepId(id) || !canVisitStep(id, basicsReady) || id === step) return;
      goTo(id);
    },
    [basicsReady, goTo, step],
  );

  const onContinue = useCallback(() => {
    if (step === 'basics' && basicsBlock) return;
    const next = nextStep(step);
    if (next && canVisitStep(next, basicsReady || step === 'basics')) goTo(next);
  }, [step, basicsBlock, basicsReady, goTo]);

  const onCustomersContinue = useCallback(() => {
    if (!customersNext) return;
    if (customersNext.action === 'next') {
      goTo('purpose');
      return;
    }
    setAdvanceAfterImport(true);
    void importChecked();
  }, [customersNext, goTo, importChecked]);

  const onBack = useCallback(() => {
    const previous = prevStep(step);
    if (previous) goTo(previous);
  }, [step, goTo]);

  /*
    Unsaved input, for the leave guard: any setting that differs from what the server has
    (the carrier as the page would send it, so a default it settles on is not an edit), the
    agent screen, the ticks, or a roster upload not yet imported.
  */
  const agentScreenChanged = agentScreen.dailyTarget.trim() !== savedAgentScreen.dailyTarget.trim()
    || agentScreen.phoneDisplay !== savedAgentScreen.phoneDisplay;
  const settingsChanged = changedSettings(
    { ...savedForm, carrier: savedForm.carrier ?? carrier },
    { name, callerIds, carrier, recording, config, breakReasons },
  ).length > 0 || agentScreenChanged || !samePool(selected, staffedIds)
    // A template's script changed on Purpose & buttons that the draft does not hold yet (CTC10).
    || (campaignId !== null && template.draft.saveFields().agent_script !== undefined);
  const unsaved = !startedId
    && (settingsChanged || phase === 'uploading' || phase === 'analyzing' || phase === 'mapping');
  const leaveGuard = useUnsavedChangesGuard(unsaved);

  /*
    A draft exists from its first need (a customer import, or a save whose settings were then
    refused) with the name, numbers and carrier only; everything else reaches it with Save as
    draft. Without saying so, a draft in the campaign list reads as "saved", and an operator
    whose save never went through finds the defaults where their own settings should be. Said
    only while something differs from what the draft holds, and in words true of how the draft
    came to be.
  */
  const draftNote = campaignId === null || !settingsChanged || savingConfig
    ? null
    : savedOnce
      ? 'Some changes are not saved yet. They reach the campaign only when you click Save as draft or Start campaign.'
      : importSent
        ? 'Your customers are in a draft of this campaign, but your settings are not saved yet. They reach the draft only when you click Save as draft or Start campaign.'
        : 'A draft of this campaign exists, but your settings are not saved yet. They reach the draft only when you click Save as draft or Start campaign.';
  const leaveMessage = campaignId === null
    ? 'What you have entered for this new campaign is not saved. Leave now and it is lost; Cancel keeps you here to save it.'
    : `${importSent ? 'Your customers are in a draft of this campaign' : 'A draft of this campaign exists'}, but your latest changes are not saved. Leave now and the draft keeps ${
      savedOnce ? 'the settings it was last saved with' : 'the default settings'
    }; Cancel keeps you here to save them.`;

  const continueDisabled = step === 'basics' && basicsBlock !== null;
  const saveDisabled = savingConfig || starting || configBlock || !basicsReady || template.scriptBlocked;
  const startReason = !basicsReady || configBlock || template.scriptBlocked
    ? null
    : importRunning
      ? START_WAITS_FOR_IMPORT
      : customersAdded
        ? null
        : START_NEEDS_CUSTOMERS;
  const startDisabled = saveDisabled || startReason !== null;
  const lastStep = step === 'agents';

  const markDirty = () => setConfigSaved(false);
  /** The last save's refusals of a template's script, said on its fields (CS19). */
  const scriptRefusals = useMemo(
    () => Object.fromEntries(Object.entries(fieldErrors).filter(([field]) => field.startsWith('agent_script'))),
    [fieldErrors],
  );
  /** Each template section's chip and Reset, for the block that edits it (CS18); nothing without a template. */
  const sectionSources = sectionSourcesOf(template.startFrom !== null, template.sourceProps);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>New campaign</h1>
          <p className={styles.subtitle}>4 short steps · you can come back to any step</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => navigate('/agency/campaigns')}>
          Cancel
        </button>
      </header>

      {template.panel ? <StartFromPanel {...template.panel} /> : null}

      <StepCards
        steps={SETUP_STEPS}
        current={step}
        completed={completed}
        invalid={invalidSteps}
        disabled={closedSteps}
        onSelect={selectStep}
        mode="sequence"
        label="Campaign setup"
      />

      {error ? (
        <p className={styles.error} role="alert" data-testid="builder-error">
          {error}
        </p>
      ) : null}

      <div className={styles.body} data-testid="builder-step" data-step={step} ref={bodyRef}>
        {step === 'basics' ? (
          <NameNumberStep
            mode="create"
            name={name}
            onName={(next) => {
              setName(next);
              setNameError(null);
            }}
            nameError={nameError}
            carrierChoices={carrierChoices}
            carrier={carrier}
            onCarrier={setChosenCarrier}
            carrierLocked={campaignId !== null}
            carrierNotice={campaignId !== null
              ? 'The draft is saved on this carrier. Change it in the campaign’s settings.'
              : null}
            carrierLabel={carrierLabel}
            callerIds={callerIds}
            onCallerIds={(next) => {
              setCallerIds(next);
              setCallerIdsError(null);
            }}
            callerIdsError={callerIdsError}
            sectionSources={sectionSources}
          />
        ) : null}

        {step === 'contacts' ? (
          <CustomersStep
            ingest={rosterIngest}
            basicsReady={basicsReady}
            blockReason={basicsBlock}
            onPickFile={pickFile}
          />
        ) : null}

        {step === 'purpose' ? (
          <PurposeButtonsStep
            mode="create"
            config={config}
            onChange={(next) => {
              setConfig(next);
              markDirty();
            }}
            fieldErrors={fieldErrors}
            onPresetApplied={(presetId) => {
              // The save's `reordered` compares with the preset as applied, not the buttons it replaced.
              if (isPurposePresetId(presetId)) {
                initialDispositionOrderRef.current = withPreset(config, presetId).dispositions.map((d) => d.code);
              }
              markDirty();
            }}
            overrides={assignmentEnabled}
            forceAdvancedOpen={refusedInAdvanced.purpose}
            buttonsReplaced={buttonsReplaced}
            sectionSources={sectionSources}
          />
        ) : null}

        {step === 'purpose' && template.script ? (
          // A template's script, under the buttons as Settings shows it, and its fix (CS19, CTC10).
          <BuilderScriptCard
            script={template.script}
            source={sectionSources?.agent_screen}
            campaignName={name.trim()}
            serverErrors={scriptRefusals}
          />
        ) : null}

        {step === 'agents' ? (
          <AgentsTimingStep
            mode="create"
            config={config}
            onChange={(next) => {
              setConfig(next);
              markDirty();
            }}
            fieldErrors={fieldErrors}
            staffing={{
              agents: staffing.agents,
              selected,
              onChange: (ids) => {
                setSelected(ids);
                markDirty();
              },
              loading: staffing.loading,
              error: staffing.error,
              onRetry: () => void staffing.reload(),
              invitePath: staffing.invitePath,
            }}
            recording={{
              state: recording,
              onChange: (next) => {
                setRecording(next);
                markDirty();
              },
              recordingEnabled,
              analyticsEnabled,
              profiles: analysisProfiles,
              profilesLoading,
              profilesError,
              savedProfileId: resolveProfileId(savedForm.recording.profileId),
            }}
            agentScreen={{
              dailyTarget: agentScreen.dailyTarget,
              phoneDisplay: agentScreen.phoneDisplay,
              onChange: (patch) => {
                setAgentScreen((current) => ({ ...current, ...patch }));
                markDirty();
              },
            }}
            breakLimits={
              <BreakLimitsEditor
                value={breakReasons}
                onChange={(next) => {
                  setBreakReasons(next);
                  markDirty();
                }}
                serverError={fieldErrors['break_reasons'] ?? null}
                icons
                fieldErrors={fieldErrors}
              />
            }
            assignment={assignmentEnabled ? { modeLocked: false } : undefined}
            inbound={inboundEnabled}
            // The automatic outcomes for unanswered calls are under step 3's Advanced.
            unansweredOutcomes={false}
            forceAdvancedOpen={refusedInAdvanced.agents || breakLimitsInvalid}
            sectionSources={sectionSources}
          />
        ) : null}
      </div>

      {draftNote ? (
        <p className={styles.draftNote} data-testid="draft-note">
          {draftNote}
        </p>
      ) : null}

      {staffingError && !startRefusal ? (
        <p className={styles.error} role="alert" data-testid="staffing-error">
          {staffingError}
        </p>
      ) : null}

      {startRefusal ? (
        <p className={styles.error} role="alert" data-testid="start-refusal">
          {startRefusal.message}{' '}
          <Link to={`/agency/campaigns/${startRefusal.id}`} className={styles.inlineLink}>
            Open the campaign
          </Link>
        </p>
      ) : null}

      <footer className={styles.footer} data-testid="builder-footer">
        <div className={styles.footerMain}>
          {prevStep(step) ? (
            <button type="button" className="btn-secondary" onClick={onBack}>
              Back
            </button>
          ) : null}

          {lastStep ? (
            <p className={styles.ready} data-testid="ready-line">
              {readyLine({ customers: importedCount, agents: selected.length, window: config.window })}
            </p>
          ) : null}

          <div className={styles.actions}>
            {step === 'contacts' ? (
              customersNext ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={onCustomersContinue}
                  disabled={customersNext.action === 'import' && !basicsReady}
                >
                  {customersNext.label}
                </button>
              ) : null
            ) : !lastStep ? (
              <button type="button" className="btn-primary" onClick={onContinue} disabled={continueDisabled}>
                Continue
              </button>
            ) : null}

            <button
              type="button"
              className="btn-secondary"
              onClick={() => void saveDraft()}
              disabled={saveDisabled}
            >
              {savingConfig && !starting ? 'Saving…' : 'Save as draft'}
            </button>

            {lastStep ? (
              <button
                type="button"
                className={`btn-primary ${styles.start}`}
                onClick={() => void onStart()}
                disabled={startDisabled}
                aria-describedby={startReason ? 'builder-start-reason' : undefined}
              >
                {starting ? 'Starting…' : 'Start campaign'}
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.footerNotes}>
          {step === 'basics' && basicsBlock ? (
            <span className={styles.blockReason}>{basicsBlock}</span>
          ) : null}
          {lastStep && startReason ? (
            <span className={styles.blockReason} id="builder-start-reason" data-testid="start-reason">
              {startReason}
            </span>
          ) : null}
          {blockCopy ? (
            <span className={styles.blockReason} data-testid="config-block" aria-live="polite">
              {blockCopy}
              {/*
                A way to the field from wherever the operator is: another step's, or this step's
                when it is scrolled out of view (the button list is long). Not offered while
                Name & number is incomplete: no other step opens until it is.
              */}
              {basicsReady || !otherStepWithFindings ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className={styles.blockLink}
                    onClick={() => goToFinding(otherStepWithFindings ?? step)}
                    aria-label={
                      otherStepWithFindings
                        ? `${goToStepLabel(otherStepWithFindings)}, where a setting stops the campaign saving`
                        : 'Show the setting that stops the campaign saving'
                    }
                  >
                    {otherStepWithFindings ? goToStepLabel(otherStepWithFindings) : 'Show me'}
                  </button>
                </>
              ) : null}
            </span>
          ) : null}
          {template.scriptBlocked ? (
            <span className={styles.blockReason} data-testid="script-block">
              {step === 'purpose' ? SCRIPT_BLOCK_HERE : SCRIPT_BLOCK_ELSEWHERE}
              {basicsReady ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className={styles.blockLink}
                    onClick={() => goToFinding('purpose')}
                    aria-label={step === 'purpose'
                      ? 'Show the script that stops the campaign saving'
                      : `${goToStepLabel('purpose')}, where the script stops the campaign saving`}
                  >
                    {step === 'purpose' ? 'Show me' : goToStepLabel('purpose')}
                  </button>
                </>
              ) : null}
            </span>
          ) : null}
          {configSaved ? (
            <span className={styles.saved} role="status">
              Saved as a draft.
              {campaignId ? (
                <>
                  {' '}
                  <Link to={`/agency/campaigns/${campaignId}`} className={styles.inlineLink}>
                    Open campaign
                  </Link>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      </footer>

      <LeaveUnsavedDialog guard={leaveGuard} message={leaveMessage} />
      <ConfirmDialog
        open={template.confirm.open}
        title="Replace your changes?"
        message={template.confirm.message}
        confirmLabel="Start from it"
        onConfirm={template.confirm.onConfirm}
        onCancel={template.confirm.onCancel}
      />
    </div>
  );
}
