/**
 * Compare agents (docs/compare-agents.md): the pure rules behind the page, as one import,
 * `@magick-agency/domain/agent-compare`. A barrel over `./agent-compare/*.ts`, each a leaf that
 * imports only the contract and its siblings; a single file is also importable on its own
 * (`@magick-agency/domain/agent-compare/findings`).
 *
 * - `wilson.ts`: the 95% Wilson score interval every rate carries.
 * - `percentiles.ts`: p25 / median / p75 by `percentile_cont`, the roster benchmark's method
 *   (the roster's benchmark reads it too).
 * - `metrics.ts`: resolving refs against a campaign's catalog, one agent's value, the cohort's band.
 * - `lens.ts`: the lenses' starting metrics and trend, and the campaign's starting lens.
 * - `findings.ts`: what stands out, and what is not clear yet (§6).
 */
export * from './agent-compare/wilson';
export * from './agent-compare/percentiles';
export * from './agent-compare/metrics';
export * from './agent-compare/lens';
export * from './agent-compare/findings';
