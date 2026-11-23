import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSearchNumber, resolveSearchCountry } from '@magick-agency/domain/customer-search-number';
import { normalizePhoneToE164 } from '../../../../src/utils/phone-normalizer.js';
import { normalizeE164 } from '../../../../src/agency/dnc-registry.js';
import { normalizeDialledNumber } from '../../../../src/agency/softphone/manual-predial.js';
import { plivoNumberToE164 } from '@magick-agency/domain/plivo-number';

/**
 * The search finds what the server stored (`docs/customer-history.md` CH4, CH9). The history
 * matches `agency_contacts.phone_e164` and `agency_manual_calls.destination_e164` EXACTLY, so for
 * every number the shared table (`packages/contracts/fixtures/agent/customer-search-numbers.json`)
 * accepts for India, the roster ingest's normaliser (`normalizePhoneToE164`, then `normalizeE164`
 * as the DNC path stores it) and the soft phone's (`normalizeDialledNumber`) must give the same
 * E.164 whenever they accept the input at all.
 */

interface Case { input: string; country: string | null; defaultCallingCode?: string; e164?: string; error?: string }

const TABLE = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../../../../packages/contracts/fixtures/agent/customer-search-numbers.json', import.meta.url)),
  'utf8',
)) as { cases: Case[] };

const okIndia = TABLE.cases.filter((c) => c.country === 'IN' && typeof c.e164 === 'string');

/**
 * OPEN DEFECT, pinned: the roster ingest keeps a bracketed trunk `(0)` after the country code
 * (`normalizePhoneToE164` strips the brackets and keeps the 0: `+44 (0)20 7946 0018` is stored as
 * `+4402079460018`), where the search and the soft phone drop it (`+442079460018`). A roster row
 * typed that way is not found by the search. The fix belongs to the ingest's normaliser (it would
 * change what existing rosters dedupe on), so it is not made here. Flip to `it` when it lands.
 */
const ROSTER_KEEPS_TRUNK = new Set(['+44 (0)20 7946 0018']);

describe('the search number agrees with what the server stores', () => {
  it('has Indian accepted cases to check', () => {
    expect(okIndia.length).toBeGreaterThanOrEqual(5);
  });

  const check = (input: string, e164: string) => {
    // The server's own search runs the table's rule.
    const searched = parseSearchNumber(input, resolveSearchCountry('IN', '91'));
    expect(searched).toMatchObject({ ok: true, e164 });

    const softphone = normalizeDialledNumber(input, '91');
    if (softphone !== null) expect(softphone, 'soft phone').toBe(e164);

    const roster = normalizeE164(normalizePhoneToE164(input, { defaultCountryCode: '91' }));
    if (roster !== null) expect(roster, 'roster ingest').toBe(e164);
  };

  it.each(okIndia.filter((c) => !ROSTER_KEEPS_TRUNK.has(c.input)).map((c) => [c.input, c.e164!] as const))(
    '%s → %s', (input, e164) => check(input, e164),
  );

  it.fails.each(okIndia.filter((c) => ROSTER_KEEPS_TRUNK.has(c.input)).map((c) => [c.input, c.e164!] as const))(
    'OPEN DEFECT: the roster ingest keeps the bracketed trunk 0: %s → %s', (input, e164) => check(input, e164),
  );

  it('the pinned defect is still in the table', () => {
    for (const input of ROSTER_KEEPS_TRUNK) expect(okIndia.some((c) => c.input === input), input).toBe(true);
  });
});

/**
 * A platform default the picker does not list (`DEFAULT_PHONE_COUNTRY_CODE=27`): the search's
 * country is the default's own entry (search.ts: `resolveSearchCountry(body.country,
 * defaultPhoneCountryCode())` with no `country`), never India, and for a number typed without `+`
 * or `00` it gives EXACTLY what the roster ingest and the soft phone give, refusal included: the
 * same rule, not merely the same answer where both accept.
 */
