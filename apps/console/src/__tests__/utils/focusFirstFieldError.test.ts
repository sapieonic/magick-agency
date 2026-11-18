import { describe, it, expect, afterEach } from 'vitest';
import { focusFirstFieldError } from '../../pages/campaigns/agency/configFieldErrors';

/*
  "Fix", "Go to" and "Show me" land on the field to change. The helper finds the first error
  on screen, preferring the form's own live findings (what holds Save) over a server refusal
  kept until the next save, and moves focus to the control that names it.
*/

function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focusFirstFieldError', () => {
  it('focuses the control that names the first error, and reports when there is none', () => {
    const container = mount(`
      <input id="ok" />
      <input id="bad" aria-describedby="lead err-1" />
      <p class="error-text" id="err-1" data-live>Wrong</p>
    `);
    expect(focusFirstFieldError(container)).toBe(true);
    expect(document.activeElement?.id).toBe('bad');
    expect(focusFirstFieldError(mount('<input />'))).toBe(false);
  });

  it('prefers a live finding to a server refusal earlier on the page', () => {
    const container = mount(`
      <input id="fixed" aria-describedby="server-1" />
      <p class="error-text" id="server-1" role="alert">Kept from the last save</p>
      <input id="now-wrong" aria-describedby="live-1" />
      <p class="error-text" id="live-1" data-live>Holds Save</p>
    `);
    focusFirstFieldError(container);
    expect(document.activeElement?.id).toBe('now-wrong');
  });

  it('moves into a group to its first control, since a fieldset takes no focus', () => {
    const container = mount(`
      <fieldset aria-describedby="days-err"><input type="checkbox" id="monday" /></fieldset>
      <p class="error-text" id="days-err" data-live>Pick at least one day</p>
    `);
    focusFirstFieldError(container);
    expect(document.activeElement?.id).toBe('monday');
  });

  it('takes a control marked invalid, or a page’s own error marked data-field-error', () => {
    const named = mount('<input id="name" aria-invalid="true" />');
    focusFirstFieldError(named);
    expect(document.activeElement?.id).toBe('name');

    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      expect(focusFirstFieldError(mount('<p data-field-error>Needs a caller ID</p>'))).toBe(true);
      expect(scrolled.map((element) => element.textContent)).toEqual(['Needs a caller ID']);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
