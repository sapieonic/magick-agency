/**
 * A number as Plivo writes it, as E.164. One rule for every place a Plivo number arrives: the
 * account's numbers in a number sync (`listNumbers`, which writes `phone_numbers.phone_number`)
 * and the `From` / `To` of an inbound call's answer and hangup webhooks (`docs/inbound.md` §3),
 * which are matched against those stored numbers, so the two must normalise identically.
 *
 * A LEAF module: no imports, no I/O.
 *
 * Plivo writes numbers as digits with the country code and no `+` (`18135401302`); a `+`
 * already present is kept and surrounding whitespace is trimmed. Anything else is null: letters
 * (a withheld caller arrives as `anonymous`, `restricted`, `unknown` or similar, or a SIP URI),
 * an empty string, a leading zero, more than 15 digits, punctuation inside the number. For an
 * inbound `From`, null means "withheld": the call is still answered, and its Missed row has no
 * number (§7).
 */

const E164 = /^\+[1-9]\d{1,14}$/;

export function plivoNumberToE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const candidate = trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
  return E164.test(candidate) ? candidate : null;
}
