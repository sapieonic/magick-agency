const ID_REF_ATTRS = ['aria-describedby', 'aria-labelledby', 'aria-controls', 'aria-owns'];

/**
 * Accessibility regression check: fails if any element's id-reference ARIA
 * attribute (aria-describedby, aria-labelledby, aria-controls, aria-owns)
 * points at an id that isn't present in the document. Hints/errors composed
 * via `describedBy()` should never dangle — this is what catches it if they do.
 */
export function assertNoDanglingAriaRefs(container: HTMLElement): void {
  for (const attr of ID_REF_ATTRS) {
    for (const el of Array.from(container.querySelectorAll(`[${attr}]`))) {
      const ids = (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean);
      for (const id of ids) {
        if (!document.getElementById(id)) {
          throw new Error(
            `Dangling ${attr}="${id}" on <${el.tagName.toLowerCase()}> — no element with that id exists.`,
          );
        }
      }
    }
  }
}

/** Asserts a field (by id) is wired for a screen reader to discover its error: aria-invalid + a resolvable aria-describedby pointing at a role="alert" element with the expected text. */
export function assertFieldAnnouncesError(fieldId: string, expectedErrorText: string | RegExp): void {
  const field = document.getElementById(fieldId);
  if (!field) throw new Error(`No element with id "${fieldId}"`);
  if (field.getAttribute('aria-invalid') !== 'true') {
    throw new Error(`Expected #${fieldId} to have aria-invalid="true"`);
  }
  const describedBy = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const errorEl = describedBy
    .map(id => document.getElementById(id))
    .find(el => el?.getAttribute('role') === 'alert');
  if (!errorEl) {
    throw new Error(`Expected #${fieldId}'s aria-describedby to include a role="alert" element`);
  }
  const text = errorEl.textContent ?? '';
  const matches = typeof expectedErrorText === 'string' ? text.includes(expectedErrorText) : expectedErrorText.test(text);
  if (!matches) {
    throw new Error(`Expected #${fieldId}'s error text to match ${String(expectedErrorText)}, got "${text}"`);
  }
}
