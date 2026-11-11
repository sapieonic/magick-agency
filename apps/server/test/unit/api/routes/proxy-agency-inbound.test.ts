import { describe, expect, it } from 'vitest';
import { AGENCY_INBOUND_ERROR_CODES, AGENCY_INBOUND_SUMMARY_MAX_DAYS } from '@magick-agency/contracts/api/agency/inbound';
import {
  INBOUND_REFUSAL_STATUS,
  inboundMissedToWire,
  inboundRefusalBody,
  isInboundCoreAnswer,
} from '../../../../src/api/routes/agency/inbound-answer.js';
import { unavailableActionIssues } from '../../../../src/api/routes/agency/inbound.js';
import { inboundMissedAssignSchema, inboundSummaryQuerySchema, pct } from '../../../../src/api/routes/agency/inbound-missed-work.js';
import { inboundMissedCountQuerySchema, inboundMissedQuerySchema, missedAssigneeScope } from '../../../../src/api/routes/helpers/inbound-missed-query.js';
import { definedQueryString } from '../../../../src/api/routes/helpers/query-string.js';
import type { AgencyInboundMissedRow } from '../../../../src/db/repositories/agency.repository.js';

/**
 * The inbound routes' pure pieces (`api/routes/agency/inbound-answer.ts`, `inbound.ts`,
 * `helpers/inbound-missed-query.ts`): each refusal code's status as `errors.ts` §6 states it and
 * its body, the envelope check, a Missed row's console shape, this build's refusal of
 * `voicemail`, and the Missed query's validation. The routes themselves run against Postgres in
 * `test/integration/api/inbound-routes.test.ts`.
 */

describe('refusals', () => {
  it('gives every contract code the status errors.ts states, and a body with its fields', () => {
    expect(Object.keys(INBOUND_REFUSAL_STATUS).sort()).toEqual([...AGENCY_INBOUND_ERROR_CODES].sort());
    expect(INBOUND_REFUSAL_STATUS).toEqual({
      inbound_disabled: 403,
      inbound_route_invalid: 400,
      inbound_route_not_found: 404,
      inbound_route_name_taken: 409,
      inbound_number_not_found: 409,
      inbound_number_not_linked: 409,
      inbound_number_in_use: 409,
      inbound_missed_call_not_found: 404,
      inbound_call_live: 409,
      inbound_call_not_found: 404,
      inbound_call_not_dispositionable: 409,
      inbound_disposition_invalid: 400,
      inbound_outcome_already_saved: 409,
      inbound_clip_not_found: 404,
      inbound_clip_in_use: 409,
      inbound_clip_invalid: 400,
      inbound_clip_name_taken: 409,
      inbound_clip_storage_unavailable: 503,
      inbound_missed_call_handled: 409,
      inbound_assignee_invalid: 400,
      inbound_missed_call_claimed: 409,
    });
    expect(inboundRefusalBody({ code: 'inbound_call_live', inbound_call_id: 'ib-1' })).toEqual({
      status: 409,
      body: {
        error: 'Conflict', code: 'inbound_call_live', message: 'An inbound call is in progress or still needs its outcome.',
        inbound_call_id: 'ib-1',
      },
    });
    expect(inboundRefusalBody({ code: 'inbound_number_in_use', phone_number_id: 'n-1', route_id: 'r-1' })).toEqual({
      status: 409,
      body: {
        error: 'Conflict', code: 'inbound_number_in_use', message: 'That number already answers another inbound route.',
        phone_number_id: 'n-1', route_id: 'r-1',
      },
    });
    expect(inboundRefusalBody({ code: 'inbound_disabled' }).body).toEqual({
      error: 'Forbidden', code: 'inbound_disabled', message: 'Inbound calls are not turned on for this account.',
    });
  });

  it('an upload refusal says its own reason; one over the size limit is 413, as the multipart limit answers', () => {
    expect(inboundRefusalBody({ code: 'inbound_clip_invalid', upload_reason: 'too_long', message: 'Too long.' })).toEqual({
      status: 400,
      body: { error: 'Bad Request', code: 'inbound_clip_invalid', message: 'Too long.', upload_reason: 'too_long' },
    });
    expect(inboundRefusalBody({ code: 'inbound_clip_invalid', upload_reason: 'too_large' }).status).toBe(413);
    expect(inboundRefusalBody({ code: 'inbound_clip_invalid', upload_reason: 'too_large' }).body.error).toBe('Payload Too Large');
    expect(inboundRefusalBody({ code: 'inbound_clip_in_use', routes: [{ route_id: 'r-1', name: 'Main' }] })).toEqual({
      status: 409,
      body: {
        error: 'Conflict', code: 'inbound_clip_in_use',
        message: 'This recording is in use, so it cannot be deleted. Choose another recording where it is used first.',
        routes: [{ route_id: 'r-1', name: 'Main' }],
      },
    });
    expect(inboundRefusalBody({ code: 'inbound_clip_storage_unavailable' })).toMatchObject({ status: 503, body: { error: 'Service Unavailable' } });
  });

  it('recognises only the audited routes’ envelope', () => {
    expect(isInboundCoreAnswer({ answer: null, audit: { route_id: 'r' } })).toBe(true);
    expect(isInboundCoreAnswer({ route: {} })).toBe(false);
    expect(isInboundCoreAnswer({ answer: {}, audit: null })).toBe(false);
    expect(isInboundCoreAnswer([])).toBe(false);
  });
});

