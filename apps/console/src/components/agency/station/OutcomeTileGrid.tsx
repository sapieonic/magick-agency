import { useRef, useState } from 'react';
import { Check, MoreHorizontal, Volume2 } from 'lucide-react';
import { NUMBER_KEY_COUNT } from '../../../utils/agencyDispositionForm';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import { outcomeIcon, outcomeTileLayout } from '../../../utils/agency/stationTiles';
import type { AgencyDisposition } from '../../../types/agency';
import { StationTileIcon } from './stationIcons';
import styles from './Station.module.css';

/**
 * The outcome tiles of 05 What happened? (spec §6.2): one picture tile per outcome of the
 * campaign's own list, in its order (number keys 1–9 by index), big up to six and small past
 * that, the first eight and a More tile past nine (`outcomeTileLayout`). `WhatHappened` draws it on
 * a live call; campaign setup draws it as the agent's view of the buttons (CS4), so the preview is
 * these tiles and cannot drift from them.
 *
 * With `onSelect` the tiles are buttons: arrow keys move between them, More shows the rest, and an
 * outcome behind More that is picked keeps the rest open. Without it the grid is a picture: a list
 * of the tiles as an agent first sees them, nothing to press.
 */
export function OutcomeTileGrid({
  catalog,
  selectedCode = null,
  onSelect,
  enabled = true,
  readAloud,
  shake = 0,
  label = STATION_COPY.happenedTitle,
  testId = 'outcome-tiles',
}: {
  catalog: readonly AgencyDisposition[];
  selectedCode?: string | null;
  /** The tile pressed. Absent: a picture of the tiles, not controls. */
  onSelect?: (entry: AgencyDisposition) => void;
  enabled?: boolean;
  /** The speaker beside each tile (AS13), while the device can read aloud. */
  readAloud?: { available: boolean; say: (text: string) => void };
  /** Save was pressed before a tile was picked: the tiles shake once (spec §6.1). */
  shake?: number;
  /** The group's name. */
  label?: string;
  testId?: string;
}) {
  const layout = outcomeTileLayout(catalog);
  const [showAll, setShowAll] = useState(false);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const interactive = onSelect !== undefined;
  const selectedIndex = catalog.findIndex((e) => e.code === selectedCode);
  // An outcome behind More that is picked (by its key or a click) keeps the rest open.
  const expanded = interactive && (showAll || selectedIndex >= layout.shown.length);
  const tiles = expanded ? catalog : layout.shown;
  const tileClass = `${styles.pick} ${layout.size === 'small' ? styles.pickSmall : ''}`;

  const tileBody = (entry: AgencyDisposition, index: number, on: boolean) => (
    <>
      {index < NUMBER_KEY_COUNT ? <span className={styles.key} aria-hidden="true">{index + 1}</span> : null}
      <span className={styles.pickIcon} aria-hidden="true"><StationTileIcon icon={outcomeIcon(entry)} size={layout.size === 'small' ? 24 : 32} /></span>
      <b>{entry.label}</b>
      {on ? <span className={styles.tick} aria-hidden="true"><Check size={18} strokeWidth={3} /></span> : null}
    </>
  );

  const more = !expanded && layout.overflow.length > 0 ? (
    <>
      <span className={styles.pickIcon} aria-hidden="true"><MoreHorizontal size={24} /></span>
      <b>{STATION_COPY.moreOutcomes}</b>
      <small>{STATION_COPY.moreOutcomesHint(layout.overflow.length)}</small>
    </>
  ) : null;

  if (!interactive) {
    return (
      <div className={styles.picks} role="list" aria-label={label} data-testid={testId} data-size={layout.size}>
        {tiles.map((entry, index) => (
          // Keyed by position: a list being edited can hold two rows with one code for a moment.
          <div key={index} className={styles.pickWrap} role="listitem">
            <div className={tileClass} data-icon={outcomeIcon(entry)} data-stop={entry.suppress ? 'true' : undefined} data-testid={`${testId}-${index}`}>
              {tileBody(entry, index, false)}
            </div>
          </div>
        ))}
        {more ? (
          <div className={styles.pickWrap} role="listitem">
            <div className={`${styles.pick} ${styles.pickSmall}`} data-testid={`${testId}-more`}>{more}</div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={styles.picks}
      role="group"
      aria-label={label}
      data-testid={testId}
      data-size={layout.size}
      // Keyed on the press count, so each early Save restarts the shake.
      key={shake}
      data-shake={shake > 0 ? 'true' : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const at = tileRefs.current.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
        const next = (Math.max(at, 0) + step + tiles.length) % tiles.length;
        tileRefs.current[next]?.focus();
      }}
    >
      {tiles.map((entry, index) => {
        const on = entry.code === selectedCode;
        return (
          <div key={entry.code} className={styles.pickWrap}>
            <button
              ref={(node) => {
                tileRefs.current[index] = node;
              }}
              type="button"
              className={tileClass}
              data-icon={outcomeIcon(entry)}
              data-stop={entry.suppress ? 'true' : undefined}
              data-testid={`outcome-${entry.code}`}
              aria-pressed={on}
              // `aria-disabled`, never `disabled`: a frame that locks the tiles must not throw focus to the page.
              aria-disabled={!enabled || undefined}
              onClick={() => onSelect(entry)}
            >
              {tileBody(entry, index, on)}
            </button>
            {readAloud?.available ? (
              <button
                type="button"
                className={styles.say}
                aria-label={STATION_COPY.readAloud(entry.label)}
                title={STATION_COPY.readAloud(entry.label)}
                onClick={() => readAloud.say(entry.label)}
                data-testid={`read-aloud-${entry.code}`}
              >
                <Volume2 size={20} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        );
      })}
      {more ? (
        <div className={styles.pickWrap}>
          <button
            type="button"
            className={`${styles.pick} ${styles.pickSmall}`}
            onClick={() => setShowAll(true)}
            data-testid="outcome-more"
          >
            {more}
          </button>
        </div>
      ) : null}
    </div>
  );
}
