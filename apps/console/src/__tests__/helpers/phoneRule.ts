import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePhoneFact } from '@magick-agency/domain/context-facts';

/**
 * AS19's one phone rule (R6, S3) as the shared cases (`packages/contracts/fixtures/agent/
 * fact-rules.json`, `phone`), read from disk so the console's card, hover card and script are held
 * to the same table as the domain and the agent app (S5). Edit a case there, not here.
 */

const FIXTURES = resolve(__dirname, '../../../../../packages/contracts/fixtures/agent');

interface PhoneRuleCase {
  value: string;
  full: string;
  masked: string;
}

const CASES: readonly PhoneRuleCase[] = (
  JSON.parse(readFileSync(resolve(FIXTURES, 'fact-rules.json'), 'utf-8')) as { phone: PhoneRuleCase[] }
).phone;

/**
 * The cases the domain's parse reads as a phone (a tile's `value` is then set): `[value as
 * uploaded, full, masked]`. The tile, the hover card and the script write these exactly.
 */
export const PHONE_RULE_TABLE: ReadonlyArray<readonly [string, string, string]> = CASES
  .filter((c) => parsePhoneFact(c.value) !== null)
  .map((c) => [c.value, c.full, c.masked] as const);

/**
 * The non-blank cases the parse refuses (the tile's `value` is null): `[value as uploaded,
 * masked]`. Under `masked` they are masked on their digits exactly as the rule says; in full they
 * show as uploaded (spec §6: an unreadable value is shown raw).
 */
export const PHONE_RULE_UNREAD: ReadonlyArray<readonly [string, string]> = CASES
  .filter((c) => c.value.trim() !== '' && parsePhoneFact(c.value) === null)
  .map((c) => [c.value, c.masked] as const);
