import { describe, expect, it } from 'vitest';
import { PANE_ALL_IN_VIEW, paneMoreLabel, paneOverflow } from '../../utils/agency/paneOverflow';

/** Rows 100 px tall, stacked from the top of the scroll box's content. */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ top: i * 100, bottom: i * 100 + 100 }));

describe('paneOverflow', () => {
  it('counts the items not fully in view below the visible part, and names the first', () => {
    expect(paneOverflow(rows(6), 250)).toEqual({ below: 4, firstBelow: 2 });
  });

  it('counts a half-shown item: it is still one to scroll to', () => {
    expect(paneOverflow(rows(3), 150)).toEqual({ below: 2, firstBelow: 1 });
  });

  it('follows the scroll position: the view’s bottom is where the box has scrolled to', () => {
    expect(paneOverflow(rows(6), 450)).toEqual({ below: 2, firstBelow: 4 });
    expect(paneOverflow(rows(6), 600)).toBe(PANE_ALL_IN_VIEW);
  });

  it('never counts a sub-pixel rounding as an item out of sight', () => {
    expect(paneOverflow(rows(2), 199.5)).toBe(PANE_ALL_IN_VIEW);
    expect(paneOverflow(rows(2), 198.9)).toEqual({ below: 1, firstBelow: 1 });
  });

  it('is all in view with no items', () => {
    expect(paneOverflow([], 0)).toBe(PANE_ALL_IN_VIEW);
  });
});

describe('paneMoreLabel', () => {
  it('says how many more, in the singular for one', () => {
    expect(paneMoreLabel(1, 'campaign')).toBe('1 more campaign below');
    expect(paneMoreLabel(4, 'item')).toBe('4 more items below');
  });
});
