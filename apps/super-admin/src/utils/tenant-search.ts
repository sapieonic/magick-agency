/**
 * Tenant filtering for the super-admin tenant pickers.
 *
 * Kept pure (and unit-tested) so the combobox component stays presentational.
 * Matching is deliberately forgiving — a super admin typing into the box knows
 * the tenant by *some* handle (display name, slug, or a copy-pasted id), so all
 * three are searchable, and multi-word queries match in any order ("acme corp"
 * finds "Corporation Acme").
 */

/** The tenant shape the picker needs — a structural subset of `SuperAdminTenant`. */
export interface SearchableTenant {
  id: string;
  name: string;
  slug: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Split a query into whitespace-separated terms, all of which must match. */
export function queryTerms(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

/** True when every term in `query` appears in the tenant's name, slug, or id. */
export function matchesTenant(tenant: SearchableTenant, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const haystack = `${tenant.name} ${tenant.slug} ${tenant.id}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Rank: lower sorts first. Name matches beat slug/id matches, and a match at
 * the start of the name beats one in the middle, so typing "ac" surfaces
 * "Acme" above "Pacific".
 */
function rank(tenant: SearchableTenant, terms: string[]): number {
  const name = tenant.name.toLowerCase();
  const first = terms[0];
  if (!first) return 3;
  if (name.startsWith(first)) return 0;
  if (name.includes(first)) return 1;
  if (tenant.slug.toLowerCase().includes(first)) return 2;
  return 3;
}

/**
 * Filter tenants by `query`, best matches first. An empty/whitespace query
 * returns every tenant in its original (server) order.
 */
export function filterTenants<T extends SearchableTenant>(tenants: T[], query: string): T[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return tenants;
  return tenants
    .filter((t) => matchesTenant(t, query))
    .map((tenant, index) => ({ tenant, index, rank: rank(tenant, terms) }))
    // Stable within a rank: preserve the server's ordering for equal matches.
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((entry) => entry.tenant);
}
