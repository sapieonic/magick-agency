import type { AgencyCampaign } from '../../../types/agency-campaign';
import { pickerCampaignName } from '../../../utils/agencyCampaignArchive';
import { UNKNOWN_CALLERS_FIELD } from '../../../utils/inbound/routeForm';
import styles from '../../../components/agency/inbound/Inbound.module.css';
import type { RouteSectionProps } from './fields';

/**
 * "Unknown callers" (`docs/call-log.md` §5): the campaign a caller on no list is filed under when
 * they ring this route's numbers, and whose outcomes their call uses. Required while the account's
 * "Every call must belong to a campaign" is on; there is then no "No campaign" to choose.
 */
export function RouteUnknownCallersCard({
  draft, update, errors, campaigns, required,
}: RouteSectionProps & { campaigns: AgencyCampaign[]; required: boolean }) {
  const known = draft.defaultCampaignId === null || campaigns.some((c) => c.id === draft.defaultCampaignId);
  return (
    <section className="card" aria-labelledby="ib-unknown" data-testid="inbound-route-unknown-callers">
      <h2 className={styles.cardTitle} id="ib-unknown">{UNKNOWN_CALLERS_FIELD.title}</h2>
      <div className="form-group">
        <label htmlFor="ib-default-campaign">
          {UNKNOWN_CALLERS_FIELD.label}
          {required ? <span data-testid="inbound-default-campaign-required"> {UNKNOWN_CALLERS_FIELD.required}</span> : null}
        </label>
        <select
          id="ib-default-campaign"
          value={draft.defaultCampaignId ?? ''}
          required={required}
          aria-required={required}
          onChange={(e) => update({ defaultCampaignId: e.target.value || null })}
          aria-describedby={['ib-default-campaign-hint', errors.describedBy('default_campaign_id')].filter(Boolean).join(' ')}
          data-testid="inbound-default-campaign"
        >
          {required
            ? <option value="" disabled={draft.defaultCampaignId !== null}>{UNKNOWN_CALLERS_FIELD.choose}</option>
            : <option value="">{UNKNOWN_CALLERS_FIELD.none}</option>}
          {known ? null : <option value={draft.defaultCampaignId!}>Current campaign</option>}
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{pickerCampaignName(c)}</option>
          ))}
        </select>
        <p className={styles.sub} id="ib-default-campaign-hint">{UNKNOWN_CALLERS_FIELD.hint}</p>
        {errors.render('default_campaign_id')}
      </div>
    </section>
  );
}
