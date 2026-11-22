import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgencyPhoneDisplay } from '@magick-agency/contracts/agency';
import {
  AdvancedFold,
  PillGroup,
  Sentence,
  SentenceSelect,
  SetupCard,
  SetupColumns,
  SetupSection,
  SwitchRow,
  type SentenceSelectOption,
} from '../../../../components/campaign-setup';
import { validateConfig, type CampaignConfigState, type CallingWindowState } from '../../../../utils/agencyCampaignConfigForm';
import {
  NO_ANALYSIS_PROFILE,
  analysisGate,
  recordingGate,
  resolveProfileId,
  storedProfileStatus,
  type CampaignRecordingState,
} from '../../../../utils/agencyCampaignRecording';
import { dailyTargetError, PHONE_DISPLAY_SAMPLE } from '../../../../utils/agency/stationSettings';
import { phoneForDisplay } from '../../../../utils/agency/stationFormat';
import {
  HOURS_PRESETS,
  DAY_PILLS,
  dayPillValues,
  daysFromPills,
  presetOfWindow,
  withPreset,
  type HoursChoice,
} from '../../../../utils/campaignSetup/hoursPresets';
import {
  attemptOptions,
  delayOptions,
  startingRuleOf,
  unansweredRuleOf,
  withUnansweredRule,
} from '../../../../utils/campaignSetup/unansweredRule';
import {
  CUSTOM_HOURS_FIELDS,
  isAdvancedField,
  pickedLine,
  staffingHint,
  wrapupOptions,
} from '../../../../utils/campaignSetup/agentsTiming';
import type { CallAnalysisProfile } from '../../../../types/call-analysis-profile';
import type { StaffingAgent } from '../../../../hooks/useCampaignStaffing';
import { useConfigFieldErrors } from '../configFieldErrors';
import { CallingHoursFields } from '../CallingHoursFields';
import { RetryPolicyTable } from '../RetryPolicyTable';
import { AbandonmentCeilingFields } from '../AbandonmentCeilingFields';
import { WrapupFields } from '../WrapupFields';
import { OutcomeDispositionMap } from '../OutcomeDispositionMap';
import { AssignmentFields } from '../AssignmentFields';
import { InboundStickyField } from '../InboundStickyField';
import { AgentPicker } from './AgentPicker';
import styles from './AgentsTimingStep.module.css';

export { readyLine } from '../../../../utils/campaignSetup/agentsTiming';

/**
 * Step 4, "Agents & timing" ("Who calls, and when"): CS10–CS14.
 *
 * Left, who will call (CS10): the account's people as tick cards, and a line saying how
 * customers reach them under the campaign's assignment mode. Right, when to call (CS11: hour
 * presets or Custom, day pills), the one "doesn't pick up" rule (CS12) and the agent screen's
 * switches (wrap-up time, recording and the call summary behind their capabilities, the phone
 * number and the daily target; CS14: only what exists). Below, the Advanced fold (CS13), which
 * opens by itself while a finding is inside it.
 *
 * Controlled: the page owns the config, the ticks, the recording state and the save. Findings
 * are the form's own (`validateConfig`, and the daily target's) shown quietly as they happen,
 * with the server's `fieldErrors` from the last save winning, as `CampaignBehaviourSection` does.
 */
