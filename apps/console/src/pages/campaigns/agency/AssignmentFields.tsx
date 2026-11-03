import {
  AGENCY_AGENT_RETRY_COOLDOWN_MINUTES_MAX,
  AGENCY_AGENT_RETRY_ROUNDS_MAX,
  AGENCY_AGENT_RETRY_ROUNDS_MIN,
  AGENCY_ASSIGNMENT_MODES,
  AGENCY_CALLBACK_FALLBACK_VALUES,
  AGENCY_CALLBACK_GRACE_MINUTES_MAX,
  AGENCY_ON_UNSTAFF_VALUES,
  type AgencyCallbackFallback,
  type AgencyOnUnstaff,
} from '@magick-agency/contracts/agency';
import type { AssignmentConfigState } from '../../../utils/agencyCampaignConfigForm';
import {
  ASSIGNMENT_MODE_COPY,
  CALLBACK_FALLBACK_COPY,
  MODE_LOCKED_HINT,
  ON_UNSTAFF_COPY,
} from '../../../utils/agencyAssignmentCopy';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './CampaignBehaviourSection.module.css';

/*
  One of the editors `CampaignBehaviourSection` assembles, shown only while the
  `agency_contact_assignment_enabled` flag is on. Every rule (defaults, bounds,
  what a save sends) lives in `utils/agencyCampaignConfigForm.ts`; this is the
  markup and the copy. Patterned on `WrapupFields`: one `form-group` per
  setting, the hint under it saying what the value DOES.
*/

interface AssignmentFieldsProps {
  assignment: AssignmentConfigState;
  onChange: (next: AssignmentConfigState) => void;
  errors: ConfigFieldErrors;
  /**
   * The campaign is running, stopping or finished: the mode is locked (the server
   * refuses `409 mode_change_requires_pause`), with the reason beside it rather
   * than a control that fails on save.
   */
  modeLocked: boolean;
}

