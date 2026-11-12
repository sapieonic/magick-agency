import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useCallAnalysisProfiles } from '../../hooks/useCallAnalysisProfiles';
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
  NO_ANALYSIS_PROFILE,
  analysisGate,
  campaignSaveRefusal,
  payloadSetsProfile,
  recordingPayload,
  recordingStateFromCampaign,
  resolveProfileId,
  storedProfileStatus,
  type CampaignRecordingState,
} from '../../utils/agencyCampaignRecording';
import { CampaignBehaviourSection } from '../campaigns/agency/CampaignBehaviourSection';
import { CallerIdPicker } from './CallerIdPicker';
import { CampaignCarrierField } from '../../components/agency/CampaignCarrierField';
import { useAgencyCarriers } from '../../hooks/useAgencyCarriers';
import {
  SERVICE_CARRIER,
  carrierActive,
  carrierOfCampaign,
  carrierName,
  carrierOptions,
  carrierRefusal,
  sameCarrier,
  type CarrierChoice,
} from '../../utils/agencyCarriers';
import { CampaignRecordingField } from '../../components/agency/CampaignRecordingField';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { SettingsSectionNav, useSectionInView } from '../../components/agency/SettingsSectionNav';
import { ComposerSection } from '../campaigns/components/ComposerSection';
import { campaignSettingsSectionsFor } from '../../utils/campaignSettingsSections';
import { changedSettings, samePool, type CampaignSettingsForm } from '../../utils/campaignSettingsChanges';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { LeaveUnsavedDialog, UnsavedChangesBar } from '../../components/agency/UnsavedChangesBar';
import { plural } from '../../utils/format/number';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { CampaignHistory } from './campaign-detail/insights/CampaignFacts';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { CampaignDetailHeader } from './campaign-detail/CampaignDetailHeader';
import { useCampaignLifecycle } from './campaign-detail/useCampaignLifecycle';
import type { AgencyCampaign } from '../../types/agency-campaign';
import styles from './AgencyCampaignSettingsPage.module.css';

/**
 * Edit an existing campaign's configuration.
 *
 * The pieces for this were all written and never assembled: `configFromCampaign`
 * exists, is tested for a lossless round trip (a lossless round trip), and
 * had **no production caller** — configuration could only be set inside the
 * creation wizard. So a campaign with the wrong calling window had to be
 * recreated to fix it.
 *
 * **Editing a running campaign is deliberately allowed and not gated.** The
 * calling window is most often discovered to be wrong *while* the campaign is
 * dialing outside it, and forcing a pause to correct that would mean the fix
 * costs more than the fault. The API re-reads the campaign every pacing tick, so an
 * edit applies to future attempts; an attempt already dispatched keeps the
 * snapshot it was dialed with. The banner says so rather than leaving the
 * operator to guess whether the change took effect mid-run.
 *
 * The form is laid out as the sections of `CAMPAIGN_SETTINGS_SECTIONS`, each a card with its
 * id as the anchor, with a section nav beside them (a strip above them on a phone).
 * `…/settings#calling-hours` opens the page at that section. Grouping changed where a field
 * sits on the page, never what it does: there is still one form and one Save.
 *
 * The Save is in a bar stuck to the bottom of the view that shows only while something is
 * unsaved ("2 unsaved changes · Discard · Save changes", counted by `changedSettings`), and
 * leaving the page with unsaved edits asks first (`useUnsavedChangesGuard`).
 */
/** The form's fields as a stored campaign has them: what a load or a save seeds. */
function formOfCampaign(record: AgencyCampaign): CampaignSettingsForm {
  return {
    name: record.name,
    callerIds: record.caller_ids ?? [],
    carrier: carrierOfCampaign(record),
    recording: recordingStateFromCampaign(record),
    config: configFromCampaign(record),
  };
}

