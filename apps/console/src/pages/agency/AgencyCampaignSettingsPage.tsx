import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useCallAnalysisProfiles } from '../../hooks/useCallAnalysisProfiles';
import { CampaignTemplateSource } from '../../components/agency/campaignTemplates/CampaignTemplateSource';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { errorCode } from '../../utils/agencyErrors';
import {
  ASSIGNMENT_REFUSAL_COPY,
  CONTACT_ASSIGNMENT_FLAG,
  assignmentModeLocked,
} from '../../utils/agencyAssignmentCopy';
import { callerIdDedicatedMessage, dedicatedCallerIdsOf } from '../../utils/agencyAgentCallerIdCopy';
import { getAgencyCampaign, updateAgencyCampaign } from '../../api/agencyCampaigns';
import { hasPermission } from '../../utils/permissions';
import {
  trackAgencyCampaignConfigBlocked,
  trackAgencyCampaignConfigSaved,
  trackFeatureGateUnavailable,
} from '../../analytics/events';
import {
  CONFIG_BLOCK_COPY,
  buildConfigPayload,
  configBlockReason,
  isBuiltInCode,
  validateConfig,
  configFromCampaign,
  fieldErrorsFromResponse,
  joinAnd,
  resetAssignmentConfig,
  storedAssignmentLeftovers,
  type AssignmentPayloadScope,
  type CampaignConfigState,
} from '../../utils/agencyCampaignConfigForm';
import {
  AGENCY_ANALYTICS_CAPABILITY,
  AGENCY_RECORDING_CAPABILITY,
  campaignSaveRefusal,
  payloadSetsProfile,
  recordingPayload,
  recordingStateFromCampaign,
  resolveProfileId,
  type CampaignRecordingState,
} from '../../utils/agencyCampaignRecording';
import { BreakLimitsEditor } from '../campaigns/agency/BreakLimitsEditor';
import {
  breakReasonsErrors,
  breakReasonsFormOf,
  breakReasonsPayload,
  sameBreakLimits,
  type BreakReasonsForm,
} from '../../utils/agency/breakLimits';
import { focusFirstFieldError, useConfigFieldErrors } from '../campaigns/agency/configFieldErrors';
import { CustomerFactsEditor, type ColumnsRead, type FactFocusRequest } from '../campaigns/agency/CustomerFactsEditor';
import { ScriptEditor } from '../campaigns/agency/ScriptEditor';
import { useCampaignColumns, useCampaignSampleRows } from '../../hooks/useCampaignColumns';
import {
  COLUMNS_FAILED_MESSAGE,
  COLUMNS_LOADING_MESSAGE,
  campaignColumns,
  factsChanged,
  factsErrors,
  factsFormOf,
  factsReordered,
  hiddenColumns,
  isLegacyDisplay,
  newFact,
  putBack,
  removedFactsInUse,
  replaceToken,
  stationErrors,
  stationPayload,
  stationPlan,
  stationSettingsOf,
  withoutPlacedFactErrors,
  type FactsForm,
  type StationSettingsForm,
} from '../../utils/agency/stationSettings';
import { factKeyFromColumn } from '@magick-agency/domain/fact-fields';
import {
  AGENCY_FACT_FIELDS_MAX,
  AGENCY_FACT_KEY_MAX_CHARS,
  AGENCY_FACT_KEY_PATTERN,
  AGENCY_SCRIPT_FIXED_PLACEHOLDERS,
} from '@magick-agency/contracts/agency';
import { useAgencyCarriers } from '../../hooks/useAgencyCarriers';
import {
  SERVICE_CARRIER,
  carrierActive,
  carrierOfCampaign,
  carrierOptions,
  carrierRefusal,
  sameCarrier,
  type CarrierChoice,
} from '../../utils/agencyCarriers';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { SetupCard, StepCards } from '../../components/campaign-setup';
import { NameNumberStep } from '../campaigns/agency/setup/NameNumberStep';
import { PurposeButtonsStep } from '../campaigns/agency/setup/PurposeButtonsStep';
import { AgentsTimingStep } from '../campaigns/agency/setup/AgentsTimingStep';
import { staffingFailureMessage, useCampaignStaffing } from '../../hooks/useCampaignStaffing';
import { SETUP_STEPS, setupStepOfField, type SetupStepId } from '../../utils/campaignSetup/setupSteps';
import { isPurposePresetId, withPreset } from '../../utils/campaignSetup/purposePresets';
import {
  campaignSettingsSectionsFor,
  sectionIdOfHash,
  settingsTabOfChange,
} from '../../utils/campaignSettingsSections';
import { changedSettings, samePool, type CampaignSettingsForm } from '../../utils/campaignSettingsChanges';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { LeaveUnsavedDialog, UnsavedChangesBar } from '../../components/agency/UnsavedChangesBar';
import { plural } from '../../utils/format/number';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { isArchivedCampaign } from '../../utils/agencyCampaignArchive';
import { campaignEnding } from '../../utils/agencyCampaignControls';
import { CampaignHistory } from './campaign-detail/insights/CampaignFacts';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { CampaignWorkspaceFrame } from './campaign-detail/CampaignWorkspace';
import { useCampaignChrome } from './campaign-detail/useCampaignChrome';
import type { AgencyCampaign } from '../../types/agency-campaign';
import styles from './AgencyCampaignSettingsPage.module.css';

/**
 * Edit an existing campaign's configuration.
 *
 * **Editing a running campaign is deliberately allowed and not gated.** The
 * calling window is most often discovered to be wrong *while* the campaign is
 * dialing outside it, and forcing a pause to correct that would mean the fix
 * costs more than the fault. The API re-reads the campaign every pacing tick, so an
 * edit applies to future attempts; an attempt already dispatched keeps the
 * snapshot it was dialed with. The banner says so rather than leaving the
 * operator to guess whether the change took effect mid-run.
 *
 * ── The four steps, as tabs (CS1, `docs/campaign-setup.md`) ─────────────────
 * The page shows the same four steps New campaign walks through, as tabs under the campaign's
 * header and bar, each with the step's own component in edit mode:
 *  - **Name & number**: the name, the carrier (when there is a choice) and the caller IDs.
 *  - **Customers**: what agents see on the customer card (AS19), and the lifecycle and uploads.
 *  - **Purpose & buttons**: the outcome buttons, and the script beside what agents pick.
 *  - **Agents & timing**: who calls (staffed with the save, CS10), hours, retries, the agent
 *    screen's switches, and under Advanced the retry table, contact assignment, inbound callers
 *    and the break limits.
 * Every panel stays mounted (the others hidden), so a step keeps its own state across a tab
 * change and every section id is always on the page. The sections of `CAMPAIGN_SETTINGS_SECTIONS`
 * are the link targets: `…/settings#calling-hours` opens Agents & timing at it, opening Advanced
 * for one inside it (CS16).
 *
 * There is still one form and one Save: a bar stuck to the bottom of the view that shows only
 * while something is unsaved on any tab ("2 unsaved changes · Discard · Save changes", counted
 * by `changedSettings` and the staffing ticks). A tab holding a change shows a dot, a tab holding
 * a finding shows it needs fixing, and leaving the page with unsaved edits asks first
 * (`useUnsavedChangesGuard`).
 */
