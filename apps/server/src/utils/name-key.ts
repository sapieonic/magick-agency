/**
 * How two names a person typed are compared for "already taken": Unicode-compatibility folded,
 * trimmed, inner whitespace collapsed, case-folded. "Sales ", "sales" and "SALES" are one name in a
 * list, so they are one name here. The rule of account names (AA2,
 * `api/routes/helpers/create-account.ts`) and of campaign template names (CT13,
 * `db/repositories/agency/campaign-template.repository.ts`). Invisible format characters never get
 * this far: the routes refuse them.
 */
export function nameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
