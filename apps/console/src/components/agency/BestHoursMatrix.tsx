import {
  BEST_HOURS_HOURS,
  BEST_HOURS_STEPS,
  bestHoursCellLabel,
  bestHoursHourAxisLabel,
  bestHoursHourLabel,
  bestHoursScaleReadout,
  bestHoursStep,
  type BestHoursCell,
  type BestHoursMatrix as Matrix,
} from '../../utils/agencyBestHours';
import styles from './BestHoursMatrix.module.css';

/**
 * One campaign's week as a 7 × 24 grid — the best-hours map.
 *
 * ── It renders; it does not decide ────────────────────────────────────────
 * Every state a cell can be in, the scale's domain and the count of withheld cells
 * are computed in `utils/agencyBestHours.ts`, where they are unit-tested against
 * fixtures. The only arithmetic here is `bestHoursStep`, and that is geometry —
 * a position along a ramp, over a domain the util already excluded the thin cells
 * from.
 *
 * ── Nothing is conveyed by colour alone ──────────────────────────────────
 *  - **Every cell carries its number.** A measured cell prints its rate (or its
 *    dial count on the volume view); a cell that is OFF the ramp prints its dial
 *    count, because "we barely called then" is itself the answer to a rostering
 *    question. Only a cell with no figure at all — one that was never in the window
 *    — prints nothing.
 *  - **Every cell carries its finding in words** — a visually-hidden span for a
 *    screen reader, and the full sentence including the weekday, the hour and the
 *    zone in the `title` for a reader who hovers. Two steps of a five-step ramp are
 *    not reliably distinguishable, and the words are what make that not matter.
 *  - **The scale is stated in numbers** — what the lightest and darkest ends are
 *    worth, and that the hatched cells are not on the scale at all. A legend naming
 *    only the hue order tells a reader which end is which and nothing about what
 *    either end is worth.
 *
 * ── A thin cell is off the ramp, not at the bottom of it ─────────────────
 * The hatch is the point. A pale ramp step is still a position on the scale and
 * reads as a low value; a reader scanning for the darkest square skips a hatched
 * one. This is the roster's already-fixed bug at 168× scale, and it is worse here
 * because colour reads as authority and because the extremes are guaranteed: a
 * 20:00 Sunday cell with 2 dials and 1 connect is 50%, which on a ramp topping out
 * near a 30% floor median would be the brightest cell on the map.
 *
 * ── An empty cell is two different facts ─────────────────────────────────
 * A weekday-hour that was never inside the window gets an OUTLINE and nothing else
 * — no colour, no zero, no rate. A weekday-hour that was in the window and had no
 * dial gets a faint `0`, because that is a real zero and a real finding. The
 * distinction is derived from `from`/`to` in the resolved zone, and where the zone
 * is unknown neither claim is made.
 *
 * The grid scrolls inside its own box: 24 columns do not fit a phone, and the page
 * body must never scroll sideways.
 */

export interface BestHoursMatrixProps {
  matrix: Matrix;
  /**
   * The zone the buckets were cut in, or `null`.
   *
   * A PROP rather than something read here, and that is the whole of E3: the only
   * honest source is `resolved_timezone` off the page, and there is a neighbouring
   * function on this surface (`windowRangeReadout`) that correctly returns the
   * READER's zone for its own caption. Two zones on one screen is the defect; taking
   * this one as an argument is what makes it impossible for this component to reach
   * for the wrong one.
   */
  zone: string | null;
  /** What the grid is called for a screen reader. */
  caption: string;
}

