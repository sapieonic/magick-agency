import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '../../contexts/ToastContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useCallAnalysisProfiles } from '../../hooks/useCallAnalysisProfiles';
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
  type CampaignConfigState,
} from '../../utils/agencyCampaignConfigForm';
import {
  AGENCY_ANALYTICS_CAPABILITY,
  AGENCY_RECORDING_CAPABILITY,
  NO_ANALYSIS_PROFILE,
  analysisGate,
  campaignSaveRefusal,
  payloadSetsProfile,
  recordingGate,
  recordingPayload,
  recordingStateFromCampaign,
  resolveProfileId,
  storedProfileStatus,
  type CampaignRecordingState,
} from '../../utils/agencyCampaignRecording';
import { CampaignBehaviourSection } from '../campaigns/agency/CampaignBehaviourSection';
import { CallerIdPicker, AGENCY_TELEPHONY_PROVIDER } from './CallerIdPicker';
import { Breadcrumbs } from '../../components/common/Breadcrumbs';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
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
 */
export function AgencyCampaignSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const { tenantId, accountId, role } = useTenant();
  const { showToast } = useToast();

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  const [config, setConfig] = useState<CampaignConfigState | null>(null);
  const [name, setName] = useState('');
  const [callerIds, setCallerIds] = useState<string[]>([]);
  const [recording, setRecording] = useState<CampaignRecordingState | null>(null);
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

  const canEdit = hasPermission(role, 'agency.campaigns.write');

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

  const load = useCallback(async () => {
    if (!id || !tenantId || !accountId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const record = await getAgencyCampaign(id, tenantId, accountId);
      setCampaign(record);
      const loaded = configFromCampaign(record);
      setConfig(loaded);
      dispositionOrderRef.current = loaded.dispositions.map((d) => d.code);
      setName(record.name);
      setCallerIds(record.caller_ids ?? []);
      setRecording(recordingStateFromCampaign(record));
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Could not load this campaign.');
    } finally {
      setLoading(false);
    }
  }, [id, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

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
    if (name.trim().length === 0) {
      setFieldErrors({ name: 'A campaign needs a name.' });
      return;
    }
    // The API rejects an empty pool and the pacing engine throws without one, so
    // saving an empty selection would either 400 or — worse, on a running
    // campaign — leave it unable to place its next call.
    if (callerIds.length === 0) {
      setFieldErrors({ caller_ids: 'A campaign needs at least one caller ID.' });
      return;
    }

    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    // Built before the request so the refusal mapper can tell a 404 that means
    // "your profile is gone" from any other 404 — the server masks the dialer runtime's body, so
    // what we sent is the only evidence left (see `campaignSaveRefusal`).
    const recordingFields = recordingPayload({ recordingEnabled, analyticsEnabled, next: recording });
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
          ...buildConfigPayload(config),
          ...recordingFields,
          name: name.trim(),
          caller_ids: callerIds,
          telephony_provider: AGENCY_TELEPHONY_PROVIDER,
        },
        tenantId ?? undefined,
        accountId ?? undefined,
      );
      setCampaign(updated);
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
      const reseeded = configFromCampaign(updated);
      setConfig(reseeded);
      dispositionOrderRef.current = reseeded.dispositions.map((d) => d.code);
      setName(updated.name);
      setCallerIds(updated.caller_ids ?? []);
      setRecording(recordingStateFromCampaign(updated));
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
      // The server answers `{ details: { field: message } }` keyed by the body path,
      // so the message lands on the field that caused it.
      const mapped = fieldErrorsFromResponse(err);
      if (Object.keys(mapped).length > 0) setFieldErrors(mapped);
      else setSaveError(err instanceof Error ? err.message : 'Could not save the campaign.');
    } finally {
      setSaving(false);
    }
  }, [
    id, config, name, callerIds, recording, recordingEnabled, analyticsEnabled,
    tenantId, accountId, showToast,
  ]);

  if (loading) return <LoadingSpinner />;
  if (loadError && !campaign) return <ErrorAlert message={loadError} onRetry={() => void load()} />;
  if (!campaign || !config || !recording) return null;

  const block = configBlockReason(config);
  const isLive = campaign.status === 'running' || campaign.status === 'stopping';

  const recordGate = recordingGate({ enabled: recordingEnabled, current: recording.record });
  const summaryGate = analysisGate({ enabled: analyticsEnabled, current: recording.profileId });
  // Off→on is what the server refuses, so the box locks only in that direction: a
  // grandfathered campaign whose capability was revoked can still be switched
  // off, which is the whole point of the asymmetry.
  const recordLocked = !canEdit || (!recordGate.canEnable && !recording.record);
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
      <Breadcrumbs
        items={[
          { label: 'Campaigns', href: '/agency/campaigns' },
          { label: campaign.name, href: `/agency/campaigns/${campaign.id}` },
          { label: 'Settings' },
        ]}
      />

      {/*
        The campaign workspace's section bar, in the same slot on every one of
        its screens. These four sections used to be reachable only
        as secondary buttons on the detail page's header row — the same row
        that carries Stop — so getting from Contacts to Call attempts meant
        going back through the campaign first.
      */}
      <CampaignTabs
        campaignId={campaign.id}
        active="settings"
        role={role}
        campaignStatus={campaign.status}
      />

      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
        <AgencyCampaignStatusBadge status={campaign.status} />
      </div>

      {isLive && (
        <p className={styles.liveNote}>
          This campaign is dialing. Changes apply to calls placed from now on — a call already
          under way keeps the settings it started with.
        </p>
      )}

      {saveError && <ErrorAlert message={saveError} />}

      <div className={styles.basics}>
        <div className="form-group">
          <label htmlFor="campaign-name">
            Campaign name<span className="required-star">*</span>
          </label>
          <input
            id="campaign-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!canEdit}
          />
          {fieldErrors['name'] && <p className={styles.fieldError}>{fieldErrors['name']}</p>}
        </div>
      </div>

      <div className={styles.basics}>
        <div className="form-group">
          <label htmlFor="campaign-caller-ids">
            Caller IDs<span className="required-star">*</span>
          </label>
          <CallerIdPicker selected={callerIds} onChange={setCallerIds} disabled={!canEdit} />
          {fieldErrors['caller_ids'] && (
            <p className={styles.fieldError}>{fieldErrors['caller_ids']}</p>
          )}
        </div>
      </div>

      {/*
        Recording + call summary. Both fields already existed on the
        wire and could be set by nothing but curl; the two capabilities that
        govern them guarded a surface that did not exist.
      */}
      <div className={styles.basics}>
        <div className="form-group">
          <label className={styles.flag}>
            <input
              type="checkbox"
              checked={recording.record}
              disabled={recordLocked}
              onChange={(event) =>
                setRecording({ ...recording, record: event.target.checked })
              }
            />
            Record every call on this campaign
          </label>
          <p className={styles.hint}>
            {recording.record
              ? 'Agents and the people they reach are both on the recording. Make sure your ' +
                'agents announce it, and that you are entitled to record in every region this ' +
                'campaign dials.'
              : 'Off by default. A campaign call is human-to-human, so recording one is ' +
                'consent-sensitive in a way an AI call is not.'}
          </p>
          {recordGate.notice && (
            <p className={styles.gateNotice} role="note">
              {recordGate.notice}
            </p>
          )}
          {fieldErrors['record_calls'] && (
            <p className={styles.fieldError}>{fieldErrors['record_calls']}</p>
          )}
        </div>

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

      <CampaignBehaviourSection state={config} onChange={setConfig} fieldErrors={fieldErrors} />

      {canEdit && (
        <div className={styles.actions}>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSave()}
            disabled={saving || block !== null}
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {block !== null && <p className={styles.blockCopy}>{CONFIG_BLOCK_COPY[block]}</p>}
        </div>
      )}
    </div>
  );
}

export default AgencyCampaignSettingsPage;
