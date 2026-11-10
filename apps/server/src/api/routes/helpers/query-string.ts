/** A validated query as `callCore`'s string map: only the keys that are set, each as a string. */
export function definedQueryString(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}
