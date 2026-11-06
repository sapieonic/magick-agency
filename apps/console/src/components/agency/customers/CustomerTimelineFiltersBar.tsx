import { useId } from 'react';
import type {
  CustomerHistorySummary,
  CustomerTimelineChannel,
  CustomerTimelineFilters,
} from '@magick-agency/contracts/api/agency/customer-history';
import type { AgencyAttemptOutcome } from '@magick-agency/contracts/agency/enums';
import { attemptOutcomeLabel } from '@magick-agency/contracts/api/agency/agency-spine';
import { CHANNEL_LABELS } from '../../../utils/customerHistoryCopy';
import { isInvertedDayRange } from '../../../utils/agencyAttemptFilters';
import { actorName } from '../../../utils/agency/insights/copy';
import styles from './CustomerHistory.module.css';

/**
 * `YYYY-MM-DD` (a date input's value), moved on `plusDays`, as the reader's local
 * midnight in an ISO instant. `to` passes 1: the range is half-open, so the day
 * after includes the whole chosen day.
 */
function localDayIso(day: string, plusDays = 0): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d + plusDays);
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
  const from = localDayIso(form.fromDay);
  if (from) filters.from = from;
  const to = localDayIso(form.toDay, 1);
  if (to) filters.to = to;
  if (form.outcome) filters.outcomes = [form.outcome as AgencyAttemptOutcome];
  if (form.dispositionCode) filters.disposition_codes = [form.dispositionCode];
  if (form.agentUserId) filters.agent_user_ids = [form.agentUserId];
  if (form.connectedOnly) filters.connected_only = true;
  if (form.channel) filters.channel = form.channel;
  return filters;
}

/** The British-English refusal for a "To" day before the "From" day; never sent to the server. */
const REVERSED_RANGE_MESSAGE = 'The end date must be on or after the start date.';

/** Both days set and the end before the start (`YYYY-MM-DD` compares as text). */
export function isReversedRange(form: Pick<CustomerTimelineFilterForm, 'fromDay' | 'toDay'>): boolean {
  return isInvertedDayRange(form.fromDay, form.toDay);
}

export function hasAnyFilter(form: CustomerTimelineFilterForm): boolean {
  return Object.keys(filtersFromForm(form)).length > 0;
}

/** A labelled `<select>` whose first option, `''`, means "no filter"; option keys are their values. */
function FilterSelect({
  id,
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  allLabel: string;
  value: string;
  options: readonly (readonly [value: string, label: string])[];
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.filter}>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>{text}</option>
        ))}
      </select>
    </div>
  );
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
  const reversed = isReversedRange(form);
  const rangeErrorId = `${id}-range-error`;
  const set = <K extends keyof CustomerTimelineFilterForm>(key: K, value: CustomerTimelineFilterForm[K]) =>
    onChange({ ...form, [key]: value });

  return (
    <fieldset className={styles.filters} disabled={disabled}>
      <legend className="sr-only">Filter the timeline</legend>
      <FilterSelect
        id={`${id}-campaign`}
        label="Campaign"
        allLabel="All campaigns"
        value={form.campaignId}
        options={options.campaigns.map((c) => [c.id, c.name])}
        onChange={(v) => set('campaignId', v)}
      />
      <div className={styles.filter}>
        <label htmlFor={`${id}-from`}>From</label>
        <input
          id={`${id}-from`}
          type="date"
          value={form.fromDay}
          max={form.toDay || undefined}
          onChange={(e) => set('fromDay', e.target.value)}
          aria-invalid={reversed ? true : undefined}
          aria-describedby={reversed ? rangeErrorId : undefined}
        />
      </div>
      <div className={styles.filter}>
        <label htmlFor={`${id}-to`}>To</label>
        <input
          id={`${id}-to`}
          type="date"
          value={form.toDay}
          min={form.fromDay || undefined}
          onChange={(e) => set('toDay', e.target.value)}
          aria-invalid={reversed ? true : undefined}
          aria-describedby={reversed ? rangeErrorId : undefined}
        />
      </div>
      <FilterSelect
        id={`${id}-outcome`}
        label="Outcome"
        allLabel="All outcomes"
        value={form.outcome}
        options={options.outcomes.map((o) => [o, attemptOutcomeLabel(o)])}
        onChange={(v) => set('outcome', v)}
      />
      <FilterSelect
        id={`${id}-code`}
        label="Outcome code"
        allLabel="All codes"
        value={form.dispositionCode}
        options={options.disposition_codes.map((c) => [c, c])}
        onChange={(v) => set('dispositionCode', v)}
      />
      <FilterSelect
        id={`${id}-agent`}
        label="Agent"
        allLabel="All agents"
        value={form.agentUserId}
        options={options.agents.map((a) => [a.user_id, actorName(a)])}
        onChange={(v) => set('agentUserId', v)}
      />
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
      {reversed && (
        <p id={rangeErrorId} className={styles.fieldError} role="alert" data-testid="customer-filter-range-error">
          {REVERSED_RANGE_MESSAGE}
        </p>
      )}
      {hasAnyFilter(form) && (
        <button type="button" className="btn-secondary" onClick={() => onChange(EMPTY_FILTER_FORM)}>
          Clear filters
        </button>
      )}
    </fieldset>
  );
}
