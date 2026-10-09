/**
 * The parent product's name in any spacing or case, and its domains (decision B17).
 *
 * Assembled from parts so this file — and every test that imports it to assert
 * the name is absent — does not itself spell the name the repository-wide
 * self-containment guard (`apps/server/test/unit/branding/no-external-references.test.ts`)
 * forbids.
 */
export const PARENT_BRAND = new RegExp(['mag', 'ick?', '[\\s_-]?', 'voi', 'ce'].join(''), 'i');
