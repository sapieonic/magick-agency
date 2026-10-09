/*
 * PORT NOTE (magick-agency): ported from core test/unit/analysis/dimension-presets.test.ts
 * @4850d1d9 (14 cases → 10). DELETED (lead, session 3): the 4-case "core's preset vs
 * cusui's copy" byte-identity block. Its sibling, cusui `src/utils/knowledgeGrounding.ts`,
 * is used only by the AI `PromptEditorPage`, which the agency console does not port
 * (plan §2: no AI surfaces), so there is no console copy to drift from the server's.
 */
import { describe, it, expect } from 'vitest';

import {
  KB_GROUNDING_DIMENSION,
  ANALYSIS_DIMENSION_PRESETS,
} from '../../../src/analysis/dimension-presets.js';
import { analyticsDimensionSchema } from '../../../src/api/validators/analytics-dimension.validator.js';

/**
 * The shipped grounding-dimension preset.
 *
 * These assertions look pedantic and are not. The preset's wording is shared
 * BYTE-FOR-BYTE with cusui's one-click "add grounding dimension" affordance: two
 * repos each phrasing "was this answer grounded?" their own way produce two
 * non-comparable measures stored under one key, which is worse than shipping
 * neither. So the exact string, its length against the shared validator's cap, the
 * key, and the option order are all pinned here — a reword then has to be a
 * deliberate cross-repo act instead of a tidy-up that silently forks the metric.
 */

const EXPECTED_DESCRIPTION =
  'Whether the agent\'s answers were correct and grounded in the catalog or document material it looked up. ' +
  'Answer "grounded" if every claim the agent made about products, policies or documented facts is supported by what it retrieved. ' +
  'Answer "ungrounded" if the agent stated something the material does not support, contradicted it, or answered from general knowledge instead of it. ' +
  'Answer "not_applicable" if the agent never needed to look anything up on this call.';

describe('KB_GROUNDING_DIMENSION', () => {
  it('has the exact key cusui and stored analysis results are keyed by', () => {
    // Renaming this orphans every value already captured under
    // `call_analysis.custom.kb_answer_grounded` — there is no migration for a
    // JSONB key spread across every tenant's rows.
    expect(KB_GROUNDING_DIMENSION.key).toBe('kb_answer_grounded');
  });

  it('is an enum with the three values, in order', () => {
    expect(KB_GROUNDING_DIMENSION.type).toBe('enum');
    expect(KB_GROUNDING_DIMENSION.options).toEqual(['grounded', 'ungrounded', 'not_applicable']);
  });

  it('carries `not_applicable`, which is why it is not a boolean', () => {
    // Without a third value, a call where the agent never looked anything up has
    // to be scored grounded or ungrounded, and the analyser will pick one — so
    // calls with no grounded answer to judge end up dominating the aggregate.
    expect(KB_GROUNDING_DIMENSION.options).toContain('not_applicable');
  });

  it('matches the canonical wording exactly', () => {
    expect(KB_GROUNDING_DIMENSION.description).toBe(EXPECTED_DESCRIPTION);
  });

  it('is 463 characters, comfortably inside the shared validator 500-char cap', () => {
    expect(KB_GROUNDING_DIMENSION.description).toHaveLength(463);
    expect(KB_GROUNDING_DIMENSION.description.length).toBeLessThanOrEqual(500);
  });

  it('is plain ASCII — no smart quotes or curly apostrophe to drift between repos', () => {
    expect(/^[\x20-\x7e]*$/.test(KB_GROUNDING_DIMENSION.description)).toBe(true);
  });

  it('parses under the SHARED dimension validator, so it is postable as-is', () => {
    // The deliverable is a preset, not new analysis infrastructure: a client posts
    // this object back verbatim into `custom_dimensions` and the existing
    // prompt-builder / JSON-schema path consumes it with no special-casing.
    const parsed = analyticsDimensionSchema.safeParse(KB_GROUNDING_DIMENSION);
    expect(parsed.success).toBe(true);
  });
});

describe('ANALYSIS_DIMENSION_PRESETS', () => {
  it('contains the grounding dimension', () => {
    expect(ANALYSIS_DIMENSION_PRESETS).toContain(KB_GROUNDING_DIMENSION);
  });

  it('every preset parses under the shared validator and has a unique key', () => {
    const keys = new Set<string>();
    for (const preset of ANALYSIS_DIMENSION_PRESETS) {
      expect(analyticsDimensionSchema.safeParse(preset).success).toBe(true);
      expect(keys.has(preset.key)).toBe(false);
      keys.add(preset.key);
    }
  });

  it('stays well inside the 20-dimension ceiling a tenant has to spend', () => {
    // A preset list that grew towards 20 would leave a customer no room for their
    // own dimensions, since the cap is on the array they post, not on ours.
    expect(ANALYSIS_DIMENSION_PRESETS.length).toBeLessThan(20);
  });
});
