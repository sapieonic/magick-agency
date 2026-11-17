import { describe, expect, it } from 'vitest';
import { contactNameContextSql } from '../../../src/db/repositories/agency/sql-fragments.js';
import { INBOUND_MATCH_NAME_COLUMNS } from '../../../src/agency/inbound/match-name.js';

/**
 * The live calls list, the listening history and the inbound Missed list read a contact's name
 * through one SQL spelling: only the columns `matchName` reads leave the database.
 */
describe('contactNameContextSql', () => {
  it('builds the name columns of the aliased contact, NULL when the join found none', () => {
    expect(contactNameContextSql('ct')).toBe(
      "CASE WHEN ct.id IS NULL THEN NULL ELSE jsonb_build_object('name', ct.context->'name', "
      + "'full_name', ct.context->'full_name', 'customer_name', ct.context->'customer_name', "
      + "'first_name', ct.context->'first_name') END",
    );
  });

  it('reads exactly the columns matchName reads, in its order', () => {
    const keys = [...contactNameContextSql('mc').matchAll(/'([a-z_]+)', mc\.context->'\1'/g)].map((m) => m[1]);
    expect(keys).toEqual([...INBOUND_MATCH_NAME_COLUMNS]);
  });
});
