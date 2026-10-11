import type { ZodIssue } from 'zod';

/**
 * Zod issues reduced to `{ path, message }` with no submitted value in either.
 *
 * Dropping `received` is not enough: zod 3 also writes the submitted value into the
 * MESSAGE of an enum or literal issue ("…received 'tok_…'"), so those messages are
 * rebuilt from the schema side alone. Used for every credential 400, where a value can
 * be a secret.
 */
export function safeIssues(issues: readonly ZodIssue[], prefix?: string): Array<{ path: string; message: string }> {
  return issues.map((i) => {
    let message = i.message;
    if (i.code === 'invalid_enum_value') message = `Expected one of: ${i.options.map(String).join(', ')}`;
    else if (i.code === 'invalid_literal') message = 'Invalid value';
    const path = [...(prefix ? [prefix] : []), ...i.path.map(String)].join('.');
    return { path, message };
  });
}
