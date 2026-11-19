/**
 * How much of a Live floor pane's list is out of sight below its scroll box (`FloorPane`): the
 * items that are not fully in view under the box's bottom edge, and the first of them, which is
 * where "N more below" scrolls to. Positions are in the box's own scroll space (0 is the top of
 * its content), so the rule needs no layout and is the same at any scroll position.
 */

/** An item's top and bottom edge, in the scroll box's content coordinates. */
export interface PaneItemBox {
  top: number;
  bottom: number;
}

export interface PaneOverflow {
  /** Items not fully in view below the visible part of the box. */
  below: number;
  /** The first of them, by index; null when every item is in view. */
  firstBelow: number | null;
}

/** A sub-pixel layout rounding is not an item out of sight. */
const SLACK_PX = 1;

export const PANE_ALL_IN_VIEW: PaneOverflow = { below: 0, firstBelow: null };

/**
 * `items` in document order; `viewBottom` is the box's scroll position plus its visible height.
 * An item counts once its bottom edge is past the view's: half a row showing is still a row to
 * scroll to.
 */
export function paneOverflow(items: readonly PaneItemBox[], viewBottom: number): PaneOverflow {
  let below = 0;
  let firstBelow: number | null = null;
  items.forEach((item, index) => {
    if (item.bottom > viewBottom + SLACK_PX) {
      below += 1;
      if (firstBelow === null) firstBelow = index;
    }
  });
  return below === 0 ? PANE_ALL_IN_VIEW : { below, firstBelow };
}

/** "3 more items below", "1 more campaign below". */
export function paneMoreLabel(below: number, noun: string): string {
  return `${below} more ${below === 1 ? noun : `${noun}s`} below`;
}
