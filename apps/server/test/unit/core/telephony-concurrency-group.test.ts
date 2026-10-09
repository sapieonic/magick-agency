/**
 * The grouped half of the admission funnel (ClickUp 14ygtkj9pgr): gate first,
 * composite second, composite refusal hands the gate slot back — plus the
 * `acquireTelephonyConcurrency` seam forwarding the group, and the capacity
 * classifier the dial loops park on.
 *
 * PORT NOTE (magick-agency): ported from core test/unit/core/telephony-concurrency-group.test.ts@4850d1d9.
 * The per-broadcast group gate is not ported, so every grouped case is deleted;
 * the one assertion about the UNGROUPED funnel (the forward's arity) is kept.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  acquireTelephonyConcurrency,
} from '../../../src/core/telephony-concurrency.js';

describe('acquireTelephonyConcurrency with a group', () => {
  function guards() {
    return {
      concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn() },
      accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn() },
    };
  }

  it('ungrouped arity is unchanged', async () => {
    const tryAcquireTelephonyConcurrency = vi.fn().mockResolvedValue({ result: 'acquired', providerScoped: false, newlyAcquired: true });
    const owner = { ...guards(), tryAcquireTelephonyConcurrency };

    await acquireTelephonyConcurrency(owner, 'k', 't', 'a', 'twilio');
    expect(tryAcquireTelephonyConcurrency.mock.calls[0]).toEqual(['k', 't', 'a', 'twilio', undefined]);
  });
});
