import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState, useCallback } from 'react';
import { DateRangeFilter, type DateRangeValue } from './DateRangeFilter';

/**
 * Controlled wrapper matching how the three list pages drive the component:
 * they hold `dateRange` in state and feed it straight back as `value`. Every
 * defect this file guards was invisible to an uncontrolled render, because the
 * bugs were desyncs between the emitted value and the visible controls.
 */
function Harness({ onApply, initial }: { onApply?: (r: DateRangeValue | undefined) => void; initial?: DateRangeValue }) {
  const [value, setValue] = useState<DateRangeValue | undefined>(initial);
  const handle = useCallback(
    (range: DateRangeValue | undefined) => {
      setValue(range);
      onApply?.(range);
    },
    [onApply],
  );
  return <DateRangeFilter value={value} onApply={handle} />;
}

type ApplyMock = ReturnType<typeof vi.fn<(r: DateRangeValue | undefined) => void>>;

/** The nth emitted range, asserting the call happened (mock.calls is sparse-typed). */
function emittedAt(onApply: ApplyMock, n: number): DateRangeValue | undefined {
  const call = onApply.mock.calls[n];
  expect(call, `expected at least ${n + 1} onApply call(s)`).toBeDefined();
  return call![0];
}

/** Same, but asserting a range was emitted rather than a clear. */
function rangeAt(onApply: ApplyMock, n: number): DateRangeValue {
  const range = emittedAt(onApply, n);
  expect(range, `expected call ${n} to carry a range, got a clear`).toBeDefined();
  return range!;
}

const pill = (name: RegExp) => screen.getByRole('button', { name });
const fromInput = () => screen.getByLabelText('From date') as HTMLInputElement;
const toInput = () => screen.getByLabelText('To date') as HTMLInputElement;
const clearBtn = () => screen.queryByTitle('Clear date filter');

/** Local `YYYY-MM-DD` for an emitted ISO instant — the round-trip users see. */
function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayLocal(): string {
  return localDay(new Date().toISOString());
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('DateRangeFilter — presets', () => {
  it('applies a local-midnight lower bound for Today', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Today$/));

    expect(onApply).toHaveBeenCalledTimes(1);
    const range = rangeAt(onApply, 0);
    const from = new Date(range.from!);
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(from.getSeconds()).toBe(0);
    expect(localDay(range.from!)).toBe(todayLocal());
  });

  it('leaves the upper bound open so auto-refresh can surface newer calls', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Today$/));

    // A pinned `to` would freeze the window at click time — a call placed a
    // minute later could never appear, which defeats the 10s list refresh.
    expect(rangeAt(onApply, 0).to).toBeUndefined();
  });

  it('spans 7 inclusive calendar days for Last 7 days', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/Last 7 days/));

    const from = new Date((rangeAt(onApply, 0)).from!);
    const now = new Date();
    const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    expect(localDay(from.toISOString())).toBe(localDay(expected.toISOString()));
    // Calendar arithmetic, not `now - 6*86400e3`: the latter lands on the wrong
    // hour (and can cross a date boundary) across a DST transition. That case
    // cannot be stated here — the suite is pinned to UTC and this project runs on
    // threads, where a `TZ` change is a no-op — so it lives in
    // `DateRangeFilter.timezone.test.tsx`.
    expect(from.getHours()).toBe(0);
  });

  it('toggles a preset off when its own pill is clicked again', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Today$/));
    fireEvent.click(pill(/^Today$/));

    expect(onApply).toHaveBeenCalledTimes(2);
    expect(emittedAt(onApply, 1)).toBeUndefined();
    expect(clearBtn()).toBeNull();
  });

  it('replaces the applied range when switching between presets', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Today$/));
    fireEvent.click(pill(/Last 7 days/));

    const first = rangeAt(onApply, 0);
    const second = rangeAt(onApply, 1);
    expect(second.from).not.toBe(first.from);
    expect(new Date(second.from!).getTime()).toBeLessThan(new Date(first.from!).getTime());
  });
});

