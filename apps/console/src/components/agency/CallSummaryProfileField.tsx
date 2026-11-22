import { useCallAnalysisProfiles } from '../../hooks/useCallAnalysisProfiles';
import {
  NO_ANALYSIS_PROFILE,
  analysisGate,
  resolveProfileId,
  storedProfileStatus,
} from '../../utils/agencyCampaignRecording';
import styles from '../../pages/agency/AgencyCampaignSettingsPage.module.css';

/**
 * "Call summary": the analysis-profile picker beside the recording control, shared by campaign
 * Settings and an account's campaign template (`docs/campaign-templates.md` §7). The account's
 * profiles are read here (`agency.analytics` alone decides, `utils/agencyCampaignRecording.ts`).
 *
 * With the capability on: a select of the profiles, keeping a stored profile the list does not
 * have (`storedProfileStatus`) so the round trip is lossless. With it off: what is set, why it
 * cannot be chosen, and the way to clear it the server allows.
 */
export function CallSummaryProfileField({
  profileId,
  onChange,
  analyticsEnabled,
  readOnly = false,
  error,
  id = 'campaign-analysis-profile',
  subject = 'campaign',
}: {
  /** {@link NO_ANALYSIS_PROFILE} or a profile id. */
  profileId: string;
  onChange: (profileId: string) => void;
  analyticsEnabled: boolean;
  readOnly?: boolean;
  error?: string;
  id?: string;
  /** What the hints name: "this campaign’s calls" or "this template’s campaigns". */
  subject?: 'campaign' | 'template';
}) {
  const { profiles, loading, error: profilesError } = useCallAnalysisProfiles({ enabled: analyticsEnabled });
  const storedProfileId = resolveProfileId(profileId);
  const summaryGate = analysisGate({ enabled: analyticsEnabled, current: profileId });
  const profileStatus = storedProfileStatus({ storedProfileId, profiles, loading, error: profilesError });
  const whose = subject === 'template' ? 'campaigns made from this template' : 'this campaign';

  return (
    <div className="form-group">
      <label htmlFor={id}>Call summary</label>
      {analyticsEnabled ? (
        <>
          <select id={id} value={profileId} disabled={readOnly || loading} onChange={(event) => onChange(event.target.value)}>
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
              ? subject === 'template'
                ? 'No summary is written for the calls of campaigns made from this template.'
                : 'No summary is written for this campaign’s calls.'
              : 'Every connected call is summarised against this profile once it ends. ' +
                'A summary needs a recording, so leave recording on above.'}
          </p>
          {profilesError && (
            <p className={styles.gateNotice} role="note">
              {`Could not load your summary profiles (${profilesError}). Saving without changing this field leaves the ${
                subject === 'template' ? 'template’s' : 'campaign’s'
              } current profile alone.`}
            </p>
          )}
        </>
      ) : (
        <>
          <p className={styles.hint}>
            {storedProfileId === null ? `No summary profile is set for ${whose}.` : `A summary profile is set for ${whose}.`}
          </p>
          {summaryGate.notice && (
            <p className={styles.gateNotice} role="note">
              {summaryGate.notice}
            </p>
          )}
          {storedProfileId !== null && !readOnly && (
            <button type="button" className={styles.linkButton} onClick={() => onChange(NO_ANALYSIS_PROFILE)}>
              Remove summary profile
            </button>
          )}
        </>
      )}
      {error && <p className={styles.fieldError}>{error}</p>}
    </div>
  );
}
