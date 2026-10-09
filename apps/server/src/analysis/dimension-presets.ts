import type { AnalyticsDimension } from '@magick-agency/db/models/prompt.model';

/**
 * Shipped custom-analysis dimension PRESETS.
 *
 * These are not new analysis infrastructure and must not become any. The
 * `analytics_config.custom_dimensions` mechanism already exists on both sides —
 * prompt templates (AI calls) and `call_analysis_profiles` (dialer calls) — behind
 * one shared validator (`src/api/validators/analytics-dimension.validator.ts`, max
 * 20 dimensions). A preset is nothing more than a well-worded dimension object
 * that the platform ships so every customer measures the same thing the same way,
 * instead of each one writing their own prompt for it and producing numbers
 * nobody can compare. `src/analysis/prompt-builder.ts` consumes it exactly as it
 * consumes an operator-authored dimension; there is no special-casing anywhere.
 *
 * Presets are advertised on `GET /api/v1/metadata` (`analysis_dimension_presets`)
 * — the same capability-matrix surface that already publishes the voice catalog
 * and the escalation-transfer bounds — so that a client CAN read the wording from
 * here rather than keeping a copy of it.
 *
 * **Be precise about what actually guards the wording, because it is not this
 * endpoint.** cusui keeps its own copy (`src/utils/knowledgeGrounding.ts`) and does
 * not read `analysis_dimension_presets` at all — a defensible choice, since master
 * Redis-caches `/proxy/metadata` for 30 minutes and the affordance has to render
 * instantly.
 *
 * What keeps the two in step is `test/unit/analysis/dimension-presets.test.ts`,
 * which reads cusui's file four levels up and compares the concatenated
 * description BYTE FOR BYTE (plus the key and the option order). Two caveats that
 * decide whether it is actually protecting you: it **`skipIf`s when cusui is not
 * checked out beside core**, so reword from the superproject root; and it is the
 * only thing doing this — publishing the field is not, and until that test existed
 * this comment claimed enforcement that did not exist (core pinned a local literal
 * in the same file, cusui pinned only a length and three substrings).
 *
 * This module has **no runtime imports** (the one import is a type and is elided),
 * the same posture as `kb-tuning-defaults.ts` / `usage-status-values.ts`: it is
 * read by a route that already loads config and, potentially, by tests that mock
 * nothing, and it must never drag `src/config/index.js` — whose module body can
 * `process.exit(1)` — into a suite that does not mock it.
 */

/**
 * "Did the knowledge base actually answer the question, correctly?" — the Phase 3
 * grounding measure (ClickUp 86d3kh203, §4.4).
 *
 * The retrieval rollups (`kb_daily_stats`) can say how CONFIDENT retrieval was and
 * how often a call escalated afterwards. Neither is the same as whether the answer
 * the caller heard was right: a high-confidence match the model then paraphrased
 * into something the catalog does not say scores perfectly on both. This dimension
 * is the only signal that closes that gap, and it comes from the post-call
 * analyser reading the transcript.
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
 *  3. **The wording is shared, byte-for-byte, with cusui's one-click affordance.**
 *     Two repos each phrasing "was this grounded?" their own way produce two
 *     non-comparable measures under one key, which is worse than having neither.
 *     `test/unit/analysis/dimension-presets.test.ts` pins the exact string, its
 *     length against the shared validator's 500-char cap, and that it parses under
 *     `analyticsDimensionSchema` — so a reword has to be a deliberate cross-repo
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
 * Every preset the platform ships, in the order a UI should offer them.
 *
 * A list rather than a single export so `/metadata` publishes one array that grows
 * without a route change, and so a client can render "add a preset" generically.
 */
export const ANALYSIS_DIMENSION_PRESETS: readonly AnalyticsDimension[] = [KB_GROUNDING_DIMENSION];
