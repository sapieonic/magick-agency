/**
 * Whether a keydown's target is somewhere the agent is **typing** — the one place
 * the station's single-key shortcuts must stay out of.
 *
 * ── One rule, two listeners ──────────────────────────────────────────────────
 * The page's shortcut map (`AgentConsolePage`) and the hang-up's `E`,`E`
 * (`HoldToConfirmButton`) each kept their own copy of this test, and the copies
 * disagreed. The page had already learned that `tag === 'INPUT'` is too wide; the
 * hang-up had not, so `E`,`E` was dead while focus sat on a cue-settings radio.
 * Both read this now, so they cannot disagree again.
 */

/**
 * The `<input>` types a printable key does NOT belong to.
 *
 * A **deny**-list rather than an allow-list, because the unknown case has to fall
 * on the suppressing side: an `<input>` with no `type` is a text box in every
 * browser, as is one whose `type` this list has never heard of.
 *
 * The guard used to be `tag === 'INPUT'`, which is too wide by exactly these — a
 * radio, a checkbox and a range slider have no use for the letter `b`, so treating
 * them as text fields made **every** page shortcut dead while focus sat inside the
 * cue-settings popover: the one surface the agent who cannot hear the cues has to
 * open, and the same "operable but effectively unreachable" shape that surface was
 * moved to the header to avoid. The suppression exists so that typing a note
 * containing "b" cannot open the break menu mid-sentence; a radio group cannot
 * produce that failure and so does not earn it.
 *
 * This was invisible because `AgentConsolePage.cueVisual.test.tsx`'s `press()`
 * fired at `document` instead of at the focused element — the exact class of test
 * gap called out in writing.
 */
export const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'radio',
  'checkbox',
  'range',
  'button',
  'submit',
  'reset',
  'file',
  'color',
  'image',
]);

/** True for a textarea, a contenteditable, and any `<input>` a key types into. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  if (tag === 'TEXTAREA') return true;
  if (element?.isContentEditable === true) return true;
  return tag === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
}