export function BestHoursMatrix({ matrix, zone, caption }: BestHoursMatrixProps) {
  const axis = bestHoursHourAxisLabel(zone);
  const hours = Array.from({ length: BEST_HOURS_HOURS }, (_, hour) => hour);

  return (
    <div>
      <div className={styles.wrap} data-testid="best-hours-matrix">
        <table className={styles.matrix}>
          <caption className={styles.srOnly}>{caption}</caption>
          <thead>
            <tr>
              {/*
                The corner cell names the hour axis and its ZONE — or names neither,
                when the zone could not be read. It is never labelled with the
                reader's zone: "the 18:00 column" is not a fact until a zone is
                named, and a wrong name is a rostering decision.
              */}
              <th className={styles.corner} scope="col">
                <span className={styles.srOnly}>Weekday</span>
                {axis !== null && (
                  <span className={styles.dayOut} data-testid="best-hours-axis-zone">
                    {axis}
                  </span>
                )}
              </th>
              {hours.map((hour) => (
                <th key={hour} className={styles.hourHead} scope="col">
                  {bestHoursHourLabel(hour)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.day} data-testid={`best-hours-row-${row.day}`}>
                <th
                  className={styles.dayHead}
                  scope="row"
                  /*
                    The row header carries the fact too. A blank row of cells beside
                    a normal-weight weekday label is exactly the misreading E4 is
                    about — it reads as "we dialled Tuesday and connected nobody",
                    which is the direction a supervisor acts on.
                  */
                  data-covered={row.coveredHours > 0 ? 'true' : 'false'}
                >
                  {row.short}
                  {matrix.coverageKnown && row.coveredHours === 0 && (
                    <span className={styles.dayOut} data-testid={`best-hours-out-${row.day}`}>
                      not in window
                    </span>
                  )}
                </th>
                {row.cells.map((cell) => (
                  <MatrixCell
                    key={cell.hour}
                    cell={cell}
                    matrix={matrix}
                    zone={zone}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        The legend, beneath the grid. It states the scale in NUMBERS and names every
        treatment that is not on it — a heatmap whose legend explains only the hue
        order has told the reader which end is which and nothing about what either
        end is worth.
      */}
      <p className={styles.legend} data-testid="best-hours-scale">
        <span className={styles.ramp} aria-hidden="true">
          {Array.from({ length: BEST_HOURS_STEPS }, (_, step) => (
            <span key={step} className={styles.rampSwatch} data-step={step} />
          ))}
        </span>
        <span>{bestHoursScaleReadout(matrix)}</span>
      </p>

      <p className={styles.legend} data-testid="best-hours-keys">
        {matrix.view !== 'volume' && (
          <span className={styles.key}>
            <span className={styles.keySwatch} data-state="withheld" aria-hidden="true" />
            Too few calls to rate — shows its dial count
          </span>
        )}
        {/*
          The conversion view has a FOURTH visible state, and it had no key: a cell
          that dialled and reached nobody has no denominator to divide, so it is flat
          rather than hatched and prints its dial count. Before this its only
          explanation was the cell's `title` — unavailable on touch, not focusable,
          and not where a reader looks to find out what a treatment means.

          Only on that view, because on the connect rate the same state is
          unreachable (an attempts-driven read cannot emit a cell with no dials) and
          on volume there is no rate to be missing. A key for a swatch that cannot
          appear is a legend describing a map that does not exist.
        */}
        {matrix.view === 'conversion_rate' && (
          <span className={styles.key}>
            <span className={styles.keySwatch} data-state="unmeasured" aria-hidden="true" />
            Dialled, no connect to convert — shows its dial count
          </span>
        )}
        <span className={styles.key}>
          <span className={styles.keySwatch} data-state="no_dials" aria-hidden="true" />
          In the window, nobody dialled
        </span>
        <span className={styles.key}>
          <span className={styles.keySwatch} data-state="out_of_window" aria-hidden="true" />
          {matrix.coverageKnown ? 'Not in this window' : 'No dial — window coverage unknown'}
        </span>
      </p>
    </div>
  );
}

function MatrixCell({
  cell,
  matrix,
  zone,
}: {
  cell: BestHoursCell;
  matrix: Matrix;
  zone: string | null;
}) {
  /*
    The step is computed ONLY for a measured cell, from a domain the util built out
    of measured cells alone. A withheld cell has no `value`, so there is no path by
    which it can acquire a position on the scale — which is stronger than remembering
    not to give it one.
  */
  const step =
    cell.state === 'measured' && cell.value !== null ? bestHoursStep(cell.value, matrix.domain) : null;
  const label = bestHoursCellLabel(cell, zone);

  return (
    <td className={styles.cell} data-testid={`best-hours-cell-${cell.day}-${cell.hour}`}>
      <span
        className={styles.swatch}
        data-state={cell.state}
        data-step={step === null ? undefined : step}
        /*
          The `title` is a convenience; the hidden span is the accessible name. A
          `title` alone is unreachable by keyboard and unreliable to screen readers,
          and this sentence is the only place a reader can find out what an
          out-of-window cell means without reading the legend.
        */
        title={label}
      >
        {/*
          The coordinates are already the row and column headers, so the hidden
          text is the cell's own FINDING and not a restatement of where it is —
          168 cells each re-reading "Tuesday 18:00 · Asia/Kolkata" is a table
          nobody listens to the end of. The `title` carries the full sentence for
          a reader who hovers, where there are no headers in earshot.
        */}
        <span className={styles.srOnly}>{cell.note}</span>
        <span aria-hidden="true">{cell.text}</span>
      </span>
    </td>
  );
}

export default BestHoursMatrix;
