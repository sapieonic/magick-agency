import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  ABANDONMENT_CEILING_MAX_PCT,
  ABANDONMENT_CEILING_MIN_PCT,
  ABANDONMENT_SCALE_TICKS,
  DEFAULT_ABANDONMENT_CEILING_PCT,
  ceilingAfterKey,
  ceilingFromTrackFraction,
  ceilingLabelAlign,
  ceilingValueText,
  meterPosition,
} from '../../utils/agency/abandonmentCeiling';
import { pct } from '../../utils/format/number';
import styles from './AbandonmentMeter.module.css';

/**
 * The abandonment meter: a track on the fixed 0–10% scale, the ceiling drawn as
 * a red line across it, the region past the line tinted, and (optionally) the
 * measured rate as a fill.
 *
 * ── One component, two places ───────────────────────────────────────────────
 * The campaign builder and campaign settings draw it `editable`, and the line is
 * then the slider: the supervisor drags it, or focuses it and uses the keys. The
 * Insights Health panel draws it read-only with the rolling 24-hour rate as the
 * fill. Same scale, same line, same tint: the line the supervisor drags is the
 * line they later watch the rate approach, in the same spot. Every number the
 * meter shows goes through `utils/agency/abandonmentCeiling.ts`, so drag, keys and
 * typed value round and clamp alike and are tested there, not through pointer
 * events.
 *
 * ── Why the tint ────────────────────────────────────────────────────────────
 * "Pauses past here" without a word of copy: the stretch of the scale where a
 * measured rate would pause the campaign is the stretch that is red. Moving the
 * line visibly grows or shrinks it, which is the thing the supervisor is choosing.
 *
 * ── Accessibility ───────────────────────────────────────────────────────────
 * Editable, the line is a WAI-ARIA slider (`role="slider"`, value text from
 * `ceilingValueText`) and the drawn labels are hidden from assistive technology,
 * because the slider already says all of them. Read-only, the whole meter is
 * hidden: it is a picture of figures its caller states in text (the Insights KPI
 * names the rate and the ceiling), and a second reading of them is noise.
 */

export interface AbandonmentMeterEditable {
  onChange: (next: number) => void;
  /** The slider's accessible name. */
  label: string;
  /** Ids for the slider's `aria-describedby` (the field's hint, its error). */
  describedBy?: string;
}

export interface AbandonmentMeterProps {
  /** The ceiling, in percent. A non-finite value (a cleared field) draws no line. */
  ceilingPct: number;
  /** The measured rate, in percent, as a fill; red when at or over the ceiling. */
  ratePct?: number;
  /** The tick labels under the track. Default on. */
  showScale?: boolean;
  /** Present: the line is a slider. Absent: a picture. */
  editable?: AbandonmentMeterEditable;
  testId?: string;
}

export function AbandonmentMeter({
  ceilingPct,
  ratePct,
  showScale = true,
  editable,
  testId = 'abandonment-meter',
}: AbandonmentMeterProps) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const sliderRef = useRef<HTMLSpanElement>(null);
  // The ref is what the move handler reads (a move can arrive before the render
  // that the down caused); the state is only for the no-transition styling.
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const drag = (on: boolean) => {
    draggingRef.current = on;
    setDragging(on);
  };

  const set = Number.isFinite(ceilingPct);
  // A cleared field still needs somewhere for the slider to sit (it must stay
  // focusable to be set again by key), so it sits at the default, drawn muted.
  const position = meterPosition(set ? ceilingPct : DEFAULT_ABANDONMENT_CEILING_PCT);
  const ratePosition = ratePct !== undefined && Number.isFinite(ratePct) ? meterPosition(ratePct) : null;
  const over = ratePct !== undefined && set && ratePct >= ceilingPct;

  /** The ceiling under the pointer, or `null` while the track has no width (not laid out). */
  function ceilingAt(clientX: number): number | null {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return ceilingFromTrackFraction((clientX - rect.left) / rect.width);
  }

  function moveTo(clientX: number) {
    const next = ceilingAt(clientX);
    if (next !== null && !Object.is(next, ceilingPct)) editable?.onChange(next);
  }

  const handlers = editable
    ? {
        // Down anywhere on the track jumps the line to the pointer, as a native
        // range input does, and starts the drag. Capture keeps the moves coming
        // when the pointer leaves the track (optional: jsdom has no capture).
        onPointerDown: (event: PointerEvent<HTMLSpanElement>) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          event.preventDefault(); // no text selection, and the focus goes where we put it
          event.currentTarget.setPointerCapture?.(event.pointerId);
          sliderRef.current?.focus();
          drag(true);
          moveTo(event.clientX);
        },
        onPointerMove: (event: PointerEvent<HTMLSpanElement>) => {
          if (draggingRef.current) moveTo(event.clientX);
        },
        onPointerUp: (event: PointerEvent<HTMLSpanElement>) => {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          drag(false);
        },
        onPointerCancel: () => drag(false),
      }
    : {};

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (!editable) return;
    const next = ceilingAfterKey(ceilingPct, event.key);
    if (next === null) return;
    event.preventDefault(); // the arrows and Page keys would otherwise scroll the page
    if (!Object.is(next, ceilingPct)) editable.onChange(next);
  }

  const line = editable ? (
    <span
      ref={sliderRef}
      className={styles.line}
      data-editable="true"
      data-unset={set ? undefined : 'true'}
      style={{ left: `${position}%` }}
      role="slider"
      tabIndex={0}
      aria-label={editable.label}
      aria-describedby={editable.describedBy}
      aria-valuemin={ABANDONMENT_CEILING_MIN_PCT}
      aria-valuemax={ABANDONMENT_CEILING_MAX_PCT}
      aria-valuenow={set ? ceilingPct : undefined}
      aria-valuetext={ceilingValueText(ceilingPct)}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      data-testid={`${testId}-ceiling`}
    />
  ) : (
    <span
      className={styles.line}
      data-unset={set ? undefined : 'true'}
      style={{ left: `${position}%` }}
      data-testid={`${testId}-ceiling`}
    />
  );

  return (
    <span
      className={styles.meter}
      data-editable={editable ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      aria-hidden={editable ? undefined : 'true'}
      data-testid={testId}
    >
      <span className={styles.valueRow} aria-hidden="true">
        {set ? (
          <span
            className={styles.value}
            data-align={ceilingLabelAlign(position)}
            style={{ left: `${position}%` }}
            data-testid={`${testId}-value`}
          >
            {pct(ceilingPct)}
          </span>
        ) : null}
      </span>
      <span className={styles.hit} {...handlers}>
        <span ref={trackRef} className={styles.track}>
          {set ? <span className={styles.beyond} style={{ left: `${position}%` }} aria-hidden="true" /> : null}
          {ratePosition !== null ? (
            <span
              className={styles.fill}
              data-over={String(over)}
              style={{ width: `${ratePosition}%` }}
              aria-hidden="true"
              data-testid={`${testId}-rate`}
            />
          ) : null}
          {line}
        </span>
      </span>
      {showScale ? (
        <span className={styles.scale} aria-hidden="true">
          {ABANDONMENT_SCALE_TICKS.map((tick) => (
            <span key={tick} className={styles.tick} style={{ left: `${meterPosition(tick)}%` }}>
              {pct(tick)}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
