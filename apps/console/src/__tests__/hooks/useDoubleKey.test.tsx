import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, fireEvent, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { DOUBLE_KEY_MS, useDoubleKey, type DoubleKeyOptions } from '../../hooks/useDoubleKey';

/**
 * `useDoubleKey`: the one `E` then `E` behind On a call's End call (`HoldToConfirmButton`) and
 * Call coming's stop (`useRingingStop`). Each rule here is one the two screens used to keep
 * apart, and had already drifted on.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function setup(options: Partial<DoubleKeyOptions> = {}) {
  const onFire = vi.fn();
  const onCallOff = vi.fn();
  const hook = renderHook((props: Partial<DoubleKeyOptions>) => useDoubleKey(onFire, { enabled: true, onCallOff, ...props }), {
    initialProps: options,
  });
  return { onFire, onCallOff, ...hook };
}

const press = (init: KeyboardEventInit = {}, target: Element | Document | Window = window) =>
  fireEvent.keyDown(target, { key: 'e', ...init });

function textField(): HTMLTextAreaElement {
  const field = document.createElement('textarea');
  document.body.appendChild(field);
  return field;
}

describe('E then E', () => {
  it('fires once when the second press lands inside the window', () => {
    const { onFire, result } = setup();
    press();
    expect(result.current.armed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DOUBLE_KEY_MS - 1);
    });
    press();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(result.current.armed).toBe(false);
    // A third press arms afresh rather than firing again.
    press();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(result.current.armed).toBe(true);
  });

  it('a second press after the window arms again and fires nothing', () => {
    const { onFire, result } = setup();
    press();
    act(() => {
      vi.advanceTimersByTime(DOUBLE_KEY_MS);
    });
    expect(result.current.armed).toBe(false);
    press();
    expect(onFire).not.toHaveBeenCalled();
    expect(result.current.armed).toBe(true);
  });

  it('a capital E counts the same', () => {
    const { onFire } = setup();
    press({ key: 'E' });
    press({ key: 'E' });
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});

describe('a held key is one press', () => {
  it('ignores the auto-repeat of a held E, however long it is held', () => {
    const { onFire, result } = setup();
    press();
    // The OS starts repeating a resting finger after about 500 ms, inside the window.
    for (let i = 0; i < 20; i += 1) {
      act(() => {
        vi.advanceTimersByTime(33);
      });
      press({ repeat: true });
    }
    expect(onFire).not.toHaveBeenCalled();
    expect(result.current.armed).toBe(true);
    // Let go and press again: that is the second press.
    press();
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('a repeat does not arm either', () => {
    const { onFire, result } = setup();
    press({ repeat: true });
    expect(result.current.armed).toBe(false);
    press();
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe('what it ignores', () => {
  it.each([['ctrlKey'], ['metaKey'], ['altKey']])('E with %s', (modifier) => {
    const { onFire, result } = setup();
    press({ [modifier]: true });
    expect(result.current.armed).toBe(false);
    press();
    press({ [modifier]: true });
    expect(onFire).not.toHaveBeenCalled();
    expect(result.current.armed).toBe(true);
  });

  it('E typed in a text field', () => {
    const { onFire, result } = setup();
    const field = textField();
    press({}, field);
    press({}, field);
    expect(onFire).not.toHaveBeenCalled();
    expect(result.current.armed).toBe(false);
  });

  it('a key another handler has already taken', () => {
    const { onFire, result } = setup();
    const takeIt = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', takeIt);
    press({}, document.body);
    press({}, document.body);
    document.removeEventListener('keydown', takeIt);
    expect(onFire).not.toHaveBeenCalled();
    expect(result.current.armed).toBe(false);
  });

  it('every key while suspended, and turning suspended on disarms', () => {
    const { onFire, result, rerender } = setup();
    press();
    expect(result.current.armed).toBe(true);
    rerender({ suspended: true });
    expect(result.current.armed).toBe(false);
    press();
    press();
    expect(onFire).not.toHaveBeenCalled();
    rerender({ suspended: false });
    press();
    press();
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('everything while not enabled', () => {
    const { onFire, result, rerender } = setup();
    press();
    rerender({ enabled: false });
    expect(result.current.armed).toBe(false);
    press();
    press();
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe('what calls it off', () => {
  it('Escape disarms, and is passed on even when nothing is armed', () => {
    const { onFire, onCallOff, result } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCallOff).toHaveBeenCalledTimes(1);
    press();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(result.current.armed).toBe(false);
    expect(onCallOff).toHaveBeenCalledTimes(2);
    press();
    expect(onFire).not.toHaveBeenCalled();
  });

  it('the window losing focus disarms', () => {
    const { onFire, onCallOff, result } = setup();
    press();
    fireEvent.blur(window);
    expect(result.current.armed).toBe(false);
    expect(onCallOff).toHaveBeenCalledTimes(1);
    press();
    expect(onFire).not.toHaveBeenCalled();
  });

  it('focus moving into a text field while armed disarms, with no key typed there', () => {
    const { onFire, result } = setup();
    press();
    const field = textField();
    act(() => field.focus());
    expect(result.current.armed).toBe(false);
    act(() => field.blur());
    press();
    expect(onFire).not.toHaveBeenCalled();
  });

  it('focus moving onto a control that is not a text field leaves it armed', () => {
    const { onFire } = setup();
    press();
    const radio = document.createElement('input');
    radio.type = 'radio';
    document.body.appendChild(radio);
    act(() => radio.focus());
    press({}, radio);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('a new subject (resetKey) disarms', () => {
    const { onFire, result, rerender } = setup({ resetKey: 'att-1' });
    press();
    rerender({ resetKey: 'att-2' });
    expect(result.current.armed).toBe(false);
    press();
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe('scope', () => {
  it('on an element, hears only keys that reach it', () => {
    const element = document.createElement('button');
    document.body.appendChild(element);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = element;
    const { onFire } = setup({ scope: ref });
    press();
    press();
    expect(onFire).not.toHaveBeenCalled();
    press({}, element);
    press({}, element);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
