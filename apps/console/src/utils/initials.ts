/** A user-perceived character that is a letter or a digit in any script ("Ö", "प्र", "7"). */
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]/u;

/** The letters and digits of `text`, as whole characters (a base letter keeps its marks). */
function lettersAndDigits(text: string): string[] {
  const chars = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment)
    : Array.from(text);
  return chars.filter((c) => LETTER_OR_DIGIT.test(c));
}

/**
 * The initials on every avatar (the signed-in person's, the station's, an agent row's): letters
 * and digits only, never punctuation ("Manas (Dev)" is "MD", not "M("). The first character of
 * the first and last words that have one; a single such word gives its first two; with no name
 * worth reading, the email's local part; "?" when neither has any.
 *
 * An unresolved agent's fallback name ("Agent 4f21ab90") gives "A4": meaningless on purpose. The
 * avatar is decoration (`aria-hidden`) beside the name, never an identity claim.
 */
export function initialsFor(name: string | null | undefined, email?: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).map(lettersAndDigits).filter((w) => w.length > 0);
  if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).join('').toUpperCase();
  const local = lettersAndDigits((email ?? '').split('@')[0] ?? '');
  return local.length > 0 ? local.slice(0, 2).join('').toUpperCase() : '?';
}
