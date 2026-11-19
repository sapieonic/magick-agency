import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Bell } from 'lucide-react';
import { FloorPane } from '../../pages/agency/live-floor/FloorPane';

/**
 * Live floor's panes (Needs you now, Campaigns) scroll inside a fixed height and say how many items
 * are out of sight below. happy-dom does no layout, so each test sets the body's and the items'
 * geometry by hand: rows 100 px tall, a box 250 px high.
 */

afterEach(cleanup);

const ROW = 100;
const BODY_TOP = 40;

function renderPane(items: Array<{ id: string; focusable?: boolean }>, moreNoun = 'item') {
  return render(
    <FloorPane headingId="pane-heading" icon={Bell} title="Needs you now" head={<p>note</p>} moreNoun={moreNoun} testId="pane">
      <ul>
        {items.map((item) => (
          <li key={item.id} data-pane-item data-testid={`row-${item.id}`}>
            {item.id}
            {item.focusable && <button type="button">{`Act on ${item.id}`}</button>}
          </li>
        ))}
      </ul>
    </FloorPane>,
  );
}

/** Lays the body out as a `height`-px box over rows 100 px tall, scrolled to `scrollTop`. */
function layOut(height: number, scrollTop = 0) {
  const body = screen.getByTestId('pane-body');
  const rows = Array.from(body.querySelectorAll<HTMLElement>('[data-pane-item]'));
  const define = (el: HTMLElement, key: string, value: unknown) =>
    Object.defineProperty(el, key, { value, configurable: true, writable: true });
  define(body, 'clientHeight', height);
  define(body, 'scrollHeight', rows.length * ROW);
  define(body, 'scrollTop', scrollTop);
  define(body, 'getBoundingClientRect', () => ({ top: BODY_TOP, height }) as DOMRect);
  rows.forEach((row, i) => {
    define(row, 'getBoundingClientRect', () => ({ top: BODY_TOP + i * ROW - body.scrollTop, height: ROW }) as DOMRect);
  });
  return body;
}

/** Moves the box's scroll position and lets the pane hear it. */
function scrollTo(body: HTMLElement, top: number) {
  Object.defineProperty(body, 'scrollTop', { value: top, configurable: true, writable: true });
  fireEvent.scroll(body);
}

const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, focusable: true }));

describe('FloorPane', () => {
  it('is a section named by its heading, with the heading and its note outside the scroll box', () => {
    renderPane(six);
    const section = screen.getByRole('region', { name: 'Needs you now' });
    const body = screen.getByTestId('pane-body');
    expect(section.contains(body)).toBe(true);
    expect(body.contains(screen.getByRole('heading', { name: 'Needs you now' }))).toBe(false);
    expect(body.contains(screen.getByText('note'))).toBe(false);
    // Focus can be put there (the reveal does), but it is never a tab stop of its own.
    expect(body.getAttribute('tabindex')).toBe('-1');
  });

  it('says nothing while every item fits', async () => {
    renderPane(six);
    const body = layOut(600);
    fireEvent.scroll(body);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.queryByTestId('pane-more')).toBeNull();
    expect(body.getAttribute('data-more')).toBeNull();
  });

  it('says how many items are out of sight below, and fades the bottom edge', async () => {
    renderPane(six);
    const body = layOut(250);
    fireEvent.scroll(body);
    // Rows c to f end below the 250 px view (c half shown).
    await waitFor(() => expect(screen.getByTestId('pane-more').textContent).toBe('4 more items below'));
    expect(body.getAttribute('data-more')).toBe('true');
  });

  it('counts down as the box scrolls, and goes once the last item is in view', async () => {
    renderPane(six);
    const body = layOut(250);
    scrollTo(body, 200);
    await waitFor(() => expect(screen.getByTestId('pane-more').textContent).toBe('2 more items below'));
    scrollTo(body, 350);
    await waitFor(() => expect(screen.queryByTestId('pane-more')).toBeNull());
    expect(body.getAttribute('data-more')).toBeNull();
  });

  it('brings the first item out of sight to the top and focuses what it offers', async () => {
    renderPane(six);
    const body = layOut(250);
    const scrollToSpy = vi.fn();
    Object.defineProperty(body, 'scrollTo', { value: scrollToSpy, configurable: true });
    fireEvent.scroll(body);
    fireEvent.click(await screen.findByTestId('pane-more'));
    // Row c starts at 200: brought to the top, 4 px below the edge.
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 196, behavior: 'smooth' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Act on c' }));
  });

  it('jumps rather than glides for a reader who asked for less motion', async () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: query.includes('reduce') }) as MediaQueryList);
    try {
      renderPane(six);
      const body = layOut(250);
      const scrollToSpy = vi.fn();
      Object.defineProperty(body, 'scrollTo', { value: scrollToSpy, configurable: true });
      fireEvent.scroll(body);
      fireEvent.click(await screen.findByTestId('pane-more'));
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 196, behavior: 'auto' });
    } finally {
      matchMedia.mockRestore();
    }
  });

  it('focuses the scroll box when the item revealed has nothing to focus, so focus is never dropped', async () => {
    renderPane(['a', 'b', 'c', 'd'].map((id) => ({ id })), 'campaign');
    const body = layOut(250);
    fireEvent.scroll(body);
    fireEvent.click(await screen.findByTestId('pane-more'));
    expect(document.activeElement).toBe(body);
  });

  it('says one in the singular', async () => {
    renderPane(['a', 'b', 'c'].map((id) => ({ id })), 'campaign');
    const body = layOut(250);
    fireEvent.scroll(body);
    await waitFor(() => expect(screen.getByTestId('pane-more').textContent).toBe('1 more campaign below'));
  });
});
