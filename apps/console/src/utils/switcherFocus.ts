/**
 * Whether a switcher dropdown should close on `blur`.
 *
 * Tabbing to a node *outside* the switcher must close it (the menu is not a
 * trap). A `null` relatedTarget is not that: it is a scrollbar click in
 * Firefox/Safari, or a click on non-focusable chrome (the label, list padding,
 * empty-state copy). Pointer-outside is already handled by the document
 * `mousedown` listener; treating null as "left" would close the menu the
 * moment someone tried to scroll it — the original ticket.
 */
export function shouldCloseSwitcherOnBlur(
  root: HTMLElement | null,
  relatedTarget: EventTarget | null,
): boolean {
  return relatedTarget instanceof Node && !!root && !root.contains(relatedTarget);
}
