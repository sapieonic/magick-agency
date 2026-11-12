/**
 * Whether a switcher dropdown (or the profile menu) should close on `blur`.
 *
 * Tabbing to a node *outside* the switcher must close it (the menu is not a
 * trap). A `null` relatedTarget is not that: it is a scrollbar click in
 * Firefox/Safari, or a click on non-focusable chrome (the label, list padding,
 * empty-state copy). Pointer-outside is already handled by the document
 * `mousedown` listener; treating null as "left" would close the menu the
 * moment someone tried to scroll it — the original ticket.
 *
 * Nor is focus moving into a modal dialog opened over it (⌘K's search): that is
 * a layer above, which takes its own Escape and gives focus back when it closes.
 * Closing here would let one Escape seem to close both layers.
 */
export function shouldCloseSwitcherOnBlur(
  root: HTMLElement | null,
  relatedTarget: EventTarget | null,
): boolean {
  if (!(relatedTarget instanceof Node) || !root || root.contains(relatedTarget)) return false;
  return !inModalLayer(relatedTarget);
}

/** `node` is inside an open modal dialog (`aria-modal="true"`). */
function inModalLayer(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest('[aria-modal="true"]') != null;
}
