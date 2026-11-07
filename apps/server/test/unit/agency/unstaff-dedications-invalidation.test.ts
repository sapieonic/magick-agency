import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `returnContactsOnUnstaff` (`agency/assignment/unstaff.ts`) publishes `dedications_changed` for
// every campaign whose staffing closed, BEFORE its release statement, and whether or not that
// statement succeeds: the dedication stopped counting when the staffing row closed
// (`EFFECTIVE_DEDICATION_SQL`), so the dial paths' cached map must drop it either way. The
// routes and the real repository are `test/integration/api/agency-agent-caller-id-cache.test.ts`.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const { repo } = vi.hoisted(() => ({ repo: { returnOnUnstaff: vi.fn() } }));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({ agencyAssignmentRepository: repo }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: vi.fn() } }));
vi.mock('../../../src/agency/agent-caller-id-audit.js', () => ({ auditAgentCallerIdCleared: vi.fn() }));

import { returnContactsOnUnstaff } from '../../../src/agency/assignment/unstaff.js';
import {
  resetPacingInvalidationBusForTests,
  type PacingInvalidationEvent,
} from '../../../src/agency/pacing/invalidation-bus.js';

const ACTOR = { actor_type: 'system' as const, user_id: null };

let events: PacingInvalidationEvent[];
beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  resetPacingInvalidationBusForTests().subscribe((e) => events.push(e));
});

const input = (campaignIds: string[]) => ({
  tenantId: 't1', userId: 'u1', campaignIds, eventActorUserId: null, actor: ACTOR as never, cause: 'unstaffed' as const,
});

describe('returnContactsOnUnstaff: dedications_changed', () => {
  it('one event per campaign closed (deduplicated), published before the release runs', async () => {
    repo.returnOnUnstaff.mockImplementation(async () => {
      // By the time the release statement runs, the events are out.
      expect(events.map((e) => e.type)).toEqual(['dedications_changed', 'dedications_changed']);
      return [];
    });
    await returnContactsOnUnstaff(input(['c1', 'c2', 'c1']));
    expect(events).toEqual([
      { type: 'dedications_changed', campaignId: 'c1' },
      { type: 'dedications_changed', campaignId: 'c2' },
    ]);
    expect(repo.returnOnUnstaff).toHaveBeenCalledTimes(1);
  });

  it('still published when the release statement fails (the staffing close stands)', async () => {
    repo.returnOnUnstaff.mockRejectedValue(new Error('connection reset'));
    await expect(returnContactsOnUnstaff(input(['c1']))).resolves.toEqual([]);
    expect(events).toEqual([{ type: 'dedications_changed', campaignId: 'c1' }]);
  });

  it('no campaign closed: nothing published, nothing run', async () => {
    await returnContactsOnUnstaff(input([]));
    expect(events).toEqual([]);
    expect(repo.returnOnUnstaff).not.toHaveBeenCalled();
  });
});