describe('voicemail in this build (P2)', () => {
  it('is accepted on either action: the build records one', () => {
    expect(unavailableActionIssues({ after_hours_action: 'callback', overflow_action: 'callback' })).toEqual([]);
    expect(unavailableActionIssues({ after_hours_action: 'voicemail', overflow_action: 'voicemail' })).toEqual([]);
  });
});

describe('a Missed row on the wire', () => {
  const row = {
    id: 'c-1', tenant_id: 't', account_id: 'a', route_id: 'r', phone_number_id: 'p', provider: 'plivo',
    telephony_credential_id: 'cred', provider_call_id: 'CA-1', from_e164: null, to_e164: '+441632960001',
    matched_contact_id: null, matched_campaign_id: null, caller_dnc: true, sticky_user_id: 'u-1', sticky_reason: 'owner',
    state: 'ended', outcome: 'overflow', arrived_at: new Date('2026-11-08T09:00:00Z'), answered_at: null, bridged_at: null,
    answered_by_user_id: null, ended_at: new Date('2026-11-08T09:02:00Z'), talk_seconds: null, webrtc_call_id: null,
    voicemail_key: 'vm/1', callback_due_at: new Date('2026-11-09T09:00:00Z'), follow_up_status: 'handled',
    follow_up_reason: 'overflow', follow_up_assignee_user_id: 'u-1', handled_by_user_id: 'u-2',
    handled_at: new Date('2026-11-08T10:00:00Z'), created_at: new Date(), updated_at: new Date(),
    route_name: 'Main line', matched_campaign_name: null, handled_reason: 'reached', closed_cause: null,
    match_context: null,
  } as AgencyInboundMissedRow;

  it('carries the follow-up, ISO times and the names it is given', () => {
    expect(inboundMissedToWire(row, new Map([['u-1', 'Asha'], ['u-2', null]]))).toEqual({
      id: 'c-1', account_id: 'a', route_id: 'r', route_name: 'Main line', from_e164: null, to_e164: '+441632960001',
      arrived_at: '2026-11-08T09:00:00.000Z', ended_at: '2026-11-08T09:02:00.000Z', reason: 'overflow', closed_cause: null, outcome: 'overflow',
      caller_dnc: true, match_name: null, matched_contact_id: null, matched_campaign_id: null, matched_campaign_name: null,
      callback_due_at: '2026-11-09T09:00:00.000Z', has_voicemail: true, assignee_user_id: 'u-1', assignee_name: 'Asha',
      assignee_departed: false, status: 'handled', handled_reason: 'reached', handled_by_user_id: 'u-2', handled_by_name: null,
      handled_at: '2026-11-08T10:00:00.000Z', voicemail_url: '/inbound/missed/c-1/voicemail',
    });
    expect(inboundMissedToWire(row).assignee_name).toBeNull();
    // The public layer names the assignees who left; only a person can have left.
    expect(inboundMissedToWire(row, new Map(), new Set(['u-1'])).assignee_departed).toBe(true);
    expect(inboundMissedToWire({ ...row, follow_up_assignee_user_id: null }, new Map(), new Set(['u-1'])).assignee_departed).toBe(false);
    // Handled before 0028 (no reason): a person marked it. Open: no reason.
    expect(inboundMissedToWire({ ...row, handled_reason: null }).handled_reason).toBe('marked');
    expect(inboundMissedToWire({ ...row, follow_up_status: 'open', handled_reason: null, handled_at: null, handled_by_user_id: null }).handled_reason).toBeNull();
    // Why a closed row was closed (0030); none on another reason's row, whatever the column holds.
    expect(inboundMissedToWire({ ...row, follow_up_reason: 'closed', closed_cause: 'switched_off' }).closed_cause).toBe('switched_off');
    expect(inboundMissedToWire({ ...row, follow_up_reason: 'closed', closed_cause: null }).closed_cause).toBeNull();
    expect(inboundMissedToWire({ ...row, closed_cause: 'hours' }).closed_cause).toBeNull();
    // No voicemail, no `voicemail_url` (the console offers no player).
    expect(inboundMissedToWire({ ...row, voicemail_key: null })).not.toHaveProperty('voicemail_url');
  });

  it('IQ54: match_name is the matched contact`s name, null when unmatched or withheld or nameless', () => {
    const matched = { ...row, from_e164: '+447700900123', matched_contact_id: 'k-1', matched_campaign_id: 'camp-1' };
    const ctx = (o: Record<string, unknown>) => ({ name: null, full_name: null, customer_name: null, first_name: null, ...o });
    expect(inboundMissedToWire({ ...matched, match_context: ctx({ name: '  Asha Rao ' }) }).match_name).toBe('Asha Rao');
    expect(inboundMissedToWire({ ...matched, match_context: ctx({ full_name: 'R. Iyer', first_name: 'Ravi' }) }).match_name).toBe('R. Iyer');
    expect(inboundMissedToWire({ ...matched, match_context: ctx({ first_name: 'Ravi' }) }).match_name).toBe('Ravi');
    expect(inboundMissedToWire({ ...matched, match_context: ctx({ name: 'x'.repeat(150) }) }).match_name).toBe('x'.repeat(100));
    // Not text, blank, or no name column: null.
    expect(inboundMissedToWire({ ...matched, match_context: ctx({ name: 42 }) }).match_name).toBeNull();
    expect(inboundMissedToWire({ ...matched, match_context: ctx({ name: '   ' }) }).match_name).toBeNull();
    expect(inboundMissedToWire({ ...matched, match_context: ctx({}) }).match_name).toBeNull();
    // The contact row gone: null.
    expect(inboundMissedToWire({ ...matched, match_context: null }).match_name).toBeNull();
    // Unmatched, or withheld: null whatever the columns say.
    expect(inboundMissedToWire({ ...matched, matched_contact_id: null, match_context: ctx({ name: 'Asha' }) }).match_name).toBeNull();
    expect(inboundMissedToWire({ ...matched, from_e164: null, match_context: ctx({ name: 'Asha' }) }).match_name).toBeNull();
  });
});

