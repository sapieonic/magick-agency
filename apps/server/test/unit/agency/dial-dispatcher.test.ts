// PORT NOTE (magick-agency, Phase 6): ported from core
// test/unit/agency/dial-dispatcher.test.ts@4850d1d9 (7 cases), verbatim except the
// logger mock specifier (`../../../src/utils/logger.js` → `@magick-agency/observability`,
// the path rule). No case deleted or modified.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { LocalDialDispatcher } from '../../../src/agency/dial-dispatcher.js';
import type { ClearedDialCommand } from '../../../src/agency/dial-dispatcher.js';
import type { PreDialClearance } from '../../../src/agency/pre-dial-gates.js';

/**
 * A clearance for `contactId`, issued now.
 *
 * Cast because the brand is a non-exported symbol — which is the point: only
 * `pre-dial-gates.ts` can mint one in production code, so a dial path that skipped
 * the gates would not compile. A test has to forge one, and forging it here is
 * what lets the refusal cases below be written at all.
 */
function clearance(contactId: string, checkedAt = new Date()): PreDialClearance {
  return { contactId, checkedAt } as unknown as PreDialClearance;
}

function cmd(ownerReplica: string, override: Partial<ClearedDialCommand> = {}): ClearedDialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-1', contactId: 'c1',
    sessionId: 's1', ownerReplica, tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign: {} as any, contact: {} as any,
    clearance: clearance('c1'),
    ...override,
  };
}

describe('LocalDialDispatcher', () => {
  it('executes a dial for an agent this replica owns', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    await new LocalDialDispatcher('r1', execute).dispatch(cmd('r1'));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('REFUSES a dial for an agent owned by another replica', async () => {
    const execute = vi.fn();
    const dispatcher = new LocalDialDispatcher('r1', execute);

    // Unreachable while core is single-replica, and deliberately loud rather than
    // dialing anyway: the bridge session, the agent's socket and the carrier
    // socket must end up in one process, and dialing elsewhere produces a
    // customer connected to nobody.
    await expect(dispatcher.dispatch(cmd('r2'))).rejects.toThrow(/non-owned agent session/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('propagates an execution failure so the caller can release the agent', async () => {
    const dispatcher = new LocalDialDispatcher('r1', vi.fn().mockRejectedValue(new Error('carrier down')));
    // Swallowing this would strand the agent `reserved` and the contact
    // `in_flight` with nothing to recover them until the reaper runs.
    await expect(dispatcher.dispatch(cmd('r1'))).rejects.toThrow('carrier down');
  });

  // ── The pre-dial clearance guard (`AD-P3-C-06`) ───────────────────────────
  //
  // §4.2 puts the compliance gates in the pacing tick, so this is the choke point
  // that stops a FUTURE dial path from placing calls no gate ever saw. The brand
  // makes the omission a compile error; these three cases cover what a type
  // cannot see.
  describe('refuses a dial without a valid pre-dial clearance', () => {
    it('refuses when there is none, before checking ownership', async () => {
      const execute = vi.fn();
      const dispatcher = new LocalDialDispatcher('r1', execute);
      const { clearance: _dropped, ...bare } = cmd('r1');

      await expect(dispatcher.dispatch(bare as ClearedDialCommand))
        .rejects.toThrow(/without pre-dial clearance \(missing\)/);
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses a clearance issued for a DIFFERENT contact', async () => {
      // The realistic failure, and the reason the token carries a contact id at
      // all: `dialUpTo` pairs `reserved[index]` with `contacts[index]`, so an
      // indexing mistake hands a valid clearance to a contact nobody checked —
      // a dial to an unchecked number with every type satisfied.
      const execute = vi.fn();
      const dispatcher = new LocalDialDispatcher('r1', execute);

      await expect(dispatcher.dispatch(cmd('r1', { clearance: clearance('some-other-contact') })))
        .rejects.toThrow(/\(wrong_contact\)/);
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses a clearance older than the pre-dial reservation lease', async () => {
      // A stale clearance is a stale DNC answer: an agent may have marked the
      // number since. It is bounded by the reservation lease because a clearance
      // that outlives the reservation is meaningless anyway — the agent it was
      // going to bridge to is gone.
      const { CLEARANCE_MAX_AGE_MS } = await import('../../../src/agency/pre-dial-gates.js');
      const execute = vi.fn();
      const dispatcher = new LocalDialDispatcher('r1', execute);
      const stale = clearance('c1', new Date(Date.now() - CLEARANCE_MAX_AGE_MS - 1_000));

      await expect(dispatcher.dispatch(cmd('r1', { clearance: stale })))
        .rejects.toThrow(/\(stale\)/);
      expect(execute).not.toHaveBeenCalled();
    });

    it('checks the clearance BEFORE ownership', async () => {
      // Ordering, stated as a test: a call placed with no DNC check is worse than
      // one placed on the wrong replica. The second is an abandoned call; the
      // first is a regulatory event.
      const dispatcher = new LocalDialDispatcher('r1', vi.fn());
      const { clearance: _dropped, ...bare } = cmd('r2');   // BOTH wrong

      await expect(dispatcher.dispatch(bare as ClearedDialCommand))
        .rejects.toThrow(/without pre-dial clearance/);
    });
  });
});