describe('DateRangeFilter — preset/custom transitions', () => {
  it('clears the applied preset when switching to Custom', () => {
    // Regression: Custom used to set the mode without dropping the preset's
    // filter, so the pills read "Custom" over empty inputs while the list was
    // still narrowed to today.
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Today$/));
    fireEvent.click(pill(/^Custom$/));

    expect(onApply).toHaveBeenCalledTimes(2);
    expect(emittedAt(onApply, 1)).toBeUndefined();
    expect(fromInput().value).toBe('');
    expect(toInput().value).toBe('');
  });

  it('does not re-emit when opening Custom with no filter applied', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));

    expect(onApply).not.toHaveBeenCalled();
    expect(fromInput()).toBeTruthy();
  });

  it('drops stale custom dates when a preset is chosen afterwards', () => {
    // Regression: the draft survived the preset switch, so reopening Custom
    // showed January dates while the list was filtered to today — and touching
    // either input snapped the range back to January.
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(fromInput(), { target: { value: '2026-01-05' } });
    fireEvent.blur(fromInput());
    fireEvent.click(pill(/^Today$/));
    fireEvent.click(pill(/^Custom$/));

    expect(fromInput().value).toBe('');
    expect(toInput().value).toBe('');
  });

  it('clears the filter when Custom is toggled off', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(fromInput(), { target: { value: '2026-01-05' } });
    fireEvent.blur(fromInput());
    fireEvent.click(pill(/^Custom$/));

    expect(onApply).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByLabelText('From date')).toBeNull();
  });
});

describe('DateRangeFilter — custom range commit', () => {
  it('commits on blur, not on every keystroke', () => {
    // Regression: `onChange` applied immediately, and a date input fires change
    // per typed digit — so typing a year dispatched four requests (years 2,
    // 20, 202, 2026), each resetting pagination.
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(fromInput(), { target: { value: '0002-01-05' } });
    fireEvent.change(fromInput(), { target: { value: '0202-01-05' } });
    fireEvent.change(fromInput(), { target: { value: '2026-01-05' } });

    expect(onApply).not.toHaveBeenCalled();

    fireEvent.blur(fromInput());

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(localDay((rangeAt(onApply, 0)).from!)).toBe('2026-01-05');
  });

  it('commits on Enter', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(fromInput(), { target: { value: '2026-01-05' } });
    fireEvent.keyDown(fromInput(), { key: 'Enter' });

    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('sends midnight-to-end-of-day local bounds for a full range', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(fromInput(), { target: { value: '2026-01-05' } });
    fireEvent.change(toInput(), { target: { value: '2026-01-09' } });
    fireEvent.blur(toInput());

    const range = rangeAt(onApply, 0);
    const from = new Date(range.from!);
    const to = new Date(range.to!);
    expect(from.getHours()).toBe(0);
    expect(to.getHours()).toBe(23);
    expect(to.getMinutes()).toBe(59);
    expect(localDay(range.from!)).toBe('2026-01-05');
    expect(localDay(range.to!)).toBe('2026-01-09');
  });

  it('accepts an open-ended range with only one bound', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(toInput(), { target: { value: '2026-01-09' } });
    fireEvent.blur(toInput());

    const range = rangeAt(onApply, 0);
    expect(range.from).toBeUndefined();
    expect(range.to).toBeTruthy();
  });

  it('does not refetch when blur leaves the range unchanged', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(fromInput(), { target: { value: '2026-01-05' } });
    fireEvent.blur(fromInput());
    fireEvent.blur(fromInput());
    fireEvent.blur(toInput());

    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('clears the filter when both bounds are emptied', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(fromInput(), { target: { value: '2026-01-05' } });
    fireEvent.blur(fromInput());
    fireEvent.change(fromInput(), { target: { value: '' } });
    fireEvent.blur(fromInput());

    expect(onApply).toHaveBeenLastCalledWith(undefined);
  });
});