export interface AgentsTimingStepProps {
  config: CampaignConfigState;
  onChange: (next: CampaignConfigState) => void;
  /** The server's `details` from the last save, keyed by body path. */
  fieldErrors: Record<string, string>;
  /** New campaign or Settings: only the wording of a failed profile list differs. */
  mode: 'create' | 'edit';
  /** The ticks; `agents`, `loading`, `error`, `onRetry` and `invitePath` from `useCampaignStaffing`. */
  staffing: {
    agents: readonly StaffingAgent[];
    selected: readonly string[];
    onChange: (ids: string[]) => void;
    loading: boolean;
    error: string | null;
    onRetry?: () => void;
    invitePath?: string | null;
  };
  recording: {
    state: CampaignRecordingState;
    onChange: (next: CampaignRecordingState) => void;
    /** The account's `agency.recording`. */
    recordingEnabled: boolean;
    /** The account's `agency.analytics`. */
    analyticsEnabled: boolean;
    profiles: CallAnalysisProfile[];
    profilesLoading: boolean;
    profilesError: string | null;
    /** The profile the server holds (`null` for none, and for a campaign not yet saved). */
    savedProfileId: string | null;
  };
  /**
   * The daily target and how the customer's number is shown (`AgentScreenFields`' two settings,
   * the page's station form). Left out, neither row shows.
   */
  agentScreen?: {
    dailyTarget: string;
    phoneDisplay: AgencyPhoneDisplay;
    onChange: (patch: { dailyTarget?: string; phoneDisplay?: AgencyPhoneDisplay }) => void;
  };
  /** The break limits editor (`BreakLimitsEditor`), rendered last in Advanced when given. */
  breakLimits?: ReactNode;
  /** The `agency_contact_assignment_enabled` flag is on (as `CampaignBehaviourSection` takes it). */
  assignment?: { modeLocked: boolean };
  /** The `agency_inbound_enabled` flag is on: "Put callers through to their agent". */
  inbound?: boolean;
  /**
   * The automatic outcomes for unanswered calls (`OutcomeDispositionMap`) in Advanced, as CS13
   * lists them. On by default; `false` when another step shows them.
   */
  unansweredOutcomes?: boolean;
  /**
   * Open the Advanced fold whatever is in it (e.g. a break-limit finding the page holds, or a link
   * to a setting inside it). Held open while true; once opened this way it stays open, as a fold
   * the supervisor opened does, until they close it.
   */
  forceAdvancedOpen?: boolean;
  /**
   * Element ids for links into the step (Settings' `…/settings#<id>`): When to call, the Agent
   * screen switches, and under Advanced the retry rules (the table and the abandonment limit) and
   * the agents' rules (contact assignment, inbound callers and the break limits).
   */
  anchors?: { whenToCall?: string; agentScreen?: string; retries?: string; agentRules?: string };
  /** The viewer cannot write campaigns: every control is locked. */
  readOnly?: boolean;
  /** Injectable for tests; the custom window's echo is clock-derived. */
  now?: Date;
}

const ADVANCED_SUMMARY = 'Advanced settings (most campaigns don’t need these)';
const SUMMARY_OFF_REASON = 'Call summaries are turned off for this account. Ask an administrator to turn them on.';

