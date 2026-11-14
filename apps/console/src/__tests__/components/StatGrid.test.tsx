import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatGrid, countTiles } from '../../components/common/StatGrid';

/*
  The grid's columns come from the tile count (`StatGrid.module.css` keys on
  `data-count`), so the count must be the number of tiles the DOM gets.
*/
describe('StatGrid', () => {
  it('counts the tiles that render, through fragments and past empty conditions', () => {
    const shown = true;
    const hidden = false;
    expect(
      countTiles(
        <>
          <div />
          {hidden && <div />}
          {null}
          {shown ? (
            <>
              <div />
              <div />
            </>
          ) : null}
          {[<div key="a" />, <div key="b" />]}
        </>,
      ),
    ).toBe(5);
  });

  it('marks its count, and an odd one, for the layout', () => {
    render(
      <StatGrid testId="grid">
        <div>one</div>
        <div>two</div>
        <>
          <div>three</div>
        </>
      </StatGrid>,
    );
    const grid = screen.getByTestId('grid');
    expect(grid.getAttribute('data-count')).toBe('3');
    expect(grid.getAttribute('data-odd')).toBe('true');
    expect(grid.children).toHaveLength(3);
  });

  it('leaves an even count unmarked as odd', () => {
    render(
      <StatGrid testId="grid">
        <div>one</div>
        <div>two</div>
      </StatGrid>,
    );
    expect(screen.getByTestId('grid').hasAttribute('data-odd')).toBe(false);
  });
});
