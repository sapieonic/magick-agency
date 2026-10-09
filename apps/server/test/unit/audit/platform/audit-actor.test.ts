import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';

import {
  requestAuditActor,
  resolvedUserAuditActor,
  SYSTEM_AUDIT_ACTOR,
} from '../../../../src/audit/platform/audit-actor.js';
import { PLATFORM_AUDIT_ACTOR_TYPES } from '../../../../src/audit/platform/catalog.js';

/*
 * Platform API keys do not exist here (decision #5), so there is no `api_key`
 * actor and no key branch in either resolver; the two actor kinds are
 * `['human', 'system']`.
 */

/**
 * **The audit row must say WHAT KIND of principal acted.**
 *
 * Every audited write in this service used to stamp `user_id` and nothing else,
 * and `user_id` answers a narrower question than it reads as: which principal
 * the platform AUTHENTICATED. For a platform API key that is
 * `platform_api_keys.created_by` — the person who minted the credential, once,
 * possibly years ago — because `sessionMiddleware`'s key branch loads that user
 * into `request.user`. So a key-authenticated action wrote a row indistinguishable
 * from that person acting in a browser, and the audit trail contradicted the voice engine's
 * `last_transition_by`, which had already been corrected for the same defect.
 *
 * The cases below are the discriminator itself. The one that matters most is the
 * CREATOR-BACKED key: it has BOTH `apiKeyTenantId` and `request.user`, which is
 * why every previous attempt at this check — spelled `!request.user?.id` — passed
 * it straight through and only ever caught a NULL-`created_by` system key. That
 * is the one shape the tests happened to model, four times over
 * (`resolveAgencyActor`, the agency `my-*` surfaces, `resolveTransitionActor`),
 * so it is modelled explicitly here.
 */

const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const KEY_CREATOR = 'aaaaaaaa-0000-4000-8000-000000000002';
const TENANT = '11111111-1111-4111-8111-111111111111';
const KEY_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

/** Only the fields the predicate reads — `sessionMiddleware`'s output, not a real request. */
function request(fields: {
  user?: { id: string };
  apiKeyTenantId?: string;
  apiKey?: { id: string; scopes: unknown };
}): FastifyRequest {
  return fields as unknown as FastifyRequest;
}

describe('requestAuditActor', () => {
  it('reports a signed-in user as a human actor', () => {
    expect(requestAuditActor(request({ user: { id: USER } })))
      .toEqual({ actor_type: 'human', user_id: USER });
  });

  /**
   * `sessionMiddleware` 401s a request with neither, so no audited handler can
   * see this. Pinned anyway because the alternative to answering it is throwing
   * inside a buffered logger, whose flush failure drops OTHER rows too.
   */
  it('reports a request with no principal at all as system', () => {
    expect(requestAuditActor(request({}))).toEqual({ actor_type: 'system' });
  });

  /** An empty `apiKeyTenantId` is not a key — the predicate reads presence, not truthiness of a tenant. */
  it('does not read an absent apiKeyTenantId as a key', () => {
    expect(requestAuditActor(request({ user: { id: USER }, apiKeyTenantId: undefined })))
      .toEqual({ actor_type: 'human', user_id: USER });
  });
});

describe('resolvedUserAuditActor', () => {
  it('names the user the handler resolved', () => {
    expect(resolvedUserAuditActor(request({ user: { id: USER } }), USER))
      .toEqual({ actor_type: 'human', user_id: USER });
  });
});

describe('SYSTEM_AUDIT_ACTOR', () => {
  it('carries no identity of any kind', () => {
    expect(SYSTEM_AUDIT_ACTOR).toEqual({ actor_type: 'system' });
  });
});

describe('the actor-type catalog', () => {
  /**
   * `system` and `api_key` are separate values and must stay separate. Both
   * write a NULL `user_id`, so collapsing them would recreate the exact
   * three-meanings ambiguity this ticket names in the voice engine's `last_transition_by`:
   * "genuinely automatic" and "a credential did it" are opposite conclusions for
   * an incident.
   */
  it('distinguishes automatic from key-authenticated', () => {
    expect(PLATFORM_AUDIT_ACTOR_TYPES).toEqual(['human', 'system']);
  });

  /** There is no `unknown` member — that absence is a NULL column, not a value. */
  it('has no member for "not recorded"', () => {
    expect(PLATFORM_AUDIT_ACTOR_TYPES).not.toContain('unknown');
  });
});
