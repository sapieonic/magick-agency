import type { ReactNode } from 'react';
import type { AgencyPhoneDisplay } from '@magick-agency/contracts/agency';
import { SentenceSelect, SwitchRow, type SentenceSelectOption } from '../../../../components/campaign-setup';
import {
  NO_ANALYSIS_PROFILE,
  analysisGate,
  recordingGate,
  resolveProfileId,
  storedProfileStatus,
  type CampaignRecordingState,
} from '../../../../utils/agencyCampaignRecording';
import { PHONE_DISPLAY_SAMPLE } from '../../../../utils/agency/stationSettings';
import { phoneForDisplay } from '../../../../utils/agency/stationFormat';
import { wrapupOptions } from '../../../../utils/campaignSetup/agentsTiming';
import type { CallAnalysisProfile } from '../../../../types/call-analysis-profile';
import type { ConfigFieldErrors } from '../configFieldErrors';
import styles from './AgentsTimingStep.module.css';

/*
  Agents & timing's "Agent screen" rows (CS14), one export per settings section they edit, so a
  campaign template's sections (CS21) are edited by the same rows as New campaign and Settings:
  `WrapupRow` (wrap-up), `RecordingRows` (recording and the call summary) and `AgentScreenRows`
  (how the number is shown and the daily target). Each renders its rows with their findings
  under them; the caller puts them in a column (`styles.rows`).
*/

const SUMMARY_OFF_REASON = 'Call summaries are turned off for this account. Ask an administrator to turn them on.';