describe('an unlisted platform default agrees with the roster ingest exactly', () => {
  const searchCountry = (code: string) => resolveSearchCountry(undefined, code);

  it('is the default\'s own country, not India', () => {
    expect(searchCountry('27')).toMatchObject({ callingCode: '27', unlisted: true });
  });

  const national = (input: string) => !/^\s*(\+|00)/.test(input);

  const agree = (input: string, code: string) => {
    const searched = parseSearchNumber(input, searchCountry(code));
    const roster = normalizeE164(normalizePhoneToE164(input, { defaultCountryCode: code }));
    const softphone = normalizeDialledNumber(input, code);
    expect(searched.ok ? searched.e164 : null, `search ${input} (+${code})`).toBe(roster);
    expect(softphone, `soft phone ${input} (+${code})`).toBe(roster);
  };

  const unlisted = TABLE.cases.filter((c) => c.country === null);
  it('the table has unlisted-default cases', () => {
    expect(unlisted.length).toBeGreaterThanOrEqual(5);
  });

  it.each(unlisted.filter((c) => national(c.input)).map((c) => [c.input, c.defaultCallingCode!.replace(/^\+/, '')] as const))(
    'table: %s (+%s)', (input, code) => agree(input, code),
  );

  it('the table\'s international forms give what the ingest stores', () => {
    for (const c of unlisted.filter((x) => !national(x.input) && x.e164)) {
      const code = c.defaultCallingCode!.replace(/^\+/, '');
      expect(normalizeE164(normalizePhoneToE164(c.input.replace(/^00/, '+'), { defaultCountryCode: code })), c.input).toBe(c.e164);
    }
  });

  it('every national length, with and without the calling code and a trunk 0, for 1-, 2- and 3-digit codes', () => {
    for (const code of ['7', '27', '234']) {
      for (let n = 1; n <= 17; n++) {
        const body = '8123456789012345678'.slice(0, n);
        for (const digits of [body, `${code}${body}`.slice(0, n)]) {
          agree(digits, code);
          agree(`0${digits}`, code);
          agree(`0${digits.slice(0, 3)} ${digits.slice(3)}`, code);
        }
      }
    }
  });
});

/**
 * Inbound calls (`docs/call-log.md` §8, CL39): the history matches `agency_inbound_calls.from_e164`
 * exactly too. "Found however it is typed" is about what the READER types: the search turns it
 * into one E.164. What is stored depends on what the CARRIER sent, and the arrival
 * (`plivoNumberToE164`) only adds a missing `+`: it knows no default country and drops no trunk 0.
 * So a call is found when the carrier sent the caller in full with its country code, which is
 * what Plivo is documented to send; that this holds on a live line is one of the P0 checks
 * (`docs/inbound.md` §12), not something a unit test can show. The cases below pin today's
 * arrival for every other form, so a change to it shows up here.
 */
describe('how an inbound call\'s caller is stored, against what the search looks for', () => {
  const india = resolveSearchCountry('IN', '91');
  const searched = (typed: string) => {
    const parsed = parseSearchNumber(typed, india);
    return parsed.ok ? parsed.e164 : null;
  };

  it('a caller sent in full, with or without its +, is stored as the E.164 every typed form is searched as', () => {
    for (const sent of ['919876543210', '+919876543210', ' 919876543210 ']) {
      expect(plivoNumberToE164(sent), sent).toBe('+919876543210');
    }
    for (const typed of ['+91 98765 43210', '098765-43210', '98765 43210', '9876543210', '+919876543210']) {
      expect(searched(typed), typed).toBe('+919876543210');
    }
  });

  it('PINNED, not found today: a caller sent in national format is stored as if its first digits were a country code', () => {
    // Ten national digits get a `+` and nothing else: `+9876543210`, not `+919876543210`.
    const stored = plivoNumberToE164('9876543210');
    expect(stored).toBe('+9876543210');
    // No way of typing the customer's number in India's box searches for that.
    for (const typed of ['9876543210', '09876543210', '+91 98765 43210']) expect(searched(typed), typed).not.toBe(stored);
  });

  it('PINNED, not found today: a caller sent with a trunk 0, punctuation or as text is stored as withheld (no number)', () => {
    for (const sent of ['09876543210', '0919876543210', '+91 98765 43210', '98765-43210', 'anonymous', 'sip:9876543210@carrier', '']) {
      expect(plivoNumberToE164(sent), sent).toBeNull();
    }
  });
});
