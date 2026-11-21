import { useId } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { COMPARE_LENSES, type CompareLens } from '@magick-agency/contracts/api/agency/compare';
import { COMPARE_WINDOW_PRESETS, type CompareWindowPreset } from '../../../utils/agency/compare/compareUrl';
import { LENS_LABELS } from '../../../utils/agency/compare/compareMetrics';
import styles from './Compare.module.css';

/**
 * Compare agents' filters (`docs/compare-agents.md` §2 item 1): the campaign, the window (with its
 * dates for a custom one), the lens buttons and Metrics · N, which opens the picker the page holds.
 */
export interface CompareFiltersProps {
  /** Null while the list loads. */
  campaigns: ReadonlyArray<{ id: string; name: string }> | null;
  campaignId: string | null;
  /** What a campaign the URL holds that the list leaves out is called ("Diwali dues (archived)"). */
  heldName: string;
  onCampaign: (campaignId: string) => void;
  when: CompareWindowPreset;
  /** A custom window's dates as the URL holds them. */
  from: string | null;
  to: string | null;
  /** Today in the page's zone: the latest day a date picker offers. */
  today: string;
  onWindow: (preset: CompareWindowPreset) => void;
  onDates: (dates: { from: string | null } | { to: string | null }) => void;
  /** Why a custom window can't be asked yet; shown only for a custom window. */
  dateError: string | null;
  /** The lens and how many metrics are on the page; null until the campaign's options are in. */
  shape: { lens: CompareLens; metricCount: number } | null;
  onLens: (lens: CompareLens) => void;
  pickerOpen: boolean;
  pickerId: string;
  onTogglePicker: () => void;
}

export function CompareFilters(props: CompareFiltersProps) {
  const { campaigns, campaignId, heldName, onCampaign, when, from, to, today, onWindow, onDates, dateError, shape, onLens, pickerOpen, pickerId, onTogglePicker } = props;
  const ids = useId();
  const listed = campaigns?.some((c) => c.id === campaignId) ?? false;
  return (
    <>
      <div className={styles.filters}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-campaign`}>
            Campaign
          </label>
          <select
            id={`${ids}-campaign`}
            className={styles.campaignSelect}
            value={campaignId ?? ''}
            disabled={campaigns === null}
            onChange={(e) => e.target.value && onCampaign(e.target.value)}
            data-testid="compare-campaign"
          >
            {campaigns === null ? <option value="">Loading campaigns…</option> : null}
            {campaigns !== null && !campaignId ? <option value="">Choose a campaign</option> : null}
            {campaignId && campaigns !== null && !listed ? <option value={campaignId}>{heldName}</option> : null}
            {(campaigns ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-when`}>
            When
          </label>
          <select id={`${ids}-when`} value={when} onChange={(e) => onWindow(e.target.value as CompareWindowPreset)} data-testid="compare-when">
            {COMPARE_WINDOW_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {when === 'custom' ? (
          <div className={styles.dates}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={`${ids}-from`}>
                From
              </label>
              <input id={`${ids}-from`} type="date" value={from ?? ''} max={today} onChange={(e) => onDates({ from: e.target.value || null })} />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={`${ids}-to`}>
                To
              </label>
              <input id={`${ids}-to`} type="date" value={to ?? ''} max={today} onChange={(e) => onDates({ to: e.target.value || null })} />
            </div>
          </div>
        ) : null}
        {shape ? (
          <>
            <div className={styles.field}>
              <span className={styles.fieldLabel} id={`${ids}-lens`}>
                Lens
              </span>
              {/* Toggle buttons, not tabs: a lens resets the metrics in place and opens no panel of its own. */}
              <div className={styles.lensTabs} role="group" aria-labelledby={`${ids}-lens`}>
                {COMPARE_LENSES.map((lens) => (
                  <button
                    key={lens}
                    type="button"
                    aria-pressed={shape.lens === lens}
                    className={styles.lensTab}
                    onClick={() => onLens(lens)}
                    data-testid={`compare-lens-${lens}`}
                  >
                    {LENS_LABELS[lens]}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className={`btn-secondary ${styles.metricsButton}`}
              aria-expanded={pickerOpen}
              aria-controls={pickerOpen ? pickerId : undefined}
              onClick={onTogglePicker}
              data-testid="compare-metrics-button"
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              {`Metrics · ${shape.metricCount}`}
            </button>
          </>
        ) : null}
      </div>
      {dateError && when === 'custom' ? (
        <p className={styles.inlineError} role="alert">
          {dateError}
        </p>
      ) : null}
      <p className={styles.hint}>Like for like: only calls on this campaign count, for everyone.</p>
    </>
  );
}