export function AssignmentFields({ assignment, onChange, errors, modeLocked }: AssignmentFieldsProps) {
  const set = (patch: Partial<AssignmentConfigState>) => onChange({ ...assignment, ...patch });
  const ownersMatter = assignment.mode !== 'pool';

  return (
    <>
      <h3 className={styles.subhead}>Assignment</h3>
      <p className={styles.sectionLead}>
        Whether agents work a shared queue or the contacts you assign them, and whether they can
        retry the people they didn’t reach.
      </p>

      <fieldset
        className="form-group"
        disabled={modeLocked}
        aria-describedby={modeLocked ? 'assignment-mode-locked' : errors.describedBy('assignment_mode')}
        data-testid="assignment-mode"
      >
        <legend>How contacts reach agents</legend>
        {AGENCY_ASSIGNMENT_MODES.map((mode) => (
          <label key={mode} className={styles.check}>
            <input
              type="radio"
              name="assignment-mode"
              value={mode}
              checked={assignment.mode === mode}
              onChange={() => set({ mode })}
            />
            <span>
              <strong>{ASSIGNMENT_MODE_COPY[mode].label}</strong>
              {' — '}
              {ASSIGNMENT_MODE_COPY[mode].explain}
            </span>
          </label>
        ))}
        {modeLocked ? (
          <p className={styles.hint} id="assignment-mode-locked" data-testid="assignment-mode-locked">
            {MODE_LOCKED_HINT}
          </p>
        ) : null}
        {errors.render('assignment_mode')}
      </fieldset>

      <div className="form-group">
        <label htmlFor="assignment-on-unstaff">When an agent is taken off this campaign</label>
        <select
          id="assignment-on-unstaff"
          value={assignment.onUnstaff}
          onChange={(event) => set({ onUnstaff: event.target.value as AgencyOnUnstaff })}
          aria-describedby={errors.describedBy('on_unstaff')}
        >
          {AGENCY_ON_UNSTAFF_VALUES.map((value) => (
            <option key={value} value={value}>{ON_UNSTAFF_COPY[value]}</option>
          ))}
        </select>
        {errors.render('on_unstaff')}
        <p className={styles.hint}>
          {assignment.onUnstaff === 'return_to_pool'
            ? 'Their contacts that are still open go back to the pool. A contact on a call stays put.'
            : 'Their contacts stay theirs until you reassign them.'}
        </p>
      </div>

      <div className="form-group">
        <label htmlFor="assignment-callback-grace">
          Minutes a due callback waits for its agent
        </label>
        <input
          id="assignment-callback-grace"
          type="number"
          min={0}
          max={AGENCY_CALLBACK_GRACE_MINUTES_MAX}
          value={assignment.callbackGraceMinutes}
          onChange={(event) => set({ callbackGraceMinutes: Number(event.target.value) })}
          aria-describedby={errors.describedBy('callback_owner_grace_minutes')}
        />
        {errors.render('callback_owner_grace_minutes')}
      </div>

      <div className="form-group">
        <label htmlFor="assignment-callback-fallback">Then</label>
        <select
          id="assignment-callback-fallback"
          value={assignment.callbackFallback}
          onChange={(event) => set({ callbackFallback: event.target.value as AgencyCallbackFallback })}
          aria-describedby={errors.describedBy('callback_fallback')}
        >
          {AGENCY_CALLBACK_FALLBACK_VALUES.map((value) => (
            <option key={value} value={value}>{CALLBACK_FALLBACK_COPY[value]}</option>
          ))}
        </select>
        {errors.render('callback_fallback')}
        <p className={styles.hint} data-testid="assignment-callback-hint">
          {assignment.callbackFallback === 'pool'
            ? `A callback whose agent isn’t on the campaign ${assignment.callbackGraceMinutes} minutes after it falls due loses its agent${
              assignment.mode === 'strict'
                ? ' and waits, unassigned, until you give it to someone.'
                : ' and any agent can take it.'
            }`
            : 'A callback waits for the agent who booked it, however long that takes.'}
          {ownersMatter ? '' : ' Only applies while contacts are assigned to agents.'}
        </p>
      </div>

      <div className="form-group">
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={assignment.allowAgentRetry}
            onChange={(event) => set({ allowAgentRetry: event.target.checked })}
            data-testid="allow-agent-retry"
          />
          Let agents retry the contacts they didn’t reach
        </label>
        <p className={styles.hint}>
          {assignment.allowAgentRetry
            ? 'From My contacts, an agent can put the people they missed back in their queue, or call one straight away.'
            : 'Missed contacts are retried only by the retry rules above.'}
        </p>
      </div>

      {assignment.allowAgentRetry ? (
        <div className={styles.retryFields} data-testid="agent-retry-fields">
          <label className={styles.retryField}>
            up to
            <input
              type="number"
              min={AGENCY_AGENT_RETRY_ROUNDS_MIN}
              max={AGENCY_AGENT_RETRY_ROUNDS_MAX}
              aria-label="Agent retry rounds per contact"
              value={assignment.agentRetryRounds}
              onChange={(event) => set({ agentRetryRounds: Number(event.target.value) })}
              aria-describedby={errors.describedBy('agent_retry_rounds')}
            />
            {assignment.agentRetryRounds === 1 ? 'time' : 'times'} per contact, at least
          </label>
          <label className={styles.retryField}>
            <input
              type="number"
              min={0}
              max={AGENCY_AGENT_RETRY_COOLDOWN_MINUTES_MAX}
              aria-label="Minutes since the last attempt before an agent may retry"
              value={assignment.agentRetryCooldownMinutes}
              onChange={(event) => set({ agentRetryCooldownMinutes: Number(event.target.value) })}
              aria-describedby={errors.describedBy('agent_retry_cooldown_minutes')}
            />
            minutes after the last attempt
          </label>
        </div>
      ) : null}
      {errors.render('agent_retry_rounds')}
      {errors.render('agent_retry_cooldown_minutes')}
    </>
  );
}
