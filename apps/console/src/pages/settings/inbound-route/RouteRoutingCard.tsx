import { STICKY_MODE_LABELS, STICKY_WAIT_FIELD } from '../../../utils/inbound/inboundCopy';
import { AGENCY_INBOUND_STICKY_MODES } from '../../../types/inbound';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import styles from '../../../components/agency/inbound/Inbound.module.css';
import { NumberField, type RouteSectionProps } from './fields';

/**
 * "Who answers": the caller's agent first (IB2: off, prefer, or wait for them), how long and how
 * far back, and the team (the campaigns whose agents take the calls; none ticked: every agent live
 * on a campaign in the account).
 */
export function RouteRoutingCard({ draft, update, errors, campaigns }: RouteSectionProps & { campaigns: AgencyCampaign[] }) {
  const stickyOff = draft.stickyMode === 'off';
  const togglePool = (id: string) =>
    update({
      poolCampaignIds: draft.poolCampaignIds.includes(id)
        ? draft.poolCampaignIds.filter((c) => c !== id)
        : [...draft.poolCampaignIds, id],
    });
  return (
    <section className="card" aria-labelledby="ib-routing" data-testid="inbound-route-routing">
      <h2 className={styles.cardTitle} id="ib-routing">Who answers</h2>
      <p className={styles.cardLead}>
        A caller we recognise goes to the agent they last dealt with first: the contact’s owner, the agent who last called
        them from this number, or the last agent who spoke to them.
      </p>
      <fieldset className={styles.radioGroup}>
        <legend>Their agent first</legend>
        {AGENCY_INBOUND_STICKY_MODES.map((mode) => (
          <label key={mode} className={styles.choice}>
            <input
              type="radio"
              name="ib-sticky-mode"
              value={mode}
              checked={draft.stickyMode === mode}
              onChange={() => update({ stickyMode: mode })}
              data-testid={`inbound-sticky-${mode}`}
            />
            <span>
              {STICKY_MODE_LABELS[mode].label}
              <span className={styles.sub}>{STICKY_MODE_LABELS[mode].hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className={styles.fields}>
        <NumberField id="ib-sticky-wait" label={STICKY_WAIT_FIELD.label} value={draft.stickyWait} disabled={stickyOff}
          hint={draft.stickyMode === 'strict' ? STICKY_WAIT_FIELD.strictHint : STICKY_WAIT_FIELD.hint}
          onChange={(v) => update({ stickyWait: v })} errors={errors} path="sticky_wait_seconds" />
        <NumberField id="ib-sticky-lookback" label="Look back (days)" value={draft.stickyLookback} disabled={stickyOff}
          hint="How far back a past call makes an agent theirs."
          onChange={(v) => update({ stickyLookback: v })} errors={errors} path="sticky_lookback_days" />
      </div>
      <h3 className={styles.cardTitle}>The team</h3>
      <p className={styles.cardLead}>
        {draft.poolCampaignIds.length === 0
          ? 'Any agent live on a campaign in this account. Choose campaigns to narrow it to agents staffed on them.'
          : 'Only agents staffed on the campaigns ticked here.'}
      </p>
      {campaigns.length > 0 ? (
        <ul className={styles.choiceList} aria-label="Campaigns whose agents take these calls">
          {campaigns.map((c) => {
            const id = `ib-pool-${c.id}`;
            return (
              <li key={c.id} className={styles.choice}>
                <input type="checkbox" id={id} checked={draft.poolCampaignIds.includes(c.id)} onChange={() => togglePool(c.id)} />
                <label htmlFor={id}>{c.name}</label>
              </li>
            );
          })}
        </ul>
      ) : null}
      {errors.render('pool_campaign_ids')}
      {draft.poolCampaignIds.map((_, i) => errors.render(`pool_campaign_ids[${i}]`))}
    </section>
  );
}