export function AgentsTimingStep({
  config,
  onChange,
  fieldErrors,
  mode,
  staffing,
  recording,
  agentScreen,
  breakLimits,
  assignment,
  inbound = false,
  unansweredOutcomes = true,
  forceAdvancedOpen = false,
  anchors,
  readOnly = false,
  now,
}: AgentsTimingStepProps) {
  const uid = useId();
  const hintId = `${uid}-staffing-hint`;
  const foldId = `${uid}-advanced`;
  const foldRef = useRef<HTMLDivElement>(null);

  /* ── Findings ───────────────────────────────────────────────────────────── */
  const dailyTarget = agentScreen?.dailyTarget;
  const live = useMemo(() => {
    if (readOnly) return {};
    const found = validateConfig(config);
    const target = dailyTarget === undefined ? null : dailyTargetError(dailyTarget);
    return target ? { ...found, daily_target_calls: target } : found;
  }, [readOnly, config, dailyTarget]);
  const merged = useMemo(() => ({ ...live, ...fieldErrors }), [live, fieldErrors]);
  const quiet = useMemo(
    () => new Set(Object.keys(live).filter((field) => !(field in fieldErrors))),
    [live, fieldErrors],
  );
  const errors = useConfigFieldErrors(merged, quiet);

  /* ── When to call ───────────────────────────────────────────────────────── */
  const setWindow = (window: CallingWindowState) => onChange({ ...config, window });
  const [customChosen, setCustomChosen] = useState(false);
  const hoursFinding = CUSTOM_HOURS_FIELDS.some((field) => merged[field] !== undefined);
  const hoursChoice: HoursChoice = customChosen || hoursFinding ? 'custom' : presetOfWindow(config.window);
  const hoursOptions = [
    ...HOURS_PRESETS.map((p) => ({ value: p.id as HoursChoice, label: p.label })),
    { value: 'custom' as HoursChoice, label: 'Custom' },
  ];

  /* ── The "doesn't pick up" rule ─────────────────────────────────────────── */
  const rule = unansweredRuleOf(config.retryPolicy);
  const setRetry = (retryPolicy: CampaignConfigState['retryPolicy']) => onChange({ ...config, retryPolicy });

  /* ── Advanced ───────────────────────────────────────────────────────────── */
  const [ownOpen, setOwnOpen] = useState(false);
  const advancedFinding = Object.keys(merged).some(
    (field) => isAdvancedField(field) && (unansweredOutcomes || !field.startsWith('outcome_dispositions')),
  );
  // A fold the page opened stays open once it lets go, as one the supervisor opened does.
  useEffect(() => {
    if (forceAdvancedOpen) setOwnOpen(true);
  }, [forceAdvancedOpen]);
  const advancedOpen = ownOpen || forceAdvancedOpen || advancedFinding;
  const openAdvanced = () => {
    setOwnOpen(true);
    requestAnimationFrame(() => foldRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  };

  /* ── Recording and the call summary (CS14) ──────────────────────────────── */
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
    The profiles, as `CampaignCallSummaryField` offers them: with the capability on, the list, and
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
    <div className={styles.step}>
      <SetupColumns testId="agents-timing-columns">
        <SetupCard title="Who will call" helper={pickedLine(staffing.selected.length)} testId="who-will-call">
          <AgentPicker
            agents={staffing.agents}
            selected={staffing.selected}
            onChange={staffing.onChange}
            loading={staffing.loading}
            error={staffing.error}
            onRetry={staffing.onRetry}
            invitePath={staffing.invitePath ?? null}
            disabled={readOnly}
            describedBy={hintId}
          />
          <p id={hintId} className={styles.hint} data-testid="staffing-hint">
            {staffingHint(config.assignment)}
          </p>
        </SetupCard>

        <SetupCard testId="call-timing">
          <SetupSection title="When to call" helper="Calls only go out inside these hours." testId="when-to-call" id={anchors?.whenToCall}>
            <PillGroup
              legend="Calling hours"
              hideLegend
              options={hoursOptions}
              value={hoursChoice}
              onChange={(choice) => {
                if (choice === 'custom') {
                  setCustomChosen(true);
                  return;
                }
                setCustomChosen(false);
                setWindow(withPreset(config.window, choice));
              }}
              disabled={readOnly}
              testId="hours-presets"
            />
            {hoursChoice === 'custom' ? (
              <div className={styles.custom} data-testid="custom-hours">
                <CallingHoursFields
                  window={config.window}
                  onChange={setWindow}
                  errors={errors}
                  now={now}
                  days={false}
                />
              </div>
            ) : (
              <p className={styles.hint} data-testid="hours-zone">
                {`In each customer’s own time zone; ${config.window.timezone} when it is not known.`}
              </p>
            )}
            <PillGroup
              multiple
              legend="Calling days"
              size="sm"
              options={DAY_PILLS}
              value={dayPillValues(config.window.days)}
              onChange={(values) => setWindow({ ...config.window, days: daysFromPills(values) })}
              disabled={readOnly}
              describedBy={errors.describedBy('calling_days')}
              testId="calling-days"
            />
            {errors.render('calling_days')}
          </SetupSection>

          <SetupSection title="If the customer doesn’t pick up" testId="unanswered-rule">
            <div className={styles.tinted}>
              {rule.kind === 'same' ? (
                <>
                  <Sentence testId="unanswered-sentence">
                    Make up to{' '}
                    <SentenceSelect
                      value={String(rule.maxAttempts)}
                      options={attemptOptions(rule.maxAttempts)}
                      onChange={(v) => setRetry(withUnansweredRule(config.retryPolicy, { ...rule, maxAttempts: Number(v) }))}
                      ariaLabel="Calls in all to a customer who doesn’t pick up"
                      disabled={readOnly}
                      testId="unanswered-attempts"
                    />{' '}
                    in all
                    {rule.maxAttempts > 1 ? (
                      <>
                        ,{' '}
                        <SentenceSelect
                          value={String(rule.delayMinutes)}
                          options={delayOptions(rule.delayMinutes)}
                          onChange={(v) => setRetry(withUnansweredRule(config.retryPolicy, { ...rule, delayMinutes: Number(v) }))}
                          ariaLabel="Time between calls"
                          disabled={readOnly}
                          testId="unanswered-delay"
                        />{' '}
                        apart.
                      </>
                    ) : (
                      '.'
                    )}
                  </Sentence>
                  <p className={styles.hint}>
                    If the line is busy, switched off or the call can’t connect, the same rule applies. A call
                    our side drops has its own limit, under Advanced settings.
                  </p>
                </>
              ) : (
                <div data-testid="unanswered-mixed">
                  <p className={styles.mixedSummary}>{`${rule.summary}.`}</p>
                  <ul className={styles.mixedList}>
                    {rule.details.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <div className={styles.actions}>
                    <button type="button" className={styles.linkButton} onClick={openAdvanced} data-testid="unanswered-see-advanced">
                      See them in Advanced settings
                    </button>
                    {readOnly ? null : (
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => setRetry(withUnansweredRule(config.retryPolicy, startingRuleOf(config.retryPolicy)))}
                        data-testid="unanswered-use-one"
                      >
                        Use one rule for all
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </SetupSection>

          <SetupSection title="Agent screen" testId="agent-screen" id={anchors?.agentScreen}>
            <div className={styles.rows}>
              <SwitchRow
                label="Time to choose “What happened?” after each call"
                hint={config.wrapupSeconds === 0
                  ? 'Agents go straight back to available after a call.'
                  : config.autoReturn
                    ? 'Then the next call can come to them by itself.'
                    : 'They stay in wrap-up until they say they are ready.'}
                checked={config.wrapupSeconds > 0}
                onChange={() => {}}
                testId="wrapup-row"
                control={({ describedBy }) => (
                  <SentenceSelect
                    value={String(config.wrapupSeconds)}
                    options={wrapupOptions(config.wrapupSeconds)}
                    onChange={(v) => onChange({ ...config, wrapupSeconds: Number(v) })}
                    ariaLabel="Time to choose what happened after each call"
                    describedBy={[describedBy, errors.describedBy('wrapup_seconds')].filter(Boolean).join(' ') || undefined}
                    invalid={errors.message('wrapup_seconds') !== null}
                    disabled={readOnly}
                    testId="wrapup-seconds"
                  />
                )}
              />
              {errors.render('wrapup_seconds')}

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
              />
              {errors.render('record_calls')}

              <SwitchRow
                label="Call summary"
                hint={[
                  storedProfileId === null
                    ? 'No summary is written for this campaign’s calls.'
                    : 'Each connected call is summarised once it ends. A summary needs a recording, so keep recording on.',
                  summaryGate.notice,
                  recording.profilesError
                    ? `Could not load your summary profiles (${recording.profilesError}). ${mode === 'create'
                      ? 'You can save without one and set it later in the campaign’s Settings.'
                      : 'Saving without changing this leaves the campaign’s current profile alone.'}`
                    : null,
                ].filter(Boolean).join(' ')}
                checked={storedProfileId !== null}
                onChange={() => {}}
                disabled={summaryLocked}
                disabledReason={summaryOff && !readOnly ? SUMMARY_OFF_REASON : undefined}
                testId="summary-row"
                control={({ describedBy }) => (
                  <SentenceSelect
                    value={rec.profileId}
                    options={summaryOptions}
                    onChange={(profileId) => recording.onChange({ ...rec, profileId })}
                    ariaLabel="Call summary"
                    describedBy={[describedBy, errors.describedBy('analysis_profile_id')].filter(Boolean).join(' ') || undefined}
                    invalid={errors.message('analysis_profile_id') !== null}
                    disabled={summaryLocked}
                    testId="summary-profile"
                  />
                )}
              />
              {errors.render('analysis_profile_id')}

              {agentScreen ? (
                <>
                  <SwitchRow
                    label="Show full phone number to agents"
                    hint={agentScreen.phoneDisplay === 'full'
                      ? `Agents see the whole number: ${phoneForDisplay(PHONE_DISPLAY_SAMPLE, 'full')}.`
                      : `Agents see only the first two and last three digits: ${phoneForDisplay(PHONE_DISPLAY_SAMPLE, 'masked')}. The soft phone and customer history still have the number.`}
                    checked={agentScreen.phoneDisplay === 'full'}
                    onChange={(full) => agentScreen.onChange({ phoneDisplay: full ? 'full' : 'masked' })}
                    disabled={readOnly}
                    testId="phone-display-row"
                  />
                  {errors.render('phone_display')}

                  <SwitchRow
                    label="Daily target for each agent"
                    hint="Calls where the customer spoke, each day. Agents see how close they are. Leave it empty for no target."
                    checked={agentScreen.dailyTarget.trim() !== ''}
                    onChange={() => {}}
                    testId="daily-target-row"
                    control={({ labelId, describedBy }) => (
                      <span className={styles.target}>
                        <input
                          className={styles.targetInput}
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="None"
                          value={agentScreen.dailyTarget}
                          disabled={readOnly}
                          onChange={(event) => agentScreen.onChange({ dailyTarget: event.target.value })}
                          aria-labelledby={labelId}
                          aria-describedby={[describedBy, errors.describedBy('daily_target_calls')].filter(Boolean).join(' ') || undefined}
                          aria-invalid={errors.message('daily_target_calls') ? true : undefined}
                          data-testid="daily-target"
                        />
                        <span className={styles.unit} aria-hidden="true">calls a day</span>
                      </span>
                    )}
                  />
                  {errors.render('daily_target_calls')}
                </>
              ) : null}
            </div>
          </SetupSection>
        </SetupCard>
      </SetupColumns>

      <div ref={foldRef}>
        <AdvancedFold
          summary={ADVANCED_SUMMARY}
          open={advancedOpen}
          onToggle={setOwnOpen}
          id={foldId}
          testId="advanced-settings"
        >
          <div className={styles.advanced}>
            <div className={styles.advanced} id={anchors?.retries}>
              <RetryPolicyTable retryPolicy={config.retryPolicy} onChange={setRetry} errors={errors} />
              <AbandonmentCeilingFields
                ceilingPct={config.abandonmentCeilingPct}
                storedPct={config.abandonmentCeilingStoredPct}
                onChange={(abandonmentCeilingPct) => onChange({ ...config, abandonmentCeilingPct })}
                errors={errors}
                readOnly={readOnly}
              />
            </div>
            {unansweredOutcomes ? (
              <OutcomeDispositionMap
                mapping={config.outcomeDispositions}
                dispositions={config.dispositions}
                onChange={(outcomeDispositions) => onChange({ ...config, outcomeDispositions })}
                fieldErrors={fieldErrors}
              />
            ) : null}
            <WrapupFields
              wrapupSeconds={config.wrapupSeconds}
              autoReturn={config.autoReturn}
              allowRedial={config.allowWrapupRedial}
              onChange={(patch) => onChange({ ...config, ...patch })}
              errors={errors}
              seconds={false}
            />
            {assignment || inbound || breakLimits ? (
              <div className={styles.advanced} id={anchors?.agentRules}>
                {assignment ? (
                  <AssignmentFields
                    assignment={config.assignment}
                    onChange={(next) => onChange({ ...config, assignment: next })}
                    errors={errors}
                    modeLocked={assignment.modeLocked}
                  />
                ) : null}
                {inbound ? (
                  <InboundStickyField
                    checked={config.inboundSticky}
                    onChange={(inboundSticky) => onChange({ ...config, inboundSticky })}
                  />
                ) : null}
                {breakLimits ?? null}
              </div>
            ) : null}
          </div>
        </AdvancedFold>
      </div>
    </div>
  );
}
