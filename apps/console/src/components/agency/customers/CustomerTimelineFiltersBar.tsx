import { useId } from 'react';
import type {
  CustomerHistorySummary,
  CustomerTimelineChannel,
  CustomerTimelineFilters,
} from '@magick-agency/contracts/api/agency/customer-history';
import type { AgencyAttemptOutcome } from '@magick-agency/contracts/agency/enums';
import { attemptOutcomeLabel } from '@magick-agency/contracts/api/agency/agency-spine';
import { CHANNEL_LABELS } from '../../../utils/customerHistoryCopy';
import styles from './CustomerHistory.module.css';

/** `YYYY-MM-DD` (a date input's value) → the reader's local midnight, as an ISO instant. */
export function dayStartIso(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The day after, so `to` (half-open) includes the whole chosen day. */
export function dayEndExclusiveIso(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d + 1);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The form's own values; `filtersFromForm` turns them into the wire filters. */
export interface CustomerTimelineFilterForm {
  campaignId: string;
  fromDay: string;
  toDay: string;
  outcome: string;
  dispositionCode: string;
  agentUserId: string;
  connectedOnly: boolean;
  channel: '' | CustomerTimelineChannel;
}

export const EMPTY_FILTER_FORM: CustomerTimelineFilterForm = {
  campaignId: '',
  fromDay: '',
  toDay: '',
  outcome: '',
  dispositionCode: '',
  agentUserId: '',
  connectedOnly: false,
  channel: '',
};

export function filtersFromForm(form: CustomerTimelineFilterForm): CustomerTimelineFilters {
  const filters: CustomerTimelineFilters = {};
  if (form.campaignId) filters.campaign_ids = [form.campaignId];
  const from = form.fromDay ? dayStartIso(form.fromDay) : undefined;
  if (from) filters.from = from;
  const to = form.toDay ? dayEndExclusiveIso(form.toDay) : undefined;
  if (to) filters.to = to;
  if (form.outcome) filters.outcomes = [form.outcome as AgencyAttemptOutcome];
  if (form.dispositionCode) filters.disposition_codes = [form.dispositionCode];
  if (form.agentUserId) filters.agent_user_ids = [form.agentUserId];
  if (form.connectedOnly) filters.connected_only = true;
  if (form.channel) filters.channel = form.channel;
  return filters;
}

export function hasAnyFilter(form: CustomerTimelineFilterForm): boolean {
  return Object.keys(filtersFromForm(form)).length > 0;
}

export function CustomerTimelineFiltersBar({
  options,
  form,
  onChange,
  disabled,
}: {
  options: CustomerHistorySummary['filter_options'];
  form: CustomerTimelineFilterForm;
  onChange: (next: CustomerTimelineFilterForm) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const set = <K extends keyof CustomerTimelineFilterForm>(key: K, value: CustomerTimelineFilterForm[K]) =>
    onChange({ ...form, [key]: value });

  return (
    <fieldset className={styles.filters} disabled={disabled}>
      <legend className="sr-only">Filter the timeline</legend>
      <div className={styles.filter}>
        <label htmlFor={`${id}-campaign`}>Campaign</label>
        <select id={`${id}-campaign`} value={form.campaignId} onChange={(e) => set('campaignId', e.target.value)}>
          <option value="">All campaigns</option>
          {options.campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <div className={styles.filter}>
        <label htmlFor={`${id}-from`}>From</label>
        <input id={`${id}-from`} type="date" value={form.fromDay} onChange={(e) => set('fromDay', e.target.value)} />
      </div>
      <div className={styles.filter}>
        <label htmlFor={`${id}-to`}>To</label>
        <input id={`${id}-to`} type="date" value={form.toDay} onChange={(e) => set('toDay', e.target.value)} />
      </div>
      <div className={styles.filter}>
        <label htmlFor={`${id}-outcome`}>Outcome</label>
        <select id={`${id}-outcome`} value={form.outcome} onChange={(e) => set('outcome', e.target.value)}>
          <option value="">All outcomes</option>
          {options.outcomes.map((o) => (
            <option key={o} value={o}>{attemptOutcomeLabel(o)}</option>
          ))}
        </select>
      </div>
      <div className={styles.filter}>
        <label htmlFor={`${id}-code`}>Outcome code</label>
        <select id={`${id}-code`} value={form.dispositionCode} onChange={(e) => set('dispositionCode', e.target.value)}>
          <option value="">All codes</option>
          {options.disposition_codes.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className={styles.filter}>
        <label htmlFor={`${id}-agent`}>Agent</label>
        <select id={`${id}-agent`} value={form.agentUserId} onChange={(e) => set('agentUserId', e.target.value)}>
          <option value="">All agents</option>
          {options.agents.map((a) => (
            <option key={a.user_id} value={a.user_id}>{a.name ?? 'A former user'}</option>
          ))}
        </select>
      </div>
      <div className={styles.filter}>
        <label htmlFor={`${id}-channel`}>Channel</label>
        <select
          id={`${id}-channel`}
          value={form.channel}
          onChange={(e) => set('channel', e.target.value as CustomerTimelineFilterForm['channel'])}
        >
          <option value="">Campaign and soft phone</option>
          <option value="campaign">{CHANNEL_LABELS.campaign}s only</option>
          <option value="softphone">{CHANNEL_LABELS.softphone}s only</option>
        </select>
      </div>
      <div className={`${styles.filter} ${styles.checkFilter}`}>
        <input
          id={`${id}-connected`}
          type="checkbox"
          checked={form.connectedOnly}
          onChange={(e) => set('connectedOnly', e.target.checked)}
        />
        <label htmlFor={`${id}-connected`}>Connected calls only</label>
      </div>
      {hasAnyFilter(form) && (
        <button type="button" className="btn-secondary" onClick={() => onChange(EMPTY_FILTER_FORM)}>
          Clear filters
        </button>
      )}
    </fieldset>
  );
}
