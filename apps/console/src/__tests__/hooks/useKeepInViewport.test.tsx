import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useKeepInViewport } from '../../hooks/useKeepInViewport';

/**
 * Top-bar popovers open from their trigger's left edge and are nudged back on
 * screen before paint. happy-dom does no layout, so each case stubs the panel's
 * box as it would sit with no shift, and the viewport's width.
 */

let viewportWidth = 1280;
let panelBox = { left: 0, right: 0 };

function stubLayout(width: number, left: number, right: number) {
  viewportWidth = width;
  panelBox = { left, right };
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() => viewportWidth);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        ...panelBox,
        top: 56,
        bottom: 300,
        width: panelBox.right - panelBox.left,
        height: 244,
        x: panelBox.left,
        y: 56,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

function Panel({ active = true, gutter }: { active?: boolean; gutter?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useKeepInViewport(ref, active, gutter);
  return <div ref={ref} data-testid="panel" />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useKeepInViewport', () => {
  it('leaves a panel that fits where the stylesheet put it', () => {
    stubLayout(1280, 900, 1180);
    render(<Panel />);
    expect(screen.getByTestId('panel').style.marginLeft).toBe('');
  });

  it('pulls a panel running past the right edge back in, 8px clear of it', () => {
    // The account switcher: last control in the bar, 280px panel from its left edge.
    stubLayout(1280, 1150, 1430);
    render(<Panel />);
    expect(screen.getByTestId('panel').style.marginLeft).toBe('-158px');
  });

  it('never pushes a panel past the left edge on a narrow screen', () => {
    // 375px phone: pulling the right edge in to 367 would put the left at -28.
    stubLayout(375, 80, 440);
    render(<Panel />);
    expect(screen.getByTestId('panel').style.marginLeft).toBe('-72px');
  });

  it('honours a wider gutter', () => {
    stubLayout(800, 391, 951);
    render(<Panel gutter={16} />);
    expect(screen.getByTestId('panel').style.marginLeft).toBe('-167px');
  });

  it('measures again when the window is resized', () => {
    stubLayout(1440, 1150, 1430);
    render(<Panel />);
    expect(screen.getByTestId('panel').style.marginLeft).toBe('');

    viewportWidth = 1280;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByTestId('panel').style.marginLeft).toBe('-158px');
  });

  it('does nothing while inactive', () => {
    stubLayout(1280, 1150, 1430);
    render(<Panel active={false} />);
    expect(screen.getByTestId('panel').style.marginLeft).toBe('');
  });
});
