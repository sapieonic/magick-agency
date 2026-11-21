import { useId, useState } from 'react';
import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_MAX_METRICS,
  COMPARE_OUTCOME_LABEL_MAX,
  COMPARE_OUTCOME_SET_MAX_CODES,
  compareMetricId,
  defaultOutcomeSetBetter,
  defaultOutcomeSetLabel,
  type AgencyCompareMetricRef,
  type AgencyCompareOutcomeCode,
  type CompareMetricBetter,
} from '@magick-agency/contracts/api/agency/compare';
import {
  BETTER_CHOICES,
  BETTER_WORDS,
  BUILTIN_COPY,
  GROUP_LABELS,
  addMetric,
  buildOutcomeSet,
  canAddMetric,
  metricLabel,
  outcomeSetProblem,
  pickerGroups,
  removeMetric,
  toggleCode,
  trendChoices,
} from '../../../utils/agency/compare/compareMetrics';
import styles from './Compare.module.css';

/**
 * Metrics · N (`docs/compare-agents.md` §2 item 1, §3, CP17, CP18): the built-ins grouped as the
 * catalog groups them, each marked with its direction, at most six in all; the outcome sets on
 * the page; a builder for a new one (1 to 5 of the campaign's outcome codes, an optional name,
 * which way is better); and the per-day trend's metric. Only what the campaign can show is
 * offered (promise metrics only when it records promises), by the same rule the server checks.
 */
export interface CompareMetricPickerProps {
  id: string;
  metrics: readonly AgencyCompareMetricRef[];
  trend: AgencyCompareMetricRef | null;
  codes: readonly AgencyCompareOutcomeCode[];
  onMetrics: (metrics: AgencyCompareMetricRef[]) => void;
  onTrend: (trend: AgencyCompareMetricRef | null) => void;
}

export function CompareMetricPicker({ id, metrics, trend, codes, onMetrics, onTrend }: CompareMetricPickerProps) {
  const groups = pickerGroups(codes);
  const chosen = new Set(metrics.map(compareMetricId));
  const full = !canAddMetric(metrics);
  const sets = metrics.filter((m): m is Extract<AgencyCompareMetricRef, { kind: 'outcomes' }> => m.kind === 'outcomes');
  const trendOptions = trendChoices(metrics, trend, codes);
  const trendId = trend ? compareMetricId(trend) : '';
  const trendSelectId = useId();

  const toggleBuiltin = (key: keyof typeof COMPARE_BUILTIN_METRICS) => {
    const ref: AgencyCompareMetricRef = { kind: 'builtin', key };
    onMetrics(chosen.has(key) ? removeMetric(metrics, key) : addMetric(metrics, ref));
  };

  return (
    <section id={id} className={`${styles.card} ${styles.picker}`} aria-label="Choose metrics" data-testid="compare-metric-picker">
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>Choose metrics</h3>
        <span className={styles.cardSub}>{`Up to ${COMPARE_MAX_METRICS} in Side by side, in the order you add them. Save a view to keep the choice.`}</span>
      </div>
      <div className={styles.groups}>
        {groups.map(({ group, keys }) => (
          <div key={group}>
            <h4 className={styles.groupTitle}>{GROUP_LABELS[group]}</h4>
            {keys.map((key) => {
              const on = chosen.has(key);
              const disabled = (!on && full) || (on && metrics.length === 1);
              return (
                <label key={key} className={styles.option} data-disabled={disabled || undefined}>
                  <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggleBuiltin(key)} data-metric={key} />
                  <span>
                    {BUILTIN_COPY[key].label}
                    <small>{BETTER_WORDS[COMPARE_BUILTIN_METRICS[key].better]}</small>
                  </span>
                </label>
              );
            })}
            {group === 'outcomes'
              ? sets.map((set) => (
                  <div key={compareMetricId(set)} className={styles.setRow} data-testid="compare-outcome-set">
                    <span>
                      {metricLabel(set, codes)}
                      <small>{`${BETTER_WORDS[set.better]} · your outcome set`}</small>
                    </span>
                    <button
                      type="button"
                      className={styles.removeButton}
                      disabled={metrics.length === 1}
                      onClick={() => onMetrics(removeMetric(metrics, compareMetricId(set)))}
                    >
                      Remove
                    </button>
                  </div>
                ))
              : null}
          </div>
        ))}
      </div>
      {full ? <p className={styles.hint}>Six chosen. Untick one to add another.</p> : null}
      <OutcomeSetBuilder codes={codes} metrics={metrics} onAdd={(ref) => onMetrics(addMetric(metrics, ref))} />
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={trendSelectId}>
          Per-day trend
        </label>
        <select
          id={trendSelectId}
          className={styles.campaignSelect}
          value={trendId}
          onChange={(e) => onTrend(trendOptions.find((t) => compareMetricId(t) === e.target.value) ?? null)}
          data-testid="compare-trend-select"
        >
          <option value="">No trend</option>
          {trendOptions.map((t) => (
            <option key={compareMetricId(t)} value={compareMetricId(t)}>
              {metricLabel(t, codes)}
            </option>
          ))}
        </select>
        <p className={styles.hint}>A count per day: an outcome set’s calls, or promises made.</p>
      </div>
    </section>
  );
}

