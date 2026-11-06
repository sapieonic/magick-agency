import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSearchNumber, resolveSearchCountry } from '@magick-agency/domain/customer-search-number';
import { normalizePhoneToE164 } from '../../../../src/utils/phone-normalizer.js';
import { normalizeE164 } from '../../../../src/agency/dnc-registry.js';
import { normalizeDialledNumber } from '../../../../src/agency/softphone/manual-predial.js';

/**
 * The search finds what the server stored (`docs/customer-history.md` CH4, CH9). The history
 * matches `agency_contacts.phone_e164` and `agency_manual_calls.destination_e164` EXACTLY, so for
 * every number the shared table (`packages/contracts/fixtures/agent/customer-search-numbers.json`)
 * accepts for India, the roster ingest's normaliser (`normalizePhoneToE164`, then `normalizeE164`
 * as the DNC path stores it) and the soft phone's (`normalizeDialledNumber`) must give the same
 * E.164 whenever they accept the input at all.
 */

interface Case { input: string; country: string; e164?: string; error?: string }

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
