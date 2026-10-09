import { describe, it, expect } from 'vitest';
import {
  PRIOR_ATTEMPT_LIMIT,
  RETRY_IDEMPOTENCY_KEY_MAX,
  RETRY_IDEMPOTENCY_KEY_MIN,
  RETRY_IDEMPOTENCY_KEY_PATTERN,
  RETRY_INHERITED_CONFIG_KEYS,
  RETRY_MAX_GENERATION,
  RETRY_MAX_SEED_ROWS,
} from '../../../src/retry-campaign-bounds.js';

/**
 * ─── THE CROSS-REPO BOUNDS, PINNED TO THEIR LITERAL VALUES ──────────────────
 *
 * Every other test in this feature reads these constants SYMBOLICALLY, which is
 * right — a test asserting `matched > RETRY_MAX_SEED_ROWS` should keep passing
 * when the number is tuned. The consequence is that nothing anywhere fails when
 * the number CHANGES, and these are not private numbers: the wire contract's §8
 * fixes them so three repositories agree, and neither magick-master nor
 * magick-comms-cusui is a dependency of this one, so no compiler and no CI job
 * can see the other two copies.
 *
 * So this file is the one place that fails on a change of value, and its job is
 * to be a prompt rather than an obstacle: **changing a number here is fine —
 * change §8 and the sibling repos' copy in the same commit.** A bound tuned in
 * core alone leaves master's error copy and the console's "up to 100,000
 * contacts" naming a limit that no longer exists, and the supervisor learns the
 * real one from a refusal.
 *
 * (`max_seed_rows` is *served* on the preview payload precisely so the console
 * need not hold a copy — that is the right pattern and this file is the backstop
 * for the surfaces that cannot be served, chiefly prose.)
 */
describe('the wire contract §8 constants', () => {
  it('are the values §8 publishes', () => {
    expect(RETRY_MAX_SEED_ROWS).toBe(100_000);
    expect(RETRY_MAX_GENERATION).toBe(10);
    expect(PRIOR_ATTEMPT_LIMIT).toBe(20);
    expect(RETRY_IDEMPOTENCY_KEY_MIN).toBe(16);
    expect(RETRY_IDEMPOTENCY_KEY_MAX).toBe(64);
  });

  it('bounds the idempotency key to the COLUMN, so an over-long key is a 400 and not a 22001', () => {
    // `agency_campaigns.retry_idempotency_key` is `VARCHAR(64)` (migration 115).
    // Widening the constant past the column turns a validation decision into a
    // Postgres error surfacing as a 500 on a well-formed request.
    expect(RETRY_IDEMPOTENCY_KEY_MAX).toBeLessThanOrEqual(64);
    expect(RETRY_IDEMPOTENCY_KEY_MIN).toBeLessThan(RETRY_IDEMPOTENCY_KEY_MAX);
  });

  it('accepts a UUID and rejects anything carrying whitespace', () => {
    // `crypto.randomUUID()` is what the console sends, so the pattern failing it
    // would refuse every keyed retry in the product.
    expect(RETRY_IDEMPOTENCY_KEY_PATTERN.test('b3f1c0de-0000-4000-8000-000000000001')).toBe(true);
    // Whitespace is excluded so a key that round-tripped through a form field
    // cannot differ from itself by a trailing space — two spellings of one intent
    // is two campaigns, which is this feature's whole failure mode in disguise.
    expect(RETRY_IDEMPOTENCY_KEY_PATTERN.test('b3f1c0de-0000-4000-8000-000000000001 ')).toBe(false);
    expect(RETRY_IDEMPOTENCY_KEY_PATTERN.test('has space')).toBe(false);
    expect(RETRY_IDEMPOTENCY_KEY_PATTERN.test('')).toBe(false);
  });

  it('inherits exactly the seventeen config columns §2 lists, and no lifecycle column', () => {
    // The list is what a retry copies from its parent (DR-10). A LIFECYCLE column
    // landing in it would carry the parent's run onto a campaign that has never
    // dialled — a terminal status, a start time, or a stale auto-pause record on
    // a draft. `campaign-retry-repository.test.ts` asserts they are absent from
    // the INSERT; this asserts they are absent from the SOURCE of that list.
    expect(RETRY_INHERITED_CONFIG_KEYS).toHaveLength(17);
    for (const forbidden of [
      'status', 'started_at', 'ended_at', 'completed_at', 'contacts_total',
      'parent_campaign_id', 'root_campaign_id', 'retry_generation', 'retry_selector',
      'retry_idempotency_key', 'pause_reason', 'paused_at', 'pause_abandonment_rate_pct',
      'last_transition_by_user_id', 'last_transition_by_name',
    ]) {
      expect(RETRY_INHERITED_CONFIG_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });
});
