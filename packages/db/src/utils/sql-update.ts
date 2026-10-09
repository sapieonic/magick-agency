/**
 * Build a parameterized SET clause for a partial UPDATE, guarding every column
 * name against an allow-list.
 *
 * Column names cannot be passed as bound parameters, so the generic repository
 * `update()` helpers interpolate them straight from `Object.keys(input)`. As long
 * as the input is a Zod-validated, strictly-typed object that is safe — but if a
 * `.passthrough()` schema (or any future caller) ever let an attacker-controlled
 * key through, that key would be interpolated directly into SQL. Rejecting any
 * key that is not on the explicit allow-list closes that latent injection vector.
 *
 * @param input         Partial update object (column → value). `undefined` values are skipped.
 * @param allowed       The set of column names that may be written.
 * @param jsonColumns   Columns whose values must be `JSON.stringify`-ed before binding.
 * @returns             `{ clauses, values }` — `clauses` use positional params `$1..$n`.
 * @throws              If a non-`undefined` value is provided for a column not in `allowed`.
 */
export function buildUpdateSet<T extends object>(
  input: T,
  allowed: ReadonlySet<string>,
  jsonColumns: ReadonlySet<string> = new Set(),
): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) {
      throw new Error(`Disallowed update column: ${key}`);
    }
    clauses.push(`${key} = $${paramIndex}`);
    values.push(jsonColumns.has(key) ? JSON.stringify(value) : value);
    paramIndex++;
  }

  return { clauses, values };
}
