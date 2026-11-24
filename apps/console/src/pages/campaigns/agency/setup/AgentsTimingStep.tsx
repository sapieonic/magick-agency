import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgencyPhoneDisplay } from '@magick-agency/contracts/agency';
import { AdvancedFold, SetupCard, SetupColumns, SetupSection } from '../../../../components/campaign-setup';
import { validateConfig, type CampaignConfigState } from '../../../../utils/agencyCampaignConfigForm';
import { dailyTargetError } from '../../../../utils/agency/stationSettings';
import { hasAdvancedFinding, pickedLine, staffingHint } from '../../../../utils/campaignSetup/agentsTiming';
import type { StaffingAgent } from '../../../../hooks/useCampaignStaffing';
import { useConfigFieldErrors } from '../configFieldErrors';
import { RetryPolicyTable } from '../RetryPolicyTable';
import { AbandonmentCeilingFields } from '../AbandonmentCeilingFields';
import { WrapupFields } from '../WrapupFields';
import { OutcomeDispositionMap } from '../OutcomeDispositionMap';
import { AssignmentFields } from '../AssignmentFields';
import { InboundStickyField } from '../InboundStickyField';
import { AgentPicker } from './AgentPicker';
import { CallingHoursBlock } from './CallingHoursBlock';
import { UnansweredRuleBlock } from './UnansweredRuleBlock';
import { AgentScreenRows, RecordingRows, WrapupRow, type RecordingControls } from './AgentScreenRows';
import type { SetupSectionSources } from './sectionSources';
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
  /** The recording state and the account's gates (`RecordingRows`). */
  recording: RecordingControls;
  /**
   * The daily target and how the customer's number is shown (`AgentScreenRows`, from the page's
   * station form). Left out, neither row shows.
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
  /**
   * Shown at the heading of the block that edits each section (New campaign's template sources,
   * CS18): `hours` on When to call; `retries` on the "doesn't pick up" rule and the retry table;
   * `wrapup` on the wrap-up row; `recording` on the record and call summary rows; `agent_screen`
   * on the number display and daily target rows; and under Advanced `safety`, `assignment`,
   * `inbound` and `breaks` on their blocks.
   */
  sectionSources?: SetupSectionSources;
  /** Injectable for tests; the custom window's echo is clock-derived. */
  now?: Date;
}

const ADVANCED_SUMMARY = 'Advanced settings (most campaigns don’t need these)';

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
  sectionSources,
}: AgentsTimingStepProps) {
  const uid = useId();
  const hintId = `${uid}-staffing-hint`;
  const foldId = `${uid}-advanced`;
  const foldRef = useRef<HTMLDivElement>(null);
  const sources = sectionSources ?? {};
  /** A block under Advanced with its section's source on a line above its own heading. */
  const sourced = (key: keyof SetupSectionSources, block: ReactNode) =>
    (sources[key] ? (
      <div className={styles.sourced} data-testid={`sourced-${key}`}>
        <div className={styles.sourceLine}>{sources[key]}</div>
        {block}
      </div>
    ) : block);

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

  const setRetry = (retryPolicy: CampaignConfigState['retryPolicy']) => onChange({ ...config, retryPolicy });

  /* ── Advanced ───────────────────────────────────────────────────────────── */
  const [ownOpen, setOwnOpen] = useState(false);
  const advancedFinding = hasAdvancedFinding(merged, unansweredOutcomes);
  // A fold the page opened stays open once it lets go, as one the supervisor opened does.
  useEffect(() => {
    if (forceAdvancedOpen) setOwnOpen(true);
  }, [forceAdvancedOpen]);
  const advancedOpen = ownOpen || forceAdvancedOpen || advancedFinding;
  const openAdvanced = () => {
    setOwnOpen(true);
    requestAnimationFrame(() => foldRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  };

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
          <SetupSection
            title="When to call"
            helper="Calls only go out inside these hours."
            actions={sources.hours}
            testId="when-to-call"
            id={anchors?.whenToCall}
          >
            <CallingHoursBlock
              window={config.window}
              onChange={(window) => onChange({ ...config, window })}
              errors={errors}
              readOnly={readOnly}
              now={now}
            />
          </SetupSection>

          <SetupSection title="If the customer doesn’t pick up" actions={sources.retries} testId="unanswered-rule">
            <UnansweredRuleBlock
              retryPolicy={config.retryPolicy}
              onChange={setRetry}
              readOnly={readOnly}
              onSeeDetails={openAdvanced}
            />
          </SetupSection>

          <SetupSection title="Agent screen" testId="agent-screen" id={anchors?.agentScreen}>
            <div className={styles.rows}>
              <WrapupRow
                wrapupSeconds={config.wrapupSeconds}
                autoReturn={config.autoReturn}
                onChange={(wrapupSeconds) => onChange({ ...config, wrapupSeconds })}
                errors={errors}
                readOnly={readOnly}
                badge={sources.wrapup}
              />
              <RecordingRows
                recording={recording}
                errors={errors}
                profilesErrorConsequence={mode === 'create'
                  ? 'You can save without one and set it later in the campaign’s Settings.'
                  : 'Saving without changing this leaves the campaign’s current profile alone.'}
                readOnly={readOnly}
                badge={sources.recording}
              />
              {agentScreen ? (
                <AgentScreenRows
                  dailyTarget={agentScreen.dailyTarget}
                  phoneDisplay={agentScreen.phoneDisplay}
                  onChange={agentScreen.onChange}
                  errors={errors}
                  readOnly={readOnly}
                  badge={sources.agent_screen}
                />
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
              {sourced('retries', <RetryPolicyTable retryPolicy={config.retryPolicy} onChange={setRetry} errors={errors} />)}
              {sourced('safety', (
                <AbandonmentCeilingFields
                  ceilingPct={config.abandonmentCeilingPct}
                  storedPct={config.abandonmentCeilingStoredPct}
                  onChange={(abandonmentCeilingPct) => onChange({ ...config, abandonmentCeilingPct })}
                  errors={errors}
                  readOnly={readOnly}
                />
              ))}
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
                {assignment ? sourced('assignment', (
                  <AssignmentFields
                    assignment={config.assignment}
                    onChange={(next) => onChange({ ...config, assignment: next })}
                    errors={errors}
                    modeLocked={assignment.modeLocked}
                  />
                )) : null}
                {inbound ? sourced('inbound', (
                  <InboundStickyField
                    checked={config.inboundSticky}
                    onChange={(inboundSticky) => onChange({ ...config, inboundSticky })}
                  />
                )) : null}
                {breakLimits ? sourced('breaks', breakLimits) : null}
              </div>
            ) : null}
          </div>
        </AdvancedFold>
      </div>
    </div>
  );
}