export interface OutcomeSetBuilderProps {
  codes: readonly AgencyCompareOutcomeCode[];
  metrics: readonly AgencyCompareMetricRef[];
  onAdd: (ref: AgencyCompareMetricRef) => void;
}

/**
 * Add an outcome set (CP17): tick up to five of the campaign's outcome buttons, name it if the
 * codes' own labels will not do, and say which way is better. The direction starts from
 * `defaultOutcomeSetBetter` (higher only for success codes, CP18) and follows the codes until the
 * supervisor chooses one.
 */
export function OutcomeSetBuilder({ codes, metrics, onAdd }: OutcomeSetBuilderProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [chosenBetter, setChosenBetter] = useState<CompareMetricBetter | null>(null);
  const [tried, setTried] = useState(false);
  const ids = useId();
  const better = chosenBetter ?? defaultOutcomeSetBetter(picked, codes);
  const problem = outcomeSetProblem(picked, better, name, metrics, codes);
  const full = picked.length >= COMPARE_OUTCOME_SET_MAX_CODES;

  if (codes.length === 0) return null;

  const add = () => {
    setTried(true);
    if (problem !== null) return;
    onAdd(buildOutcomeSet(picked, better, name, codes));
    setPicked([]);
    setName('');
    setChosenBetter(null);
    setTried(false);
  };

  return (
    <div className={styles.builder} data-testid="compare-outcome-builder">
      <div>
        <h4 className={styles.groupTitle}>Add an outcome set</h4>
        <p className={styles.hint}>
          {`The share of each agent’s calls ending in any of the outcomes you tick. Up to ${COMPARE_OUTCOME_SET_MAX_CODES}.`}
        </p>
      </div>
      <div className={styles.codes} role="group" aria-label="Outcomes">
        {codes.map((c) => {
          const on = picked.includes(c.code);
          const blocked = !on && full;
          return (
            <button
              key={c.code}
              type="button"
              className={styles.codeButton}
              aria-pressed={on}
              aria-disabled={blocked || undefined}
              data-code={c.code}
              onClick={() => {
                if (!blocked) setPicked((prev) => toggleCode(prev, c.code));
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <div className={styles.builderRow}>
        <div className={`${styles.field} ${styles.nameField}`}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-name`}>
            Name (optional)
          </label>
          <input
            id={`${ids}-name`}
            type="text"
            maxLength={COMPARE_OUTCOME_LABEL_MAX}
            placeholder={picked.length ? defaultOutcomeSetLabel(picked, codes) : 'For example, Will pay'}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <fieldset className={styles.radios}>
          <legend>Which way is better?</legend>
          {BETTER_CHOICES.map((choice) => (
            <label key={choice.value}>
              <input
                type="radio"
                name={`${ids}-better`}
                value={choice.value}
                checked={better === choice.value}
                onChange={() => setChosenBetter(choice.value)}
              />
              {choice.label}
            </label>
          ))}
        </fieldset>
        <button type="button" className="btn-secondary" onClick={add} data-testid="compare-outcome-add">
          Add outcome set
        </button>
      </div>
      <p className={styles.hint}>
        {better === 'neutral'
          ? 'Shown beside the others, never flagged.'
          : `An agent is named only when their share is clearly ${better === 'higher' ? 'below' : 'above'} the rest of the team’s.`}
      </p>
      {tried && problem ? (
        <p className={styles.inlineError} role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
