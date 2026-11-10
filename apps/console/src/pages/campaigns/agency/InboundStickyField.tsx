import styles from './CampaignBehaviourSection.module.css';

/**
 * "Put callers through to their agent" (`inbound_sticky_enabled`, inbound P2): a customer of
 * this campaign who rings in reaches the agent they last dealt with first, as the inbound
 * route's sticky mode says (prefer, or only); off, they go to the team like any other caller.
 * One of the editors `CampaignBehaviourSection` assembles, shown only with inbound calls on.
 */
export function InboundStickyField({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="form-group">
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby="inbound-sticky-hint"
          data-testid="inbound-sticky-enabled"
        />
        Put callers through to their agent
      </label>
      <p className={styles.hint} id="inbound-sticky-hint" data-testid="inbound-sticky-hint">
        {checked
          ? 'When one of this campaign’s customers rings in, they go to the agent they last spoke to first, as the number’s inbound route says.'
          : 'This campaign’s customers who ring in go to the next free agent, like any other caller.'}
      </p>
    </div>
  );
}
