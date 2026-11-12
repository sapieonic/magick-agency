import { describe, expect, it } from 'vitest';
import { endsWithDigitsSql, params, phoneCondition } from '../../../src/db/repositories/agency/query-builders.js';

/**
 * `endsWithDigitsSql` (`query-builders.ts`): the reversed-suffix match the contacts' phone
 * search and the DNC list's ending search share. Their plans are pinned on real Postgres
 * (`test/integration/dnc/dnc-index-usage.test.ts`, the spine's phone-suffix cases).
 */
describe('endsWithDigitsSql', () => {
  it('matches the reversed column by prefix, the term reversed into a parameter, the % in SQL', () => {
    const bind = params();
    expect(endsWithDigitsSql('phone_e164', '1234', bind.add)).toBe(`reverse(phone_e164) LIKE $1 || '%'`);
    expect(bind.values).toEqual(['4321']);
  });

  it('numbers its parameter after the ones already bound', () => {
    const values: unknown[] = ['tenant'];
    expect(endsWithDigitsSql('c.x', '90', (v) => `$${values.push(v)}`)).toBe(`reverse(c.x) LIKE $2 || '%'`);
    expect(values).toEqual(['tenant', '09']);
  });

  it('is the contacts phone search’s suffix form', () => {
    const a = params();
    const b = params();
    const cond = phoneCondition({ mode: 'suffix', value: '1234' }, 'c', a);
    const digits = cond.slice('reverse('.length, cond.indexOf(') LIKE'));
    expect(cond).toBe(endsWithDigitsSql(digits, '1234', b.add));
    expect(a.values).toEqual(b.values);
  });
});