describe('the Missed query', () => {
  it('takes the contract’s filters and refuses anything else that reaches a cast', () => {
    const ok = inboundMissedQuerySchema.parse({
      status: 'handled', assignee: '00000000-0000-4000-8000-000000000001', reason: 'closed',
      from: '2026-11-01T00:00:00Z', limit: '20', other: 'x',
    });
    expect(definedQueryString(ok)).toEqual({
      status: 'handled', assignee: '00000000-0000-4000-8000-000000000001', reason: 'closed', from: '2026-11-01T00:00:00Z', limit: '20',
    });
    for (const bad of [{ status: 'nope' }, { assignee: 'someone' }, { reason: 'voicemail' }, { from: 'yesterday' }, { limit: '0' }, { limit: '101' }]) {
      expect(inboundMissedQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(inboundMissedQuerySchema.parse({ assignee: 'me' }).assignee).toBe('me');
    expect(inboundMissedQuerySchema.parse({ assignee: 'unassigned' }).assignee).toBe('unassigned');
    expect(inboundMissedQuerySchema.parse({ assignee: 'unassigned' }).assignee).toBe('unassigned');
  });
});

describe('the Missed list`s reassign body and the summary`s query (`agency/inbound-missed-work.ts`)', () => {
  it('takes a member`s id or null for the account, and nothing else', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(inboundMissedAssignSchema.parse({ assignee_user_id: id })).toEqual({ assignee_user_id: id });
    expect(inboundMissedAssignSchema.parse({ assignee_user_id: null })).toEqual({ assignee_user_id: null });
    for (const bad of [{}, { assignee_user_id: 'someone' }, { assignee_user_id: id, note: 'x' }, { assignee_user_id: 7 }]) {
      expect(inboundMissedAssignSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('takes two instants in order, at most the contract`s span apart', () => {
    const day = 86_400_000;
    const at = (ms: number) => new Date(Date.parse('2026-11-01T00:00:00Z') + ms).toISOString();
    expect(inboundSummaryQuerySchema.safeParse({ from: at(0), to: at(day) }).success).toBe(true);
    expect(inboundSummaryQuerySchema.safeParse({ from: at(0), to: at(AGENCY_INBOUND_SUMMARY_MAX_DAYS * day) }).success).toBe(true);
    for (const bad of [
      { from: at(0), to: at(AGENCY_INBOUND_SUMMARY_MAX_DAYS * day + 1) },
      { from: at(day), to: at(0) },
      { from: at(0), to: at(0) },
      { from: 'yesterday', to: at(0) },
      { from: at(0) },
    ]) {
      expect(inboundSummaryQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('gives a rate to one decimal, and none with nothing to divide by', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(2, 3)).toBe(66.7);
    expect(pct(0, 4)).toBe(0);
    expect(pct(0, 0)).toBeNull();
  });
});

describe('the Missed count`s query and the assignee scope (IQ49, IQ50, IQ57)', () => {
  it('the count takes the list`s assignee and an ISO since; anything else that would reach a cast is refused', () => {
    expect(inboundMissedCountQuerySchema.parse({ assignee: 'unassigned', since: '2026-11-11T09:00:00Z', other: 'x' }))
      .toEqual({ assignee: 'unassigned', since: '2026-11-11T09:00:00Z' });
    expect(inboundMissedCountQuerySchema.parse({})).toEqual({});
    for (const bad of [{ assignee: 'team' }, { since: 'yesterday' }, { since: '' }]) {
      expect(inboundMissedCountQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('whose rows: `unassigned` for anyone; otherwise an agent`s own; a supervisor`s `me`, a person`s or everyone`s', () => {
    const agent = { userId: 'u-a', supervise: false };
    const sup = { userId: 'u-s', supervise: true };
    const other = '00000000-0000-4000-8000-0000000000AA';
    expect(missedAssigneeScope(agent, 'unassigned')).toBe('unassigned');
    expect(missedAssigneeScope(agent, undefined)).toEqual({ userId: 'u-a' });
    expect(missedAssigneeScope(agent, 'me')).toEqual({ userId: 'u-a' });
    expect(missedAssigneeScope(agent, other)).toEqual({ userId: 'u-a' });
    expect(missedAssigneeScope(sup, 'unassigned')).toBe('unassigned');
    expect(missedAssigneeScope(sup, 'me')).toEqual({ userId: 'u-s' });
    expect(missedAssigneeScope(sup, other)).toEqual({ userId: other.toLowerCase() });
    expect(missedAssigneeScope(sup, undefined)).toBeUndefined();
  });
});