export function AgencyCampaignSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const { tenantId, accountId, role } = useTenant();
  const { showToast } = useToast();

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  /** When `campaign` was last read or written: the header's "Updated" stamp. */
  const [campaignReadAt, setCampaignReadAt] = useState<Date | null>(null);
  /** The campaign at click time, for the header's lifecycle controls (`useCampaignLifecycle`). */
  const campaignRef = useRef<AgencyCampaign | null>(campaign);
  campaignRef.current = campaign;
  const [config, setConfig] = useState<CampaignConfigState | null>(null);
  const [name, setName] = useState('');
  const [callerIds, setCallerIds] = useState<string[]>([]);
  /** The carrier account the form holds; seeded from the campaign on load and save. */
  const [carrier, setCarrier] = useState<CarrierChoice>(SERVICE_CARRIER);
  const [recording, setRecording] = useState<CampaignRecordingState | null>(null);
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

  const canEdit = hasPermission(role, 'agency.campaigns.write');
  // The header's lifecycle controls and Join as agent, gated as on the Monitor tabs.
  const canSupervise = hasPermission(role, 'agency.supervise');
  const canJoinStation = hasPermission(role, 'agency.station.connect');
  // Contact assignment's settings and outcome overrides: shown and sent only while
  // the flag is on (the server refuses a non-default value with it off).
  const assignmentEnabled = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);
  const inboundEnabled = useFeatureFlagEnabled(INBOUND_FLAG);
  // Read by every viewer (`agency.campaigns.read`): an editor chooses from it, and a
  // read-only viewer is told which carrier account the campaign dials on.
  const { carriers } = useAgencyCarriers();

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
    setAssignmentResetPending(false);
  }, []);

  /** Hold `record` as the campaign: state, the ref the lifecycle controls read, and the "Updated" stamp. */
  const commitCampaign = useCallback((record: AgencyCampaign) => {
    campaignRef.current = record;
    setCampaign(record);
    setCampaignReadAt(new Date());
  }, []);

  const load = useCallback(async () => {
    if (!id || !tenantId || !accountId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const record = await getAgencyCampaign(id, tenantId, accountId);
      commitCampaign(record);
      seedForm(formOfCampaign(record));
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Could not load this campaign.');
    } finally {
      setLoading(false);
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
    try {
      const record = await getAgencyCampaign(id, tenantId, accountId);
      if (record.id !== id) return campaignRef.current;
      commitCampaign(record);
      return record;
    } catch {
      return campaignRef.current;
    }
  }, [id, tenantId, accountId, commitCampaign]);

  const lifecycle = useCampaignLifecycle({
    id,
    tenantId,
    accountId,
    campaignRef,
    refreshCampaign,
    commitCampaign,
    reload: () => void refreshCampaign(),
    fromTab: 'settings',
  });

  const onSave = useCallback(async () => {
    if (!id || !config || !recording) return;
    if (configBlockReason(config) !== null) {
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
        source: 'settings',
        field_error_count: Object.keys(errors).length,
      });
      return;
    }
    // Save is held while either is missing (`missingBasics`), so this is a keyboard or
    // programmatic submit: say so on the field all the same.
    const missing = missingBasics(name, callerIds);
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      return;
    }

    setSaving(true);
    setSaveError(null);
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
    */
    const sendCarrier = !campaign?.telephony_provider
      || !sameCarrier(carrier, carrierOfCampaign(campaign));
    /*
      The caller IDs likewise go only when they changed (or the carrier moves, which
      re-judges the pool). A stored number since retired or untagged would otherwise be
      resent with every rename; the server keeps it (PL13), but there is nothing to write.
    */
    const sendCallerIds = sendCarrier || !samePool(callerIds, campaign?.caller_ids ?? []);
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
          name: name.trim(),
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
      commitCampaign(updated);
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
      seedForm(formOfCampaign(updated));
      showToast('Campaign settings saved.', 'success');
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
    } catch (err: unknown) {
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
        return;
      }
      // The new caller IDs drop a number dedicated to an agent (409
      // `caller_id_dedicated`). Said on the field, naming the numbers: its
      // `details.caller_ids` is a list, not the per-field map
      // `fieldErrorsFromResponse` reads.
      const dedicated = dedicatedCallerIdsOf(err);
      if (dedicated !== null) {
        setFieldErrors({ caller_ids: callerIdDedicatedMessage(dedicated) });
        return;
      }
      // The server answers `{ details: { field: message } }` keyed by the body path,
      // so the message lands on the field that caused it.
      const mapped = fieldErrorsFromResponse(err);
      if (Object.keys(mapped).length > 0) setFieldErrors(mapped);
      else setSaveError(err instanceof Error ? err.message : 'Could not save the campaign.');
    } finally {
      setSaving(false);
    }
  }, [
    id, config, name, callerIds, carrier, recording, recordingEnabled, analyticsEnabled,
    tenantId, accountId, showToast, assignmentEnabled, campaign, assignmentResetPending, seedForm, commitCampaign,
  ]);

  /** Put back what is saved: every field, and no error left from the edits. */
  const onDiscard = useCallback(() => {
    if (!saved) return;
    seedForm(saved);
    setFieldErrors({});
    setSaveError(null);
    setFormEpoch((n) => n + 1);
  }, [saved, seedForm]);

  /*
    The sections this campaign's page has, in page order, by the rule search reads too
    (`campaignSettingsSectionsFor`). Agents only with something in it (contact-assignment
    settings left from before the flag went off count: the reset notice lives there).
  */
  const assignmentLeftovers = campaign && !assignmentEnabled ? storedAssignmentLeftovers(campaign) : [];
  const sections = campaignSettingsSectionsFor({
    assignmentEnabled,
    inboundEnabled,
    assignmentLeftovers: assignmentLeftovers.length > 0,
    canSupervise,
  });
  const agentsVisible = sections.some((section) => section.id === 'agents');
  const historyVisible = sections.some((section) => section.id === 'roster-uploads');
  /*
    Ready once THIS campaign's sections are on the page: not while a jump from another
    campaign's settings is still loading this one (the old campaign is in state until then).
  */
  const sectionNav = useSectionInView(
    sections,
    !loading && campaign?.id === id && Boolean(config && recording),
    // Discard remounts every section: the highlight must follow the new ones.
    formEpoch,
  );
  useCampaignCrumbs(id, campaign, 'settings');

  /* What is unsaved, setting by setting; it drives the bar and the guard on leaving. */
  const changes = useMemo(
    () => (saved && config && recording ? changedSettings(saved, { name, callerIds, carrier, recording, config }) : []),
    [saved, name, callerIds, carrier, recording, config],
  );
  const leaveGuard = useUnsavedChangesGuard(canEdit && changes.length > 0);

  if (loading) return <LoadingSpinner />;
  if (loadError && !campaign) return <ErrorAlert message={loadError} onRetry={() => void load()} />;
  if (!campaign || !config || !recording) return null;

  const block = configBlockReason(config);
  // A name or caller ID taken away is said on its field as soon as it happens, and holds Save,
  // as a calling-hours mistake does.
  const missing = canEdit ? missingBasics(name, callerIds) : {};
  const nameError = missing['name'] ?? fieldErrors['name'];
  const callerIdsError = missing['caller_ids'] ?? fieldErrors['caller_ids'];
  const saveBlock = block ?? (Object.keys(missing).length > 0 ? 'invalid_fields' : null);
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

  const summaryGate = analysisGate({ enabled: analyticsEnabled, current: recording.profileId });
  const storedProfileId = resolveProfileId(recording.profileId);
  const canPickProfile = analyticsEnabled;
  // Visible when the capability is on (picker, or a notice saying why the list
  // is unreadable) — and also when it is OFF but a profile is already set, so
  // the clearing path the server allows is reachable. Keyed on the LOADED campaign,
  // not on form state: keyed on state, pressing "Remove summary profile" would
  // make the whole block vanish before the operator had saved it.
  const summaryVisible = analyticsEnabled || (campaign.analysis_profile_id ?? null) !== null;
  // A profile set by an earlier save (or by curl) may not be in the fetched
  // list — deactivated, deleted, or belonging to a page we didn't fetch. Kept as
  // an option either way so the round trip stays lossless instead of silently
  // re-saving as "no summary". `storedProfileStatus` is what decides whether
  // that absence is a verdict ("no longer listed") or just an in-flight/failed
  // fetch that has not answered the question yet — see the option
  // rendering below.
  const profileStatus = storedProfileStatus({
    storedProfileId,
    profiles: analysisProfiles,
    loading: profilesLoading,
    error: profilesError,
  });

  return (
    <div className={styles.page}>

      {/*
        The campaign's own header, as on its Monitor tabs: its name and status, the
        lifecycle controls (pausing before an assignment-mode change is said below, so
        it belongs here) and History — "who changed the caller ID?" is asked here.
      */}
      <CampaignDetailHeader
        campaign={campaign}
        lastUpdatedAt={campaignReadAt}
        tenantId={tenantId}
        accountId={accountId}
        canControl={canSupervise}
        busy={lifecycle.busy}
        onAction={lifecycle.onAction}
        canJoinStation={canJoinStation}
        role={role}
        onRefresh={() => void refreshCampaign()}
      />

      <CampaignTabs
        campaignId={campaign.id}
        active="settings"
        role={role}
        campaignStatus={campaign.status}
      />

      {isLive && (
        <p className={styles.liveNote}>
          This campaign is dialling. Changes apply to calls placed from now on — a call already
          under way keeps the settings it started with.
        </p>
      )}

      {saveError && <ErrorAlert message={saveError} />}

      <div className={styles.layout}>
        <SettingsSectionNav sections={sections} active={sectionNav.active} onSelect={sectionNav.select} />

        <div className={styles.sections}>
          {/* Remounted by Discard, so no field keeps state from the edits it threw away. */}
          <Fragment key={formEpoch}>
            <ComposerSection id="general" title="General" helper="What this campaign is called across the console and in reports.">
              <div className="form-group">
                <label htmlFor="campaign-name">
                  Campaign name<span className="required-star">*</span>
                </label>
                <input
                  id="campaign-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={!canEdit}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? 'campaign-name-error' : undefined}
                />
                {nameError && <p id="campaign-name-error" className={styles.fieldError}>{nameError}</p>}
              </div>
            </ComposerSection>

            <ComposerSection
              id="caller-ids"
              title="Caller IDs"
              helper="The numbers customers see when this campaign calls them, and the carrier account it dials on."
            >
              <div className={styles.stack}>
                {canEdit && carrierChoices.length > 1 && (
                  <CampaignCarrierField
                    options={carrierChoices}
                    value={carrier}
                    onChange={setCarrier}
                    error={fieldErrors['telephony_credential_id'] ?? fieldErrors['telephony_provider']}
                  />
                )}
                {/* A viewer who cannot edit still reads which carrier account it dials on. */}
                {!canEdit && carrierChoices.length > 1 && (
                  <p className={styles.hint} data-testid="campaign-carrier-readonly">
                    {`Carrier: ${carrierChoices.find((o) => sameCarrier(o, carrier))?.name ?? carrierName(carrier)}`}
                  </p>
                )}
                <div className="form-group">
                  <label htmlFor="campaign-caller-ids">
                    Caller IDs<span className="required-star">*</span>
                  </label>
                  <CallerIdPicker
                    selected={callerIds}
                    onChange={setCallerIds}
                    carrier={carrier}
                    carrierLabel={carrierLabel}
                    carrierActive={carrierActive(carriers, carrier)}
                    disabled={!canEdit}
                  />
                  {callerIdsError && (
                    <p className={styles.fieldError}>{callerIdsError}</p>
                  )}
                </div>
              </div>
            </ComposerSection>

            <ComposerSection id="calling-hours" title="Calling hours" helper="When this campaign is allowed to dial.">
              <CampaignBehaviourSection
                state={config}
                onChange={setConfig}
                fieldErrors={fieldErrors}
                layout="plain"
                include={['hours']}
              />
            </ComposerSection>

            <ComposerSection
              id="dialling-retries"
              title="Dialling and retries"
              helper="When a contact is tried again after a call that did not connect, and when the campaign pauses itself."
            >
              <CampaignBehaviourSection
                state={config}
                onChange={setConfig}
                fieldErrors={fieldErrors}
                layout="plain"
                include={['retries']}
                readOnly={!canEdit}
              />
            </ComposerSection>

            <ComposerSection
              id="wrap-up"
              title="Wrap-up and outcomes"
              helper="The outcomes agents can pick, what an unanswered call is filed as, and the time agents get after each call."
            >
              <CampaignBehaviourSection
                state={config}
                onChange={setConfig}
                fieldErrors={fieldErrors}
                layout="plain"
                include={['outcomes']}
                assignment={assignmentEnabled ? { modeLocked: assignmentModeLocked(campaign.status) } : undefined}
              />
            </ComposerSection>

            {/*
              Recording + call summary. Both fields already existed on the
              wire and could be set by nothing but curl; the two capabilities that
              govern them guarded a surface that did not exist.
            */}
            <ComposerSection
              id="recording"
              title="Recording"
              helper={summaryVisible
                ? 'Whether calls are recorded, and the summary written for each connected call.'
                : 'Whether calls are recorded.'}
            >
              <div className={styles.stack}>
                <CampaignRecordingField
                  checked={recording.record}
                  onChange={(record) => setRecording({ ...recording, record })}
                  capabilityEnabled={recordingEnabled}
                  readOnly={!canEdit}
                  error={fieldErrors['record_calls']}
                />

                {summaryVisible && (
                  <div className="form-group">
                    <label htmlFor="campaign-analysis-profile">Call summary</label>
                    {canPickProfile ? (
                      <>
                        <select
                          id="campaign-analysis-profile"
                          value={recording.profileId}
                          disabled={!canEdit || profilesLoading}
                          onChange={(event) =>
                            setRecording({ ...recording, profileId: event.target.value })
                          }
                        >
                          <option value={NO_ANALYSIS_PROFILE}>No summary</option>
                          {profileStatus !== 'found' && storedProfileId !== null && (
                            <option value={storedProfileId}>
                              {profileStatus === 'unlisted'
                                ? 'Current profile (no longer listed)'
                                : 'Current profile'}
                            </option>
                          )}
                          {analysisProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.is_default ? `${profile.name} (default)` : profile.name}
                            </option>
                          ))}
                        </select>
                        <p className={styles.hint}>
                          {storedProfileId === null
                            ? 'No summary is written for this campaign’s calls.'
                            : 'Every connected call is summarised against this profile once it ends. ' +
                              'A summary needs a recording, so leave recording on above.'}
                        </p>
                        {profilesError && (
                          <p className={styles.gateNotice} role="note">
                            Could not load your summary profiles ({profilesError}). Saving without
                            changing this field leaves the campaign’s current profile alone.
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p className={styles.hint}>
                          {storedProfileId === null
                            ? 'No summary profile is set for this campaign.'
                            : 'A summary profile is set for this campaign.'}
                        </p>
                        {summaryGate.notice && (
                          <p className={styles.gateNotice} role="note">
                            {summaryGate.notice}
                          </p>
                        )}
                        {storedProfileId !== null && canEdit && (
                          <button
                            type="button"
                            className={styles.linkButton}
                            onClick={() =>
                              setRecording({ ...recording, profileId: NO_ANALYSIS_PROFILE })
                            }
                          >
                            Remove summary profile
                          </button>
                        )}
                      </>
                    )}
                    {fieldErrors['analysis_profile_id'] && (
                      <p className={styles.fieldError}>{fieldErrors['analysis_profile_id']}</p>
                    )}
                  </div>
                )}
              </div>
            </ComposerSection>

            {agentsVisible && (
              <ComposerSection
                id="agents"
                title="Agents"
                helper={assignmentEnabled
                  ? `How contacts are assigned to agents${inboundEnabled ? ', and whether customers who ring in reach their agent first' : ''}.`
                  : inboundEnabled
                    ? 'Whether this campaign’s customers who ring in reach their agent first.'
                    : 'Contact assignment settings this campaign still uses.'}
              >
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
                      <p className={styles.fieldError}>{fieldErrors['assignment_mode']}</p>
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
                <CampaignBehaviourSection
                  state={config}
                  onChange={setConfig}
                  fieldErrors={fieldErrors}
                  layout="plain"
                  include={['agents']}
                  assignment={assignmentEnabled ? { modeLocked: assignmentModeLocked(campaign.status) } : undefined}
                  inbound={inboundEnabled}
                />
              </ComposerSection>
            )}
          </Fragment>

          {canEdit && (
            <UnsavedChangesBar
              count={changes.length}
              saving={saving}
              // The refusal itself is the alert above the form; the bar says where to look.
              note={saveBlock !== null
                ? CONFIG_BLOCK_COPY[saveBlock]
                : saveError ? 'Not saved. The reason is above the form.' : null}
              blocked={saveBlock !== null}
              onDiscard={onDiscard}
              onSave={() => void onSave()}
            />
          )}

          {/*
            The lifecycle and the upload history (decision IN13), which used to sit
            at the bottom of the Insights scroll: they are about how this campaign
            was set up and run, so they live with its settings. Both reads are floored
            at `agency.supervise`, so a role below it is not shown a pair of 403s.
            Not a card of its own: its two panels carry their own titles.
          */}
          {historyVisible ? (
            <div id="roster-uploads" className={styles.anchor}>
              <CampaignHistory campaignId={campaign.id} />
            </div>
          ) : null}
        </div>
      </div>

      {lifecycle.confirmDialog}

      <LeaveUnsavedDialog
        guard={leaveGuard}
        message={`You have ${plural(changes.length, 'unsaved change')} to this campaign’s settings. `
          + 'Leave now and they are lost; Cancel keeps you here to save them.'}
      />
    </div>
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
