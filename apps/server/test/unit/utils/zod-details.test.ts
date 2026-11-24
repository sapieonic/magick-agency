import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodDetails } from '../../../src/utils/zod-details.js';

/** A zod error as a refusal's `details`: one message per field path, the root under a named key. */
describe('zodDetails', () => {
  const schema = z.object({
    name: z.string().min(3, 'too short').regex(/^[a-z]+$/, 'letters only'),
    items: z.array(z.object({ code: z.string() })),
  }).strict();

  it('keys each issue by its path, joined with dots (an index included)', () => {
    const bad = schema.safeParse({ name: 'ok-name', items: [{ code: 'a' }, { code: 7 }] });
    if (bad.success) throw new Error('expected a refusal');
    expect(zodDetails(bad.error, 'body')).toEqual({ name: 'letters only', 'items.1.code': expect.any(String) });
  });

  it('keeps the first message for a path that fails twice', () => {
    const bad = schema.safeParse({ name: '1', items: [] });
    if (bad.success) throw new Error('expected a refusal');
    expect(zodDetails(bad.error, 'body').name).toBe('too short');
  });

  it('puts an issue on the root under the key the caller names', () => {
    const bad = schema.safeParse(42);
    if (bad.success) throw new Error('expected a refusal');
    expect(Object.keys(zodDetails(bad.error, 'body'))).toEqual(['body']);
    expect(Object.keys(zodDetails(bad.error, 'operation'))).toEqual(['operation']);
  });
});
