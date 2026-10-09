import type { AnalyticsDimension } from '@magick-agency/db/models/prompt.model';

/**
 * Shipped custom-analysis dimension PRESETS.
 *
 * These are not new analysis infrastructure and must not become any. The
 * `analytics_config.custom_dimensions` mechanism already exists on
 * `call_analysis_profiles`, behind one shared validator
 * (`src/api/validators/analytics-dimension.validator.ts`, max 20 dimensions). A
 * preset is nothing more than a well-worded dimension object that the product
 * ships so every customer measures the same thing the same way, instead of each
 * one writing their own prompt for it and producing numbers nobody can compare.
 * `src/analysis/prompt-builder.ts` consumes it exactly as it consumes an
 * operator-authored dimension; there is no special-casing anywhere.
 *
 * What guards the wording is `test/unit/analysis/dimension-presets.test.ts`, which
 * pins the exact description, the key and the option order.
 *
 * This module has **no runtime imports** (the one import is a type and is elided):
 * it may be read by tests that mock nothing, and it must never drag
 * `src/config/index.js` — whose module body can `process.exit(1)` — into a suite
 * that does not mock it.
 */

/**
 * "Did the knowledge base actually answer the question, correctly?" — the
 * grounding measure.
 *
 * How CONFIDENT a lookup was is not the same as whether the answer the caller
 * heard was right: a high-confidence match then paraphrased into something the
 * catalog does not say would score perfectly on confidence. This dimension closes
 * that gap, and it comes from the post-call analyser reading the transcript.
 *
 * **Three properties of the shape are load-bearing.**
 *
 *  1. **`not_applicable` is why this is an enum and not a boolean.** On a call
 *     where the agent never looked anything up there is no grounded answer to
 *     judge — but a two-valued dimension leaves the analyser no way to say so, and
 *     it will dutifully pick `grounded` or `ungrounded` anyway. Those calls then
 *     dominate the aggregate and the number stops meaning anything.
 *  2. **The key is stable, permanently.** Stored analysis results are keyed by it
 *     (`call_analysis.custom.kb_answer_grounded`), so renaming it orphans every
 *     value already captured — there is no migration for a JSONB key that a
 *     hundred tenants' rows carry.
 *  3. **The wording is pinned.** Two phrasings of "was this grounded?" produce
 *     two non-comparable measures under one key, which is worse than having
 *     neither. `test/unit/analysis/dimension-presets.test.ts` pins the exact
 *     string, its length against the shared validator's 500-char cap, and that it
 *     parses under `analyticsDimensionSchema` — so a reword has to be a deliberate
 *     act rather than a tidy-up.
 */
export const KB_GROUNDING_DIMENSION: AnalyticsDimension = {
  key: 'kb_answer_grounded',
  description:
    'Whether the agent\'s answers were correct and grounded in the catalog or document material it looked up. ' +
    'Answer "grounded" if every claim the agent made about products, policies or documented facts is supported by what it retrieved. ' +
    'Answer "ungrounded" if the agent stated something the material does not support, contradicted it, or answered from general knowledge instead of it. ' +
    'Answer "not_applicable" if the agent never needed to look anything up on this call.',
  type: 'enum',
  options: ['grounded', 'ungrounded', 'not_applicable'],
};

/**
 * Every preset the product ships, in the order a UI should offer them.
 *
 * A list rather than a single export so the set can grow without changing its
 * consumers, and so a client can render "add a preset" generically.
 */
export const ANALYSIS_DIMENSION_PRESETS: readonly AnalyticsDimension[] = [KB_GROUNDING_DIMENSION];
