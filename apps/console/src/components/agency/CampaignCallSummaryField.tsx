import { useId } from 'react';
import {
  NO_ANALYSIS_PROFILE,
  analysisGate,
  resolveProfileId,
  storedProfileStatus,
} from '../../utils/agencyCampaignRecording';
import type { CallAnalysisProfile } from '../../types/call-analysis-profile';
import styles from './CampaignCallSummaryField.module.css';

/**
 * "Call summary": the campaign's call-analysis profile (its custom dimensions), shared by the
 * create wizard and the campaign settings page, as `CampaignRecordingField` is for recording.
 *
 * `capabilityEnabled` is the account's `agency.analytics`. With it on, the profiles are a
 * picker. With it off the field only says whether a profile is set and offers to remove it:
 * `analysis_profile_id: null` passes the API's guard with the capability off, so a campaign
 * whose account lost it can still be cleared (see `utils/agencyCampaignRecording.ts`).
 * Whether the field shows at all is the caller's call.
 */
export function CampaignCallSummaryField(props: {
  /** {@link NO_ANALYSIS_PROFILE} or a profile id. */
  profileId: string;
  onChange: (next: string) => void;
  capabilityEnabled: boolean;
  profiles: CallAnalysisProfile[];
  loading: boolean;
  loadError: string | null;
  /** What a failed profile list means for the save, said after the failure. */
  loadErrorConsequence: string;
  /** No edit permission: locked. */
  readOnly?: boolean;
  error?: string;
}) {
  const {
    profileId, onChange, capabilityEnabled, profiles, loading, loadError, loadErrorConsequence,
    readOnly = false, error,
  } = props;
  const id = useId();
  const selectId = `${id}-select`;
  const gate = analysisGate({ enabled: capabilityEnabled, current: profileId });
  const storedProfileId = resolveProfileId(profileId);
  // A profile set by an earlier save (or by curl) may not be in the fetched list —
  // deactivated, deleted, or on a page we didn't fetch. Kept as an option either way so
  // the round trip stays lossless instead of silently re-saving as "no summary".
  // `storedProfileStatus` decides whether that absence is a verdict ("no longer listed")
  // or an in-flight or failed fetch that has not answered the question yet.
  const profileStatus = storedProfileStatus({ storedProfileId, profiles, loading, error: loadError });

  return (
    <div className="form-group">
      <label htmlFor={selectId}>Call summary</label>
      {capabilityEnabled ? (
        <>
          <select
            id={selectId}
            value={profileId}
            disabled={readOnly || loading}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value={NO_ANALYSIS_PROFILE}>No summary</option>
            {profileStatus !== 'found' && storedProfileId !== null && (
              <option value={storedProfileId}>
                {profileStatus === 'unlisted' ? 'Current profile (no longer listed)' : 'Current profile'}
              </option>
            )}
            {profiles.map((profile) => (
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
          {loadError && (
            <p className={styles.gateNotice} role="note">
              Could not load your summary profiles ({loadError}). {loadErrorConsequence}
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
          {gate.notice && (
            <p className={styles.gateNotice} role="note">
              {gate.notice}
            </p>
          )}
          {storedProfileId !== null && !readOnly && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => onChange(NO_ANALYSIS_PROFILE)}
            >
              Remove summary profile
            </button>
          )}
        </>
      )}
      {error && <p className={styles.fieldError}>{error}</p>}
    </div>
  );
}