/**
 * The form's fields as a stored campaign has them: what a load or a save seeds. `columns`, the
 * roster's when known, opens the card of a campaign still on the old model (AS19) with what its
 * agents see today.
 */
function formOfCampaign(record: AgencyCampaign, columns: readonly string[] | null = null): CampaignSettingsForm {
  return {
    name: record.name,
    callerIds: record.caller_ids ?? [],
    carrier: carrierOfCampaign(record),
    recording: recordingStateFromCampaign(record),
    config: configFromCampaign(record),
    breakReasons: breakReasonsFormOf(record.break_reasons),
    station: stationSettingsOf(record, columns),
  };
}

/** The tabs' ids and their panels' (`StepCards` names the panels the same way). */
const TABS_ID = 'campaign-settings';
const panelId = (tab: SetupStepId) => `${TABS_ID}-panel-${tab}`;

/** Said in the staffing card to a reader whose role cannot read a campaign's staffing. */
const STAFFING_SUPERVISORS_ONLY = 'Who calls on this campaign is shown to supervisors only.';

export function AgencyCampaignSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const { tenantId, accountId, role } = useTenant();
  const { showToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  /** When `campaign` was last read or written: the header's "Updated" stamp. */
  const [campaignReadAt, setCampaignReadAt] = useState<Date | null>(null);
  /** The campaign at click time, for the header's lifecycle controls (`useCampaignChrome`). */
  const campaignRef = useRef<AgencyCampaign | null>(campaign);
  campaignRef.current = campaign;
  const [config, setConfig] = useState<CampaignConfigState | null>(null);
  const [name, setName] = useState('');
  const [callerIds, setCallerIds] = useState<string[]>([]);
  /** The carrier account the form holds; seeded from the campaign on load and save. */
  const [carrier, setCarrier] = useState<CarrierChoice>(SERVICE_CARRIER);
  const [recording, setRecording] = useState<CampaignRecordingState | null>(null);
  /** The break reasons' limits (Agents & timing › Advanced, LF27). */
  const [breakReasons, setBreakReasons] = useState<BreakReasonsForm | null>(null);
  /** The agent station's settings (the card, the script, the target and the number: AS6, AS9, BE-6, BE-8). */
  const [station, setStation] = useState<StationSettingsForm | null>(null);
  /** The form as last loaded or saved: what Discard puts back and the bar counts against. */
  const [saved, setSaved] = useState<CampaignSettingsForm | null>(null);
  /** Bumped by Discard, to remount the fields (the caller-ID picker prunes on a carrier change). */
  const [formEpoch, setFormEpoch] = useState(0);
  /**
   * Analytics-only: the disposition order as of the last load/save, to detect
   * whether the row arrows moved anything before the next save. Re-seeded
   * alongside `config` itself (on load AND after a successful save) so the
   * comparison is always against what the form currently BELIEVES is saved.
   */
  const dispositionOrderRef = useRef<string[] | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  /**
   * "Reset to defaults" was pressed with the flag off: the form holds the defaults
   * and no overrides, and the next save SENDS them (the server lets a default
   * through with the flag off). Cleared by a successful save or a reload.
   */
  const [assignmentResetPending, setAssignmentResetPending] = useState(false);

  /** The tab on screen. */
  const [tab, setTab] = useState<SetupStepId>('basics');

  const canEdit = hasPermission(role, 'agency.campaigns.write');
  // The sections a supervisor's reads fill (who calls, the upload history).
  const canSupervise = hasPermission(role, 'agency.supervise');
  // Contact assignment's settings and outcome overrides: shown and sent only while
  // the flag is on (the server refuses a non-default value with it off).
  const assignmentEnabled = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);
  const inboundEnabled = useFeatureFlagEnabled(INBOUND_FLAG);
  // Read by every viewer (`agency.campaigns.read`): an editor chooses from it, and a
  // read-only viewer is told which carrier account the campaign dials on.
  const { carriers } = useAgencyCarriers();

  /*
    Who calls (CS10). The reads floor at `agency.supervise`, so a role below it reads none. The
    ticks are staged here (`null` while untouched: the server's list is what shows) and applied
    with the save bar, after the PATCH (`applyStaffing`).
  */
  const staffing = useCampaignStaffing(canSupervise && id ? id : null, canSupervise);
  const [staffingTicks, setStaffingTicks] = useState<string[] | null>(null);
  /** The ticks that could not be applied by the last save (`staffingFailureMessage`). */
  const [staffingError, setStaffingError] = useState<string | null>(null);
  const staffingSelected = staffingTicks ?? staffing.assignedIds;
  const staffingChanged = canSupervise && staffingTicks !== null && !samePool(staffingTicks, staffing.assignedIds);

  // L1 (UX) gating only — the server's 403 is the real enforcement, and
  // `useGovernance` fails OPEN, so a missing/failed map leaves both controls
  // fully usable and the server has the last word. `RequireCapability` is
  // deliberately NOT used: it is a route guard that renders a full-page
  // "unavailable" screen, which is the wrong answer for a single field.
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const recordingEnabled = isCapabilityEnabled(AGENCY_RECORDING_CAPABILITY);
  const analyticsEnabled = isCapabilityEnabled(AGENCY_ANALYTICS_CAPABILITY);
  // The profile list is gated on a permission only, so `agency.analytics` alone
  // decides — see `utils/agencyCampaignRecording.ts`.
  const {
    profiles: analysisProfiles,
    loading: profilesLoading,
    error: profilesError,
  } = useCallAnalysisProfiles({ enabled: analyticsEnabled });

  // Fire once per mount per gate, not on every render — these mirror
  // `RequireCapability`'s own pattern for the same event.
  useEffect(() => {
    if (recordingEnabled) return;
    trackFeatureGateUnavailable({ gate_type: 'capability', gate: AGENCY_RECORDING_CAPABILITY });
  }, [recordingEnabled]);

  useEffect(() => {
    if (analyticsEnabled) return;
    trackFeatureGateUnavailable({ gate_type: 'capability', gate: AGENCY_ANALYTICS_CAPABILITY });
  }, [analyticsEnabled]);

  /** Fill every field from `form`, and make it what is saved (the bar's baseline). */
  const seedForm = useCallback((form: CampaignSettingsForm) => {
    setSaved(form);
    setConfig(form.config);
    dispositionOrderRef.current = form.config.dispositions.map((d) => d.code);
    setName(form.name);
    setCallerIds([...form.callerIds]);
    setCarrier(form.carrier);
    setRecording(form.recording);
    setBreakReasons(form.breakReasons ?? null);
    setStation(form.station ?? null);
    setAssignmentResetPending(false);
  }, []);

  /*
    Stale answers. The route has no `key`, so moving to another campaign's Settings keeps this
    page mounted, and an answer can land after the move: `routeIdRef` is the campaign the URL
    names now, and nothing for another one is painted. `readTokenRef` orders the campaign row's
    reads and writes as `useAgencyCampaignDetail`'s `loadTokenRef` does: bumped when a read
    starts and on every commit, so a Refresh (or a lifecycle re-read) sent before a Pause, a Stop
    or a Save cannot land after it and paint the older row. `loadSeqRef` is the full load's own
    order: only the newest one seeds the form and ends the spinner.
  */
  const routeIdRef = useRef(id);
  routeIdRef.current = id;
  /** The roster's columns once read (null until then): a load or a save opens an old-model card from them. */
  const knownColumnsRef = useRef<readonly string[] | null>(null);
  const readTokenRef = useRef(0);
  const loadSeqRef = useRef(0);

  /**
   * Hold `record` as the campaign: state, the ref the lifecycle controls read, and the "Updated"
   * stamp. Fences off every older read. A record for a campaign the URL no longer names (a write
   * that answered after the move) is dropped; false then.
   */
  const commitCampaign = useCallback((record: AgencyCampaign): boolean => {
    if (record.id !== routeIdRef.current) return false;
    readTokenRef.current += 1;
    campaignRef.current = record;
    setCampaign(record);
    setCampaignReadAt(new Date());
    return true;
  }, []);

  const load = useCallback(async () => {
    if (!id || !tenantId || !accountId) return;
    const seq = ++loadSeqRef.current;
    readTokenRef.current += 1;
    setLoading(true);
    setLoadError(null);
    // Another campaign's ticks are not this one's.
    setStaffingTicks(null);
    setStaffingError(null);
    try {
      const record = await getAgencyCampaign(id, tenantId, accountId);
      if (seq !== loadSeqRef.current) return;
      if (commitCampaign(record)) seedForm(formOfCampaign(record, knownColumnsRef.current));
    } catch (err: unknown) {
      if (seq !== loadSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : 'Could not load this campaign.');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [id, tenantId, accountId, seedForm, commitCampaign]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
    The header's reads and writes: the campaign row only, never the form. A lifecycle
    action or the header's Refresh must not throw away edits in progress, so they update
    `campaign` (the status, and what a save compares against) and leave the fields alone.
  */
  const refreshCampaign = useCallback(async (): Promise<AgencyCampaign | null> => {
    if (!id || !tenantId || !accountId) return null;
    const token = ++readTokenRef.current;
    try {
      const record = await getAgencyCampaign(id, tenantId, accountId);
      // A newer read or a write owns the paint, or the URL names another campaign now.
      if (token !== readTokenRef.current || !commitCampaign(record)) return campaignRef.current;
      return record;
    } catch {
      return campaignRef.current;
    }
  }, [id, tenantId, accountId, commitCampaign]);

  /*
    The header, its lifecycle controls, Retry contacts and the dialogs they open, through the
    gates every campaign screen shares (`useCampaignChrome`). Its source is this page's own read
    of the campaign row: no stats (so no health strip), and a lifecycle action or the header's
    Refresh re-reads the row alone, never the form.
  */
  const chrome = useCampaignChrome({
    campaignId: id,
    active: 'settings',
    detail: {
      campaign,
      lastUpdatedAt: campaignReadAt,
      campaignRef,
      refreshCampaign,
      commitCampaign,
      load: refreshCampaign,
    },
  });

  /*
    The customer list's columns, for the card's pickers: read by an editor only (`agency.supervise`
    floors the read), once THIS campaign is loaded, so its lineage root is known at the one read.
    A few customers' rows beside them, for the samples and the script's preview.
  */
  const hidden = useMemo(() => hiddenColumns(campaign?.context_display), [campaign?.context_display]);
  const columnsEnabled = canEdit && canSupervise && campaign?.id === id;
  const imported = useCampaignColumns(id, campaign?.root_campaign_id ?? null, tenantId, accountId, columnsEnabled);
  const samples = useCampaignSampleRows(id, tenantId, accountId, columnsEnabled);
  const columnsRead: ColumnsRead = !columnsEnabled ? 'done' : imported.failed ? 'failed' : imported.ready ? 'done' : 'loading';
  /*
    S9: a card on the old model is opened from the columns, so until they are read it is not shown
    ("Loading…", or the failure with "Try again") and a save that would send it is held.
  */
  const cardWaiting = canEdit && campaign !== null && isLegacyDisplay(campaign.context_display) && columnsRead !== 'done'
    ? (columnsRead === 'failed' ? COLUMNS_FAILED_MESSAGE : COLUMNS_LOADING_MESSAGE)
    : null;
  // The columns the card's selects offer (the roster's first): the guesses a save writes read them.
  const selectColumns = useMemo(
    () => (station ? campaignColumns(imported.columns, campaign?.context_display, station.facts) : []),
    [imported.columns, campaign?.context_display, station],
  );
  // "The latest upload" is the newest import alone (S9): what a fact is added from and checked against.
  const factsContext = useMemo(
    () => ({ hidden, uploaded: imported.latest, columns: selectColumns, cardWaiting }),
    [hidden, imported.latest, selectColumns, cardWaiting],
  );
  knownColumnsRef.current = imported.ready ? imported.columns : null;

  /*
    AS19: a campaign still on the old model opens its card with what its agents see today, which
    needs the roster's columns (the hero guess and the name guess read them). They arrive after the
    campaign: once they do, an untouched card is opened again from them, as saved and on screen
    alike, so it counts as no change. Until then the card is not shown (S9).
  */
  useEffect(() => {
    const columnsNow = knownColumnsRef.current;
    if (!columnsNow || !campaign || !isLegacyDisplay(campaign.context_display)) return;
    if (!station || !saved?.station || factsChanged(saved.station.facts, station.facts)) return;
    const facts = factsFormOf(campaign.context_display, columnsNow);
    if (!factsChanged(station.facts, facts)) return;
    setSaved({ ...saved, station: { ...saved.station, facts } });
    setStation({ ...station, facts });
  }, [imported.ready, imported.columns, campaign, station, saved]);

  /*
    The sections this campaign's page has, in page order, each with its tab, by the rule search
    reads too (`campaignSettingsSectionsFor`).
  */
  const sections = useMemo(() => campaignSettingsSectionsFor({ canSupervise }), [canSupervise]);
  const historyVisible = sections.some((section) => section.id === 'roster-uploads');

  /* ── Tabs, links into them, and going to a finding ────────────────────── */

  const tabRef = useRef(tab);
  tabRef.current = tab;
  const { pathname, search, hash } = location;

  /** Show `next`. A hash naming a section of another tab no longer says where the page is: it goes. */
  const showTab = useCallback(
    (next: SetupStepId) => {
      setTab(next);
      if (next !== tabRef.current && hash) navigate({ pathname, search }, { replace: true });
    },
    [navigate, pathname, search, hash],
  );

  /** The element a link landed on, scrolled to once its tab (and its fold) is open. */
  const [scrollTarget, setScrollTarget] = useState<{ id: string } | null>(null);
  /** Opens Agents & timing's Advanced for one render (the step keeps it open): a link landed inside it. */
  const [advancedPulse, setAdvancedPulse] = useState(false);
  /** The navigation (its location) last opened at its section, or found to name none. */
  const handledLocation = useRef<typeof location | null>(null);
  /*
    Ready once THIS campaign's tabs are on the page: not while a jump from another campaign's
    settings is still loading this one (the old campaign is in state until then).
  */
  const ready = !loading && campaign?.id === id && Boolean(config && recording && station);

  /*
    Arrival at `#id` (CS16): once per navigation, as soon as the tabs exist. React-router keeps
    this page's instance across `…/settings#a` → `…/settings#b` and across campaigns (search jumps
    there), and hands out a new location for each navigation, including a fragment typed into the
    address bar, so each is handled once, by its location.
  */
  useEffect(() => {
    if (!ready || handledLocation.current === location) return;
    handledLocation.current = location;
    const section = sections.find((s) => s.id === sectionIdOfHash(location.hash));
    if (!section) return;
    setTab(section.tab);
    if (section.advanced) setAdvancedPulse(true);
    setScrollTarget({ id: section.id });
  }, [ready, location, sections]);

  useEffect(() => {
    if (scrollTarget) document.getElementById(scrollTarget.id)?.scrollIntoView?.({ block: 'start' });
  }, [scrollTarget]);

  useEffect(() => {
    if (advancedPulse) setAdvancedPulse(false);
  }, [advancedPulse]);

  /** A tab whose first field with a finding takes focus, once it is on screen. */
  const [focusRequest, setFocusRequest] = useState<{ tab: SetupStepId } | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const panel = document.getElementById(panelId(focusRequest.tab));
    if (panel) focusFirstFieldError(panel);
  }, [focusRequest]);

  /**
   * Take the person to a finding, as New campaign's goToFinding does: the tab on screen when it
   * holds one, else the first tab that does, then its first field with a finding takes focus.
   */
  const goToFinding = useCallback(
    (fields: readonly string[]) => {
      const tabs = new Set(fields.map(setupStepOfField));
      const target = tabs.has(tabRef.current) ? tabRef.current : SETUP_STEPS.find((step) => tabs.has(step.id))?.id;
      if (!target) return;
      showTab(target);
      setFocusRequest({ tab: target });
    },
    [showTab],
  );

  /* ── Saving ─────────────────────────────────────────────────────────────── */

  const onSave = useCallback(async () => {
    if (!id || !config || !recording) return;
    if (configBlockReason(config) !== null) {
      /*
        The Save control is already disabled while this is non-null, so reaching
        here means a keyboard or programmatic submit. The findings are already on
        their fields: each step shows `validateConfig` live. They are not copied
        into `fieldErrors`, which holds the server's answer and wins over a live
        finding, so a copy would keep a field red after it was fixed.
      */
      const errors = validateConfig(config);
      trackAgencyCampaignConfigBlocked({
        source: 'settings',
        field_error_count: Object.keys(errors).length,
      });
      goToFinding(Object.keys(errors));
      return;
    }
    // Save is held while either is missing (`missingBasics`), so this is a keyboard or
    // programmatic submit: say so on the field all the same.
    const missing = missingBasics(name, callerIds);
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      goToFinding(Object.keys(missing));
      return;
    }
    // A break limit the rule refuses is said on its row as it is typed, and holds Save the same way.
    if (breakReasons && Object.keys(breakReasonsErrors(breakReasons)).length > 0) {
      goToFinding(['break_reasons']);
      return;
    }
    // The same for the station's settings (a target, the script, the facts), said on their fields.
    if (station && saved?.station) {
      const stationFindings = stationErrors(saved.station, station, campaign?.context_display, factsContext);
      if (Object.keys(stationFindings).length > 0) {
        goToFinding(Object.keys(stationFindings));
        return;
      }
    }

    setSaving(true);
    setSaveError(null);
    setStaffingError(null);
    setFieldErrors({});
    // Built before the request so the refusal mapper can tell a 404 that means
    // "your profile is gone" from any other 404 — the server masks the dialer runtime's body, so
    // what we sent is the only evidence left (see `campaignSaveRefusal`).
    const recordingFields = recordingPayload({ recordingEnabled, analyticsEnabled, next: recording });
    // The mode is locked (and so unchanged) unless the LOADED campaign is draft or paused.
    const modeLocked = assignmentModeLocked(campaign?.status);
    // With the flag off nothing is sent (the stored values ride along unchanged),
    // unless a reset is pending: then the defaults are sent, the mode too when it
    // may change.
    const assignmentScope: AssignmentPayloadScope = !assignmentEnabled && !assignmentResetPending
      ? 'none'
      : modeLocked ? 'settings_only' : 'all';
    /*
      The carrier account is sent only when it moves, or when the stored record names
      none (an older campaign, pinned to the service's own account as before). Naming it
      makes the server re-check the account, so a campaign whose account was disabled
      after it was set up could otherwise not have its calling window fixed until it was
      moved. Moving back to the service's account sends `telephony_credential_id: null`
      with the carrier, in the same PATCH.

      "Moves" is against `saved`, the form as last loaded or saved (what the bar counts
      against), never against `campaign`: Refresh and the lifecycle controls re-read
      `campaign` and leave the form alone, so after someone else changes the carrier or the
      pool, the untouched form differs from `campaign` and would send the older values back,
      undoing their change while the bar said nothing was unsaved.
    */
    const sendCarrier = !campaign?.telephony_provider
      || !saved
      || !sameCarrier(carrier, saved.carrier);
    /*
      The caller IDs likewise go only when they changed (or the carrier moves, which
      re-judges the pool). A stored number since retired or untagged would otherwise be
      resent with every rename; the server keeps it (PL13), but there is nothing to write.
    */
    const sendCallerIds = sendCarrier || !saved || !samePool(callerIds, saved.callerIds);
    // The name the same way: an untouched name is not sent back over a newer one.
    const trimmedName = name.trim();
    const sendName = !saved || trimmedName !== saved.name;
    /*
      The break reasons only when a limit changed (LF27): the list is replaced whole, so an
      untouched one is not sent back over someone else's newer edit, and a campaign on the
      built-ins keeps them (served at read time, never written) until a limit is set.
    */
    const sendBreakReasons = breakReasons !== null
      && saved?.breakReasons !== undefined
      && !sameBreakLimits(saved.breakReasons, breakReasons);
    // The card's columns as its selects offer them: a name left on "Guess from the column names" is
    // saved as the column the select names (AS19 R1), so it stays a hero once the card has facts.
    const stationSent = station && saved?.station
      ? stationPayload(saved.station, station, campaign?.context_display, selectColumns)
      : {};
    // The ticks as they were when Save was pressed: what the save applies.
    const ticksToApply = staffingChanged ? staffingTicks : null;
    try {
      // The name is not part of `buildConfigPayload` — that builds the behaviour
      // block. Merged into one PATCH so a rename and a window change are one
      // write, and cannot half-apply.
      //
      // There is no `description` here, and the re-seed below is why its absence
      // matters more than it looks: the API stores no such column, so the field came
      // back empty from the very save that reported success and the form wiped
      // itself in front of the operator.
      const updated = await updateAgencyCampaign(
        id,
        {
          ...buildConfigPayload(config, assignmentScope),
          ...recordingFields,
          ...(sendName ? { name: trimmedName } : {}),
          ...(sendBreakReasons ? { break_reasons: breakReasonsPayload(breakReasons) } : {}),
          /*
            The station's settings only where they changed against `saved` (as the break reasons):
            an untouched script or target is never sent back over someone else's newer edit. The
            facts are merged into the campaign's `context_display` as last read, whose hero, order
            and hidden columns the roster import sets (a PATCH replaces the object whole).
          */
          ...stationSent,
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
      // Saved for a campaign the URL no longer names: nothing of it belongs on this form.
      if (!commitCampaign(updated)) return;
      // Computed against what was ABOUT TO BE SAVED, before the re-seed below
      // replaces `config` with whatever the server normalised it to.
      const priorOrder = dispositionOrderRef.current;
      const nextOrder = config.dispositions.map((d) => d.code);
      const reordered =
        priorOrder !== null &&
        (priorOrder.length !== nextOrder.length ||
          priorOrder.some((code, i) => code !== nextOrder[i]));
      // Re-seed EVERY field from what came back, not from what was sent. The server
      // normalises some values, and leaving the form showing the submitted
      // version would hide a difference the next save would then re-submit.
      // Re-seeding the config alone is the subtle version of the same bug: the
      // window would correct itself while the name silently kept the local
      // value.
      seedForm(formOfCampaign(updated, knownColumnsRef.current));
      trackAgencyCampaignConfigSaved({
        campaign_id: id,
        source: 'settings',
        disposition_count: config.dispositions.length,
        custom_disposition_count: config.dispositions.filter((d) => !isBuiltInCode(d.code)).length,
        suppress_and_terminal_pairs: config.dispositions.filter((d) => d.suppress && d.terminal)
          .length,
        disposition_retry_rule_count: config.dispositions.filter((d) => d.retry != null).length,
        retry_policy_outcome_count: Object.keys(config.retryPolicy).length,
        wrapup_seconds: config.wrapupSeconds,
        auto_return: config.autoReturn,
        wrapup_redial: config.allowWrapupRedial,
        abandonment_ceiling_pct: config.abandonmentCeilingPct,
        ...(assignmentEnabled ? assignmentAnalytics(config) : {}),
        recording_enabled: recording.record,
        analysis_profile_set: resolveProfileId(recording.profileId) !== null,
        reordered,
      });
      /*
        Who calls (CS10), once the campaign's settings are written: each tick assigned or taken
        off with the campaign page's own routes. One that fails stays ticked here and unsaved,
        and is named above the tabs; the others are applied.
      */
      let staffingFailed: string | null = null;
      if (ticksToApply) {
        const result = await staffing.applyStaffing(id, ticksToApply);
        if (id !== routeIdRef.current) return;
        staffingFailed = staffingFailureMessage(result);
        if (staffingFailed) setStaffingError(`The other changes are saved. ${staffingFailed}`);
        else setStaffingTicks(null);
      }
      if (!staffingFailed) {
        // AS19 S8: the script, its keys and the card reach agents with their station's bootstrap.
        showToast(
          stationSent.agent_script !== undefined || stationSent.context_display !== undefined
            ? 'Saved. Agents see this when they next start work.'
            : 'Campaign settings saved.',
          'success',
        );
      }
    } catch (err: unknown) {
      // Refused for a campaign the URL no longer names: not this form's error.
      if (id !== routeIdRef.current) return;
      // Checked BEFORE the field-error map: a `capability_disabled` 403 carries
      // no `details`, so `fieldErrorsFromResponse` would return `{}` and the
      // banner would show the bare wire token `capability_disabled`.
      const refusal = campaignSaveRefusal(err, {
        sentAnalysisProfile: payloadSetsProfile(recordingFields),
      });
      if (refusal !== null) {
        setSaveError(refusal);
        return;
      }
      const carrierRefused = carrierRefusal(err);
      if (carrierRefused !== null) {
        setSaveError(carrierRefused);
        return;
      }
      // The campaign started between the load and the save, so its mode is locked
      // now. Said on the field rather than as a bare 409; the operator's other
      // edits stay on screen.
      if (errorCode(err) === 'mode_change_requires_pause') {
        setFieldErrors({ assignment_mode: ASSIGNMENT_REFUSAL_COPY.mode_change_requires_pause });
        goToFinding(['assignment_mode']);
        return;
      }
      // The new caller IDs drop a number dedicated to an agent (409
      // `caller_id_dedicated`). Said on the field, naming the numbers: its
      // `details.caller_ids` is a list, not the per-field map
      // `fieldErrorsFromResponse` reads.
      const dedicated = dedicatedCallerIdsOf(err);
      if (dedicated !== null) {
        setFieldErrors({ caller_ids: callerIdDedicatedMessage(dedicated) });
        goToFinding(['caller_ids']);
        return;
      }
      // The server answers `{ details: { field: message } }` keyed by the body path,
      // so the message lands on the field that caused it, and its tab comes forward.
      const mapped = fieldErrorsFromResponse(err);
      if (Object.keys(mapped).length > 0) {
        setFieldErrors(mapped);
        goToFinding(Object.keys(mapped));
      } else {
        setSaveError(err instanceof Error ? err.message : 'Could not save the campaign.');
      }
    } finally {
      setSaving(false);
    }
  }, [
    id, config, name, callerIds, carrier, recording, recordingEnabled, analyticsEnabled,
    tenantId, accountId, showToast, assignmentEnabled, campaign, saved, assignmentResetPending, seedForm, commitCampaign,
    breakReasons, station, factsContext, selectColumns, staffing, staffingChanged, staffingTicks, goToFinding,
  ]);

  /** Put back what is saved: every field and tick, and no error left from the edits. */
  const onDiscard = useCallback(() => {
    if (!saved) return;
    seedForm(saved);
    setStaffingTicks(null);
    setStaffingError(null);
    setFieldErrors({});
    setSaveError(null);
    setFormEpoch((n) => n + 1);
  }, [saved, seedForm]);

  /*
    Contact assignment settings left from before the flag went off: a notice with their reset, at
    the top of Agents & timing.
  */
  const assignmentLeftovers = campaign && !assignmentEnabled ? storedAssignmentLeftovers(campaign) : [];
  useCampaignCrumbs(id, campaign, 'settings');

  /* What is unsaved, setting by setting; it drives the bar, the tabs' dots and the guard on leaving. */
  const changes = useMemo(
    () => (saved && config && recording
      ? [
        ...changedSettings(saved, {
          name, callerIds, carrier, recording, config,
          ...(breakReasons ? { breakReasons } : {}),
          ...(station ? { station } : {}),
        }),
        ...(staffingChanged ? ['staffing'] : []),
      ]
      : []),
    [saved, name, callerIds, carrier, recording, config, breakReasons, station, staffingChanged],
  );
  const unsavedTabs = useMemo(() => new Set(changes.map(settingsTabOfChange)), [changes]);

  /*
    The station's settings (the card, the script, the target and the number). Their findings as
    typed hold Save and are said on their fields, quietly, ahead of the server's answer to the last
    save (which is about what was sent, and may be fixed since), as the break limits do.
  */
  const stationLive = useMemo(
    () => (canEdit && station && saved?.station ? stationErrors(saved.station, station, campaign?.context_display, factsContext) : {}),
    [canEdit, station, saved, campaign?.context_display, factsContext],
  );
  /*
    The card's findings are said on their rows whether or not they hold Save (a fact whose column a
    newer upload dropped is shown even while only the target changes); only those of a card that is
    sent hold it (`stationLive`).
  */
  const factsShown = useMemo(
    () => (canEdit && station ? factsErrors(station.facts, factsContext) : {}),
    [canEdit, station, factsContext],
  );
  const stationFieldErrors = useMemo(
    () => ({ ...fieldErrors, ...factsShown, ...stationLive }),
    [fieldErrors, factsShown, stationLive],
  );
  const stationQuiet = useMemo(
    () => new Set([...Object.keys(factsShown), ...Object.keys(stationLive)]),
    [factsShown, stationLive],
  );
  const stationErrorsView = useConfigFieldErrors(stationFieldErrors, stationQuiet);
  const plan = useMemo(
    () => (station && saved?.station ? stationPlan(saved.station, station, campaign?.context_display) : null),
    [station, saved, campaign?.context_display],
  );
  const removedInUse = useMemo(
    () => (station && saved?.station ? removedFactsInUse(saved.station.facts, station.facts, station.script) : []),
    [station, saved],
  );

  /** The fact row the editor focuses and announces after a change made from elsewhere (S9). */
  const [factFocus, setFactFocus] = useState<FactFocusRequest | null>(null);

  /**
   * The card as edited. A change of the facts' order (a move, an add, a removal) clears the
   * server's answer keyed by a fact's place, which now names another fact (S9).
   */
  const onFactsChange = useCallback((facts: FactsForm) => {
    if (!station) return;
    if (factsReordered(station.facts.list, facts.list)) setFieldErrors((errors) => withoutPlacedFactErrors(errors));
    setStation({ ...station, facts });
  }, [station]);

  /*
    The script (Purpose & buttons) and the card (Customers) are on different tabs. A fact the
    script's fix row puts back or adds takes focus on its card row, and is said there (S9), so the
    card's tab comes forward with it.
  */
  /** Put a saved fact the script uses back on the card; its row takes focus, and it is said. */
  const onPutBack = useCallback((key: string) => {
    if (!station || !saved?.station) return;
    const list = putBack(saved.station.facts, station.facts, key);
    const fact = list?.find((f) => f.key === key);
    if (!list || !fact) return;
    onFactsChange({ ...station.facts, list });
    showTab('contacts');
    setFactFocus({ key, part: 'grip', said: `${fact.label.trim() || fact.column} put back on the card.` });
  }, [station, saved, onFactsChange, showTab]);

  /**
   * The script's "Add … as a fact": `column` goes on the card with the script's word as its key
   * when that word may be one, else the default key, and the script's `token` follows it.
   */
  const onAddFact = useCallback((column: string, token: string) => {
    if (!station || station.facts.list.length >= AGENCY_FACT_FIELDS_MAX) return;
    const list = station.facts.list;
    const taken = list.map((f) => f.key);
    const word = token.slice(1, -1).trim();
    const fits = AGENCY_FACT_KEY_PATTERN.test(word) && word.length <= AGENCY_FACT_KEY_MAX_CHARS
      && !taken.includes(word) && !(AGENCY_SCRIPT_FIXED_PLACEHOLDERS as readonly string[]).includes(word);
    const fact = { ...newFact(column, list), key: fits ? word : factKeyFromColumn(column, taken) };
    setFieldErrors((errors) => withoutPlacedFactErrors(errors));
    setStation({
      ...station,
      facts: { ...station.facts, list: [...list, fact] },
      script: token === `{${fact.key}}` ? station.script : replaceToken(station.script, token, `{${fact.key}}`),
    });
    // S9: the new fact's name takes focus (to rename it), and the add is said.
    showTab('contacts');
    setFactFocus({ key: fact.key, part: 'label', said: `${fact.label.trim() || column} added to the card.` });
  }, [station, showTab]);
  const leaveGuard = useUnsavedChangesGuard(canEdit && changes.length > 0);

  if (loading) return <LoadingSpinner />;
  if (loadError && !campaign) return <ErrorAlert message={loadError} onRetry={() => void load()} />;
  if (!campaign || !config || !recording || !station) return null;

  const block = configBlockReason(config);
  // A name or caller ID taken away is said on its field as soon as it happens, and holds Save,
  // as a calling-hours mistake does.
  const missing = canEdit ? missingBasics(name, callerIds) : {};
  const breakLimitsInvalid = canEdit && breakReasons !== null && Object.keys(breakReasonsErrors(breakReasons)).length > 0;
  const nameError = missing['name'] ?? fieldErrors['name'];
  const callerIdsError = missing['caller_ids'] ?? fieldErrors['caller_ids'];
  const stationInvalid = Object.keys(stationLive).length > 0;
  const saveBlock = block ?? (Object.keys(missing).length > 0 || breakLimitsInvalid || stationInvalid ? 'invalid_fields' : null);
  /** What holds Save now, by field: where "Show me" goes. */
  const holding = [
    ...Object.keys(canEdit ? validateConfig(config) : {}),
    ...Object.keys(missing),
    ...Object.keys(stationLive),
    ...(breakLimitsInvalid ? ['break_reasons'] : []),
  ];
  /** The tabs holding a finding: what holds Save, what is said on a fact's row, and the server's answer. */
  const invalidTabs = new Set([...holding, ...Object.keys(factsShown), ...Object.keys(fieldErrors)].map(setupStepOfField));
  /*
    Contact assignment turned off after a campaign was set up with it: pacing still
    follows what the campaign stores (CA9 gates the surface, never the runtime), and
    with the settings hidden there was no way back. Keyed on the LOADED campaign,
    so the notice stays until the reset is saved (`assignmentLeftovers`, above).
  */
  const modeResetBlocked = assignmentModeLocked(campaign.status)
    && (campaign.assignment_mode ?? 'pool') !== 'pool';
  const isLive = campaign.status === 'running' || campaign.status === 'stopping';
  // Every listed carrier account, plus the campaign's own when the list no longer has
  // it (disabled or revoked): shown as it is rather than silently swapped on save.
  // Offered only when there is a choice to make.
  const carrierChoices = carriers ? carrierOptions(carriers, carrierOfCampaign(campaign)) : [];
  const carrierLabel = carriers?.find((c) => sameCarrier(c, carrier))?.label ?? null;
  // Add contacts as the header offers it: not on an archived campaign (AR7), nor on an ended one.
  const canAddContacts = canEdit && !isArchivedCampaign(campaign) && campaignEnding(campaign.status) === null;

  const panel = (step: SetupStepId) => ({
    role: 'tabpanel' as const,
    id: panelId(step),
    'aria-labelledby': `${TABS_ID}-tab-${step}`,
    hidden: tab !== step,
    tabIndex: 0,
    className: styles.panel,
    'data-testid': panelId(step),
  });

  return (
    /*
      The frame every campaign screen shares, so the header and the tab bar sit where
      they do on the Monitor tabs. No health strip: this page reads no stats.
    */
    <CampaignWorkspaceFrame
      /*
        The campaign's own header, as on its Monitor tabs: its name and status, the
        lifecycle controls (pausing before an assignment-mode change is said below, so
        it belongs here), Retry contacts and History — "who changed the caller ID?" is asked here.
      */
      header={chrome.header}
      tabs={
        <CampaignTabs
          campaignId={campaign.id}
          active="settings"
          role={role}
          campaignStatus={campaign.status}
        />
      }
    >
      <div className={styles.page}>
        {isLive && (
          <p className={styles.liveNote}>
            This campaign is dialling. Changes apply to calls placed from now on — a call already
            under way keeps the settings it started with.
          </p>
        )}

        {saveError && <ErrorAlert message={saveError} />}
        {staffingError && (
          <div data-testid="staffing-error">
            <ErrorAlert message={staffingError} />
          </div>
        )}

        {/* The template it was made from, and "Save as template…" (campaign templates; nothing with the flag off). */}
        <CampaignTemplateSource campaign={campaign} />

        <StepCards
          mode="tabs"
          idPrefix={TABS_ID}
          label="Campaign settings"
          steps={SETUP_STEPS}
          current={tab}
          onSelect={(next) => showTab(next as SetupStepId)}
          invalid={invalidTabs}
          unsaved={canEdit ? unsavedTabs : undefined}
        />

        {/* Remounted by Discard, so no field keeps state from the edits it threw away. */}
        <Fragment key={formEpoch}>
          <div {...panel('basics')}>
            <NameNumberStep
              mode="edit"
              name={name}
              onName={setName}
              nameError={nameError ?? null}
              carrierChoices={carrierChoices}
              carrier={carrier}
              onCarrier={setCarrier}
              carrierError={fieldErrors['telephony_credential_id'] ?? fieldErrors['telephony_provider']}
              carrierLabel={carrierLabel}
              carrierActive={carrierActive(carriers, carrier)}
              callerIds={callerIds}
              onCallerIds={setCallerIds}
              callerIdsError={callerIdsError ?? null}
              readOnly={!canEdit}
              anchors={{ card: 'general', numbers: 'caller-ids' }}
            />
          </div>

          <div {...panel('contacts')}>
            <SetupCard
              id="agent-screen"
              title="What agents see on the customer card"
              helper="Which columns of the customer list agents see about each customer, and what each is called."
              testId="customer-card"
            >
              <CustomerFactsEditor
                value={station.facts}
                onChange={onFactsChange}
                columns={selectColumns}
                uploaded={imported.latest}
                hidden={hidden}
                columnsRead={columnsRead}
                onRetryColumns={imported.reload}
                waitForColumns={cardWaiting !== null}
                errors={stationErrorsView}
                samples={samples}
                phoneDisplay={station.phoneDisplay}
                removedInUse={removedInUse}
                onPutBack={onPutBack}
                focusRequest={factFocus}
                readOnly={!canEdit}
              />
            </SetupCard>
            {/*
              The lifecycle and the upload history (decision IN13): they are about how this
              campaign was set up and run, so they live with its settings. Both reads are floored
              at `agency.supervise`, so a role below it is not shown a pair of 403s.
            */}
            {historyVisible ? (
              <SetupCard
                id="roster-uploads"
                title="Lifecycle and uploads"
                helper="When this campaign started, paused and stopped, and each customer list uploaded to it."
                testId="lifecycle-uploads"
                actions={canAddContacts ? (
                  <Link
                    to={`/agency/campaigns/${campaign.id}/contacts/add`}
                    className="btn-secondary"
                    data-testid="settings-add-contacts"
                  >
                    Add customers
                  </Link>
                ) : null}
              >
                <CampaignHistory campaignId={campaign.id} />
              </SetupCard>
            ) : null}
          </div>

          <div {...panel('purpose')}>
            <div id="wrap-up" className={styles.anchor}>
              <PurposeButtonsStep
                mode="edit"
                config={config}
                onChange={setConfig}
                fieldErrors={fieldErrors}
                overrides={assignmentEnabled}
                // A new starting point replaces the buttons: it is not a reorder of the old ones.
                onPresetApplied={(presetId) => {
                  if (!isPurposePresetId(presetId)) return;
                  dispositionOrderRef.current = withPreset(config, presetId).dispositions.map((d) => d.code);
                }}
              />
            </div>
            <SetupCard
              id="script"
              title="Script"
              helper="What agents say on a call, step by step, beside the buttons they pick. A change reaches agents the next time they start work."
              testId="script-card"
            >
              <ScriptEditor
                value={station.script}
                onChange={(script) => setStation({ ...station, script })}
                errors={stationErrorsView}
                readOnly={!canEdit}
                facts={station.facts}
                offered={plan?.offered ?? []}
                allowed={plan?.allowed ?? []}
                columns={selectColumns}
                uploaded={imported.latest}
                hidden={hidden}
                samples={samples}
                phoneDisplay={station.phoneDisplay}
                campaignName={name}
                removedInUse={removedInUse}
                onPutBack={onPutBack}
                onAddFact={onAddFact}
                // R5: until the card is saved here, agents read the script as on the old model.
                legacy={isLegacyDisplay(campaign.context_display) && !plan?.displaySent}
              />
            </SetupCard>
          </div>

          <div {...panel('agents')}>
            {assignmentLeftovers.length > 0 && (
              <div className={styles.liveNote} role="note" data-testid="assignment-off-notice">
                <p>
                  {`Contact assignment is turned off for this account, but this campaign still uses ${joinAnd(assignmentLeftovers)}. Dialling keeps following them until they are reset.`}
                </p>
                {modeResetBlocked && (
                  <p data-testid="assignment-reset-pause">
                    Its assignment mode can change only while the campaign is paused or a draft: pause
                    it first to put the mode back to the shared pool. A reset now puts back everything else.
                  </p>
                )}
                {fieldErrors['assignment_mode'] && (
                  <p className={styles.fieldError} data-field-error>{fieldErrors['assignment_mode']}</p>
                )}
                {canEdit && (assignmentResetPending ? (
                  <p data-testid="assignment-reset-pending">
                    Contact assignment goes back to the defaults, and every outcome override is removed,
                    when you save.
                  </p>
                ) : (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      setConfig(resetAssignmentConfig(config));
                      setAssignmentResetPending(true);
                    }}
                    data-testid="assignment-reset"
                  >
                    Reset to defaults
                  </button>
                ))}
              </div>
            )}
            <AgentsTimingStep
              mode="edit"
              config={config}
              onChange={setConfig}
              fieldErrors={fieldErrors}
              staffing={{
                agents: canSupervise ? staffing.agents : [],
                selected: canSupervise ? staffingSelected : [],
                onChange: setStaffingTicks,
                loading: canSupervise && staffing.loading,
                error: canSupervise ? staffing.error : STAFFING_SUPERVISORS_ONLY,
                onRetry: () => void staffing.reload(),
                invitePath: staffing.invitePath,
              }}
              recording={{
                state: recording,
                onChange: setRecording,
                recordingEnabled,
                analyticsEnabled,
                profiles: analysisProfiles,
                profilesLoading,
                profilesError,
                savedProfileId: campaign.analysis_profile_id ?? null,
              }}
              agentScreen={{
                dailyTarget: station.dailyTarget,
                phoneDisplay: station.phoneDisplay,
                onChange: (patch) => setStation((current) => (current ? { ...current, ...patch } : current)),
              }}
              breakLimits={breakReasons ? (
                <BreakLimitsEditor
                  value={breakReasons}
                  onChange={setBreakReasons}
                  serverError={fieldErrors['break_reasons'] ?? null}
                  readOnly={!canEdit}
                  icons
                  fieldErrors={fieldErrors}
                />
              ) : undefined}
              assignment={assignmentEnabled ? { modeLocked: assignmentModeLocked(campaign.status) } : undefined}
              inbound={inboundEnabled}
              // Purpose & buttons shows them, in its Advanced.
              unansweredOutcomes={false}
              // A break limit's finding is held open; a link to a setting inside opens it once.
              forceAdvancedOpen={breakLimitsInvalid || advancedPulse}
              anchors={{ whenToCall: 'calling-hours', agentScreen: 'recording', retries: 'dialling-retries', agentRules: 'agents' }}
              readOnly={!canEdit}
            />
          </div>
        </Fragment>

        {canEdit && (
          <UnsavedChangesBar
            count={changes.length}
            saving={saving}
            blockedReason={saveBlock !== null ? CONFIG_BLOCK_COPY[saveBlock] : null}
            // The refusal itself is the alert above the tabs; the bar says where to look.
            note={saveError || staffingError ? 'Not saved. The reason is above the form.' : null}
            onDiscard={onDiscard}
            onSave={() => void onSave()}
            // The highlighted field can be on another tab, or out of view of a bar at the bottom.
            onShowBlocked={() => goToFinding(holding)}
          />
        )}
      </div>

      {chrome.dialogs}

      <LeaveUnsavedDialog
        guard={leaveGuard}
        message={`You have ${plural(changes.length, 'unsaved change')} to this campaign’s settings. `
          + 'Leave now and they are lost; Cancel keeps you here to save them.'}
      />
    </CampaignWorkspaceFrame>
  );
}

export default AgencyCampaignSettingsPage;

/**
 * What a campaign cannot be saved without, keyed as the server keys it: a name, and at least
 * one caller ID (the API rejects an empty pool, and the pacing engine cannot place a call
 * without one, so on a running campaign an empty save would stop it dialling).
 */
function missingBasics(name: string, callerIds: readonly string[]): Record<string, string> {
  const missing: Record<string, string> = {};
  if (name.trim().length === 0) missing['name'] = 'A campaign needs a name.';
  if (callerIds.length === 0) missing['caller_ids'] = 'A campaign needs at least one caller ID.';
  return missing;
}

/** The assignment half of `agency_campaign_config_saved`: enum labels and counts only. */
function assignmentAnalytics(config: CampaignConfigState) {
  return {
    assignment_mode: config.assignment.mode,
    agent_retry: config.assignment.allowAgentRetry,
    override_outcome_count: config.dispositions.filter((d) => d.override != null).length,
  };
}