describe('DateRangeFilter — inverted range guard', () => {
  it('refuses to emit when the start date is after the end date', () => {
    // Regression: min/max only discourage inversion (the browser still reports
    // the typed value), the API 400s on from > to, and the pages replace the whole
    // filter bar with an error — removing the inputs needed to undo it.
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(toInput(), { target: { value: '2026-01-05' } });
    fireEvent.blur(toInput());
    onApply.mockClear();

    fireEvent.change(fromInput(), { target: { value: '2026-01-20' } });
    fireEvent.blur(fromInput());

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('recovers once the range is corrected', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(toInput(), { target: { value: '2026-01-05' } });
    fireEvent.change(fromInput(), { target: { value: '2026-01-20' } });
    fireEvent.blur(fromInput());
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.change(toInput(), { target: { value: '2026-01-25' } });
    fireEvent.blur(toInput());

    expect(screen.queryByRole('alert')).toBeNull();
    expect(onApply).toHaveBeenCalledTimes(1);
    const range = rangeAt(onApply, 0);
    expect(new Date(range.from!).getTime()).toBeLessThan(new Date(range.to!).getTime());
  });

  it('ignores an unparseable date rather than throwing on toISOString', () => {
    // `new Date('275760-09-14T00:00:00').toISOString()` throws a RangeError.
    // A real (and happy-dom) date input sanitizes such a value to '', so this
    // is only reachable via a parent-supplied value — but the guard is cheap
    // and the alternative is an uncaught throw that blanks the page.
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(fromInput(), { target: { value: '275760-09-14' } });
    fireEvent.blur(fromInput());

    expect(fromInput().value).toBe('');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('survives a parent-supplied value that cannot be parsed', () => {
    // The sync effect opens the custom panel for any bare range; an
    // unparseable bound must degrade to a blank input, not crash the render.
    expect(() => render(<Harness initial={{ from: 'not-a-date' }} />)).not.toThrow();
    expect(fromInput().value).toBe('');
  });
});

describe('DateRangeFilter — clear', () => {
  it('clears an applied preset and hides the button afterwards', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(pill(/^Today$/));
    expect(clearBtn()).toBeTruthy();

    fireEvent.click(clearBtn()!);

    expect(onApply).toHaveBeenLastCalledWith(undefined);
    expect(clearBtn()).toBeNull();
  });

  it('exits the custom panel and drops its draft', () => {
    render(<Harness />);

    fireEvent.click(pill(/^Custom$/));
    fireEvent.change(fromInput(), { target: { value: '2026-01-05' } });
    fireEvent.blur(fromInput());
    fireEvent.click(clearBtn()!);

    expect(screen.queryByLabelText('From date')).toBeNull();
    fireEvent.click(pill(/^Custom$/));
    expect(fromInput().value).toBe('');
  });

  it('is offered while a custom panel is open with no range applied', () => {
    // The panel is a visible mode change, so there has to be a way back out of
    // it even before any date is entered.
    render(<Harness />);

    fireEvent.click(pill(/^Custom$/));

    expect(clearBtn()).toBeTruthy();
  });
});

describe('DateRangeFilter — controlled value', () => {
  it('reflects an initial value from the parent', () => {
    // Regression: `value` was write-only — never read back into the controls —
    // so a parent-supplied range rendered as an empty, unfiltered-looking bar.
    render(
      <Harness
        initial={{
          from: new Date(2026, 0, 5, 0, 0, 0).toISOString(),
          to: new Date(2026, 0, 9, 23, 59, 59, 999).toISOString(),
        }}
      />,
    );

    expect(fromInput().value).toBe('2026-01-05');
    expect(toInput().value).toBe('2026-01-09');
  });

  it('resets the controls when the parent clears the filter externally', () => {
    function ExternalHarness() {
      const [value, setValue] = useState<DateRangeValue | undefined>(undefined);
      return (
        <>
          <button type="button" onClick={() => setValue(undefined)}>
            reset all
          </button>
          <DateRangeFilter value={value} onApply={setValue} />
        </>
      );
    }
    render(<ExternalHarness />);

    fireEvent.click(pill(/^Today$/));
    expect(clearBtn()).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /reset all/ }));

    expect(clearBtn()).toBeNull();
  });

  it('does not clobber the active preset when echoing our own value back', () => {
    render(<Harness />);

    fireEvent.click(pill(/^Today$/));

    // The harness feeds the emitted range straight back as `value`; the sync
    // effect must recognize it as our own and leave the pill selected rather
    // than degrading it to a custom range.
    expect(pill(/^Today$/).className).toMatch(/pillActive/);
    expect(screen.queryByLabelText('From date')).toBeNull();
  });
});
