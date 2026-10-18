import { describe, it, expect } from 'vitest';
import { isTextEntryTarget } from '../../utils/keyboardTarget';

/**
 * The one rule both station keyboard listeners read (the page's shortcut map and
 * the hang-up's `E`,`E`): suppress single-key shortcuts where the agent types,
 * and nowhere else.
 */

function input(type?: string): HTMLInputElement {
  const el = document.createElement('input');
  if (type !== undefined) el.type = type;
  return el;
}

describe('isTextEntryTarget', () => {
  it('is true for the places a key types a character', () => {
    expect(isTextEntryTarget(document.createElement('textarea'))).toBe(true);
    for (const type of ['text', 'search', 'email', 'tel', 'url', 'number', 'password']) {
      expect(isTextEntryTarget(input(type))).toBe(true);
    }
  });

  it('treats an untyped or unknown-typed input as text — the unknown case suppresses', () => {
    expect(isTextEntryTarget(input())).toBe(true);
    expect(isTextEntryTarget(input('datetime-local'))).toBe(true);
  });

  it('is true for a contenteditable element', () => {
    const div = document.createElement('div');
    // happy-dom does not derive `isContentEditable` from the attribute, so it is
    // stated the way a browser reports it.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTextEntryTarget(div)).toBe(true);
  });

  it.each(['radio', 'checkbox', 'range', 'button', 'submit', 'reset', 'file', 'color', 'image'])(
    'is false for an input of type %s — no use for the letter b',
    (type) => {
      expect(isTextEntryTarget(input(type))).toBe(false);
    },
  );

  it('is false for buttons, the body, the window and no target at all', () => {
    expect(isTextEntryTarget(document.createElement('button'))).toBe(false);
    expect(isTextEntryTarget(document.body)).toBe(false);
    expect(isTextEntryTarget(window)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
