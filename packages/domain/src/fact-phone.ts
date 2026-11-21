/**
 * AS19's one phone rule (R6, S3): how a `phone`-typed fact is written in full and masked, on every
 * surface of both clients (the tile, the hover card, the sheet, the script, the aria text) and on
 * the server where it masks for a client. The console imports it (`stationFormat.ts` `factPhone`);
 * the agent app's Dart port (`agency_wire`) is held to the same cases
 * (`packages/contracts/fixtures/agent/fact-rules.json`, `phone`). A LEAF: no I/O, no imports.
 *
 *  - The digits are the value's digits (the domain's parse gives them with an optional `+`; a raw
 *    value the parse refused is read the same way, on its digits). The national form drops a
 *    leading `91` from twelve digits or a leading `0` from eleven and keeps ten as they are; when
 *    it is then ten digits starting 6 to 9 the number is an Indian mobile.
 *  - Full ({@link formatFactPhone}): an Indian mobile is `+91 98765 43210`; anything else is the
 *    value as given, trimmed and unspaced (`+14155550123`).
 *  - Masked ({@link maskFactPhone}): the first two and the last three digits (of the ten for an
 *    Indian mobile, else of all of them) with `•••` and `••` between (`98••• ••210`,
 *    `14••• ••123`); fewer than {@link PHONE_MASK_MIN_DIGITS} digits show none (`•••`), as the
 *    customer's own number does (`phoneForDisplay`).
 */

/** The fewest digits a masked number shows any of; fewer show `•••` alone. */
export const PHONE_MASK_MIN_DIGITS = 7;

/** What a masked number too short to mask shows. */
export const PHONE_MASK_NONE = '•••';

/** The ten digits of an Indian mobile from a number's digits (no `+`), or null. */
export function indianMobileDigits(digits: string): string | null {
  const national = digits.length === 12 && digits.startsWith('91')
    ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0')
      ? digits.slice(1)
      : digits;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}

/**
 * A phone fact in full: an Indian mobile as `+91 98765 43210`, anything else as given (trimmed).
 *
 * @param value the parsed value (digits, `+` kept when written), or a raw value the parse refused
 */
export function formatFactPhone(value: string): string {
  const text = String(value).trim();
  const mobile = indianMobileDigits(text.replace(/\D/g, ''));
  return mobile ? `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}` : text;
}

/**
 * A phone fact masked: the first two and the last three digits (`98••• ••210`), `•••` when it has
 * fewer than {@link PHONE_MASK_MIN_DIGITS}.
 *
 * @param value the parsed value, or a raw value the parse refused (masked on its digits)
 */
export function maskFactPhone(value: string): string {
  const bare = String(value).replace(/\D/g, '');
  const shown = indianMobileDigits(bare) ?? bare;
  if (shown.length < PHONE_MASK_MIN_DIGITS) return PHONE_MASK_NONE;
  return `${shown.slice(0, 2)}••• ••${shown.slice(-3)}`;
}
