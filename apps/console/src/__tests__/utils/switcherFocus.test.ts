import { describe, it, expect } from 'vitest';
import { shouldCloseSwitcherOnBlur } from '../../utils/switcherFocus';

describe('shouldCloseSwitcherOnBlur', () => {
  it('does not close when relatedTarget is null (scrollbar / non-focusable chrome)', () => {
    const root = document.createElement('div');
    expect(shouldCloseSwitcherOnBlur(root, null)).toBe(false);
  });

  it('does not close when focus stays inside the switcher', () => {
    const root = document.createElement('div');
    const inside = document.createElement('button');
    root.appendChild(inside);
    expect(shouldCloseSwitcherOnBlur(root, inside)).toBe(false);
  });

  it('closes when Tab moved focus to a node outside', () => {
    const root = document.createElement('div');
    const outside = document.createElement('button');
    expect(shouldCloseSwitcherOnBlur(root, outside)).toBe(true);
  });

  it('does not close when the root is missing', () => {
    const outside = document.createElement('button');
    expect(shouldCloseSwitcherOnBlur(null, outside)).toBe(false);
  });
});

describe('shouldCloseSwitcherOnBlur — a layer above', () => {
  it('does not close when focus moves into a modal dialog opened over it (the search)', () => {
    const root = document.createElement('div');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    dialog.appendChild(input);
    expect(shouldCloseSwitcherOnBlur(root, input)).toBe(false);
  });

  it('still closes for a dialog that is not modal', () => {
    const root = document.createElement('div');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    dialog.appendChild(input);
    expect(shouldCloseSwitcherOnBlur(root, input)).toBe(true);
  });
});
