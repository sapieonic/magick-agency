/**
 * SQL spellings that repositories of more than one area write the same way. A leaf: it imports
 * nothing, so the agency repository's `query-builders.ts` and the Do Not Call list's
 * `dnc.repository.ts` can both use it without one reaching into the other's folder.
 */

/**
 * `column` ends in the digits of `term`, as a PREFIX match on the reversed column, which is what a
 * `reverse(…)` expression index with `text_pattern_ops` serves (a suffix of a string is a prefix
 * of its reverse). The contacts' phone suffix search and the Do Not Call list's ending search both
 * write it here.
 *
 * Only the digits of `term` are kept, here rather than trusted from the caller: this is the one
 * place a `%` or `_` could become a LIKE wildcard, and the consequence would not be an error but a
 * search that matches more than it says. A term with no digits matches nothing (`FALSE`), never
 * every row. The reversed digits go in a parameter; the `%` is appended in SQL.
 */
export function endsWithDigitsSql(column: string, term: string, add: (value: unknown) => string): string {
  const digits = term.replace(/\D/g, '');
  if (digits.length === 0) return 'FALSE';
  return `reverse(${column}) LIKE ${add(digits.split('').reverse().join(''))} || '%'`;
}