/** Joins the row's own description with a finding's, for `aria-describedby`. */
function describedByOf(...ids: (string | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(' ') || undefined;
}

export interface WrapupRowProps {
  wrapupSeconds: number;
  /** Whether agents go back to available by themselves after it (said in the hint). */
  autoReturn: boolean;
  onChange: (wrapupSeconds: number) => void;
  errors: ConfigFieldErrors;
  readOnly?: boolean;
  /** Beside the label: where the setting came from (New campaign's template source). */
  badge?: ReactNode;
}

/** "Time to choose “What happened?” after each call": the wrap-up time as a chip. */
export function WrapupRow({ wrapupSeconds, autoReturn, onChange, errors, readOnly = false, badge }: WrapupRowProps) {
  return (
    <>
      <SwitchRow
        label="Time to choose “What happened?” after each call"
        hint={wrapupSeconds === 0
          ? 'Agents go straight back to available after a call.'
          : autoReturn
            ? 'Then the next call can come to them by itself.'
            : 'They stay in wrap-up until they say they are ready.'}
        checked={wrapupSeconds > 0}
        onChange={() => {}}
        testId="wrapup-row"
        badge={badge}
        control={({ describedBy }) => (
          <SentenceSelect
            value={String(wrapupSeconds)}
            options={wrapupOptions(wrapupSeconds)}
            onChange={(v) => onChange(Number(v))}
            ariaLabel="Time to choose what happened after each call"
            describedBy={describedByOf(describedBy, errors.describedBy('wrapup_seconds'))}
            invalid={errors.message('wrapup_seconds') !== null}
            disabled={readOnly}
            testId="wrapup-seconds"
          />
        )}
      />
      {errors.render('wrapup_seconds')}
    </>
  );
}

/** The recording state and what the account allows: a campaign page's, or a template's. */
export interface RecordingControls {
  state: CampaignRecordingState;
  onChange: (next: CampaignRecordingState) => void;
  /** The account's `agency.recording`. */
  recordingEnabled: boolean;
  /** The account's `agency.analytics`. */
  analyticsEnabled: boolean;
  profiles: CallAnalysisProfile[];
  profilesLoading: boolean;
  profilesError: string | null;
  /** The profile the server holds (`null` for none, and for one not yet saved). */
  savedProfileId: string | null;
}

export interface RecordingRowsProps {
  recording: RecordingControls;
  errors: ConfigFieldErrors;
  /** Said after a failed profile list: what a save does then. */
  profilesErrorConsequence: string;
  /** Left out where a call summary cannot be held (an organisation template, CT5). */
  callSummary?: boolean;
  readOnly?: boolean;
  badge?: ReactNode;
}

/** "Record calls" and "Call summary", behind their capabilities (CS14). */
export function RecordingRows({
  recording,
  errors,
  profilesErrorConsequence,
  callSummary = true,
  readOnly = false,
  badge,
}: RecordingRowsProps) {
  const rec = recording.state;
  const recGate = recordingGate({ enabled: recording.recordingEnabled, current: rec.record });
  const recLocked = readOnly || (!recGate.canEnable && !rec.record);
  const storedProfileId = resolveProfileId(rec.profileId);
  const keptProfileId = storedProfileId ?? recording.savedProfileId;
  const summaryGate = analysisGate({ enabled: recording.analyticsEnabled, current: rec.profileId });
  const profileStatus = storedProfileStatus({
    storedProfileId,
    profiles: recording.profiles,
    loading: recording.profilesLoading,
    error: recording.profilesError,
  });
  /*
    The profiles offered: with the capability on, the list, and
    the campaign's own profile kept as an option while the list does not show it (so a round trip
    never re-saves it as "No summary"); with it off, only the profile already set, which can be
    removed (`analysis_profile_id: null` passes the server's gate) but not swapped.
  */
  const currentLabel = profileStatus === 'unlisted' ? 'Current profile (no longer listed)' : 'Current profile';
  const summaryOptions: SentenceSelectOption[] = [
    { value: NO_ANALYSIS_PROFILE, label: 'No summary' },
    ...(recording.analyticsEnabled
      ? [
          ...(storedProfileId !== null && profileStatus !== 'found' ? [{ value: storedProfileId, label: currentLabel }] : []),
          ...recording.profiles.map((p) => ({ value: p.id, label: p.is_default ? `${p.name} (default)` : p.name })),
        ]
      : keptProfileId !== null
        ? [{ value: keptProfileId, label: 'Current profile' }]
        : []),
  ];
  const summaryOff = !recording.analyticsEnabled && keptProfileId === null;
  const summaryLocked = readOnly || summaryOff || (recording.analyticsEnabled && recording.profilesLoading);

  return (
    <>
      <SwitchRow
        label="Record calls"
        hint={rec.record
          ? [
              'Agents and customers are both on the recording. Make sure agents tell customers, and that you may record in every region you call.',
              !recGate.canEnable ? recGate.notice : null,
            ].filter(Boolean).join(' ')
          : 'Off by default. Recording a call between two people needs their consent.'}
        checked={rec.record}
        onChange={(record) => recording.onChange({ ...rec, record })}
        disabled={recLocked}
        disabledReason={readOnly ? undefined : recGate.notice ?? undefined}
        testId="record-row"
        badge={badge}
      />
      {errors.render('record_calls')}

      {callSummary ? (
        <>
          <SwitchRow
            label="Call summary"
            hint={[
              storedProfileId === null
                ? 'No summary is written for this campaign’s calls.'
                : 'Each connected call is summarised once it ends. A summary needs a recording, so keep recording on.',
              summaryGate.notice,
              recording.profilesError
                ? `Could not load your summary profiles (${recording.profilesError}). ${profilesErrorConsequence}`
                : null,
            ].filter(Boolean).join(' ')}
            checked={storedProfileId !== null}
            onChange={() => {}}
            disabled={summaryLocked}
            disabledReason={summaryOff && !readOnly ? SUMMARY_OFF_REASON : undefined}
            testId="summary-row"
            badge={badge}
            control={({ describedBy }) => (
              <SentenceSelect
                value={rec.profileId}
                options={summaryOptions}
                onChange={(profileId) => recording.onChange({ ...rec, profileId })}
                ariaLabel="Call summary"
                describedBy={describedByOf(describedBy, errors.describedBy('analysis_profile_id'))}
                invalid={errors.message('analysis_profile_id') !== null}
                disabled={summaryLocked}
                testId="summary-profile"
              />
            )}
          />
          {errors.render('analysis_profile_id')}
        </>
      ) : null}
    </>
  );
}

export interface AgentScreenRowsProps {
  dailyTarget: string;
  phoneDisplay: AgencyPhoneDisplay;
  onChange: (patch: { dailyTarget?: string; phoneDisplay?: AgencyPhoneDisplay }) => void;
  errors: ConfigFieldErrors;
  readOnly?: boolean;
  badge?: ReactNode;
}

/** "Show full phone number to agents" and "Daily target for each agent". */
export function AgentScreenRows({ dailyTarget, phoneDisplay, onChange, errors, readOnly = false, badge }: AgentScreenRowsProps) {
  return (
    <>
      <SwitchRow
        label="Show full phone number to agents"
        hint={phoneDisplay === 'full'
          ? `Agents see the whole number: ${phoneForDisplay(PHONE_DISPLAY_SAMPLE, 'full')}.`
          : `Agents see only the first two and last three digits: ${phoneForDisplay(PHONE_DISPLAY_SAMPLE, 'masked')}. The soft phone and customer history still have the number.`}
        checked={phoneDisplay === 'full'}
        onChange={(full) => onChange({ phoneDisplay: full ? 'full' : 'masked' })}
        disabled={readOnly}
        testId="phone-display-row"
        badge={badge}
      />
      {errors.render('phone_display')}

      <SwitchRow
        label="Daily target for each agent"
        hint="Calls where the customer spoke, each day. Agents see how close they are. Leave it empty for no target."
        checked={dailyTarget.trim() !== ''}
        onChange={() => {}}
        testId="daily-target-row"
        badge={badge}
        control={({ labelId, describedBy }) => (
          <span className={styles.target}>
            <input
              className={styles.targetInput}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="None"
              value={dailyTarget}
              disabled={readOnly}
              onChange={(event) => onChange({ dailyTarget: event.target.value })}
              aria-labelledby={labelId}
              aria-describedby={describedByOf(describedBy, errors.describedBy('daily_target_calls'))}
              aria-invalid={errors.message('daily_target_calls') ? true : undefined}
              data-testid="daily-target"
            />
            <span className={styles.unit} aria-hidden="true">calls a day</span>
          </span>
        )}
      />
      {errors.render('daily_target_calls')}
    </>
  );
}
