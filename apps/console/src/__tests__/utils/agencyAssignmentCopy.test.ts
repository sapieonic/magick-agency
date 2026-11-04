import { describe, expect, it } from 'vitest';
import {
  AGENCY_ASSIGNMENT_ERROR_CODES,
  AGENCY_ASSIGNMENT_KINDS,
  AGENCY_AGENT_RETRY_BLOCKS,
  AGENCY_AGENT_RETRY_ERROR_CODES,
  AGENCY_MY_CONTACT_BUCKETS,
} from '@magick-agency/contracts/api/agency/assignment';
import {
  AGENCY_ASSIGNMENT_MODES,
  AGENCY_ASSIGNMENT_REASONS,
  AGENCY_CALLBACK_FALLBACK_VALUES,
  AGENCY_ON_UNSTAFF_VALUES,
} from '@magick-agency/contracts/agency';
import {
  ASSIGNMENT_KIND_COPY,
  ASSIGNMENT_MODE_COPY,
  ASSIGNMENT_REASON_LABELS,
  ASSIGNMENT_REFUSAL_COPY,
  BUCKET_ROSTER_STATES,
  CALLBACK_FALLBACK_COPY,
  CONTACT_BUCKET_LABELS,
  FORMER_MEMBER_LABEL,
  ON_UNSTAFF_COPY,
  UNASSIGNED_LABEL,
  assigneeLabel,
  assignmentModeLocked,
  assignmentResultToast,
  dueWhileAbsentFlag,
  previewSentence,
  unassignedOpenWarning,
} from '../../utils/agencyAssignmentCopy';
import {
  AGENT_RETRY_REFUSAL_COPY,
  RETRY_BLOCK_COPY,
  agentRetryRefusal,
  contactCallGate,
  overrideBadge,
  showRetryNotReached,
} from '../../utils/agencyMyContactsCopy';
import { overrideNoteBlock } from '../../utils/softphone/overrides';
import { ApiError } from '../../api/client';
import type { AgencyMyContact } from '@magick-agency/contracts/api/agency/assignment';

/**
 * Every vocabulary the contract lists has copy, and nothing else does. The
 * `Record` types already fail to compile on a missing key; these hold the runtime
 * lists and the records equal both ways, so a stale key left behind fails too.
 */
describe('copy records are exhaustive over the contract', () => {
  const cases: Array<[string, readonly string[], Record<string, unknown>]> = [
    ['assignment modes', AGENCY_ASSIGNMENT_MODES, ASSIGNMENT_MODE_COPY],
    ['on unstaff', AGENCY_ON_UNSTAFF_VALUES, ON_UNSTAFF_COPY],
    ['callback fallback', AGENCY_CALLBACK_FALLBACK_VALUES, CALLBACK_FALLBACK_COPY],
    ['operation kinds', AGENCY_ASSIGNMENT_KINDS, ASSIGNMENT_KIND_COPY],
    ['history reasons', AGENCY_ASSIGNMENT_REASONS, ASSIGNMENT_REASON_LABELS],
    ['buckets', AGENCY_MY_CONTACT_BUCKETS, CONTACT_BUCKET_LABELS],
    ['bucket roster states', AGENCY_MY_CONTACT_BUCKETS, BUCKET_ROSTER_STATES],
    ['supervisor refusals', AGENCY_ASSIGNMENT_ERROR_CODES, ASSIGNMENT_REFUSAL_COPY],
    ['agent refusals', AGENCY_AGENT_RETRY_ERROR_CODES, AGENT_RETRY_REFUSAL_COPY],
    ['retry blocks', AGENCY_AGENT_RETRY_BLOCKS, RETRY_BLOCK_COPY],
  ];
  it.each(cases)('%s', (_name, values, record) => {
    expect(Object.keys(record).sort()).toEqual([...values].sort());
    for (const value of values) expect(record[value]).toBeTruthy();
  });

  it('never says a wire token to an agent', () => {
    for (const copy of Object.values(AGENT_RETRY_REFUSAL_COPY)) expect(copy).not.toMatch(/_/);
  });
});

describe('assignment mode lock', () => {
  it('locks the mode except on a draft or paused campaign (and a builder before its first save)', () => {
    expect(assignmentModeLocked('draft')).toBe(false);
    expect(assignmentModeLocked('paused')).toBe(false);
    expect(assignmentModeLocked(undefined)).toBe(false);
    for (const status of ['running', 'stopping', 'completed']) expect(assignmentModeLocked(status)).toBe(true);
  });
});

describe('who owns a contact', () => {
  const names = new Map([['a1', 'Asha']]);
  it('names a staffed agent, the pool and a former member', () => {
    expect(assigneeLabel('a1', names)).toBe('Asha');
    expect(assigneeLabel(null, names)).toBe(UNASSIGNED_LABEL);
    expect(assigneeLabel('gone', names)).toBe(FORMER_MEMBER_LABEL);
  });
});

describe('preview and result copy', () => {
  const base = {
    kind: 'reassign' as const, preview_token: 't', seed: null, matched: 12, moving: 9, skipped_live: 2,
    unchanged: 1, to_pool: 0, per_agent: [], same_number_groups: 0,
  };
  it('says what moves and what will not', () => {
    expect(previewSentence(base)).toBe('9 of 12 contacts will move. 1 already with that agent. 2 on a call — won’t move.');
    expect(previewSentence({ ...base, matched: 0, moving: 0, skipped_live: 0, unchanged: 0 }))
      .toBe('No contacts match. Nothing will change.');
  });
  it('toasts a commit, naming live contacts that stayed', () => {
    expect(assignmentResultToast({
      kind: 'range', batch_id: 'b', moved: 3, skipped_live: 1, unchanged: 0, to_pool: 0, per_agent: [],
    })).toBe('Moved 3 contacts. 1 on a call didn’t move.');
    expect(assignmentResultToast({
      kind: 'unassign', batch_id: 'b', moved: 1, skipped_live: 0, unchanged: 0, to_pool: 1, per_agent: [],
    })).toBe('Returned 1 contact to the pool.');
  });
  it('words the strict-mode banner and the absence flag', () => {
    expect(unassignedOpenWarning(1)).toBe('1 open contact is unassigned and will not be dialled.');
    expect(unassignedOpenWarning(40)).toBe('40 open contacts are unassigned and will not be dialled.');
    expect(dueWhileAbsentFlag(6, 15)).toBe('6 due — agent away > 15 min');
  });
});

describe('agent refusals', () => {
  it('words a code, and fills in the reopening time and the block', () => {
    const hours = new ApiError(409, {
      error: 'Conflict', code: 'outside_calling_hours', message: 'closed',
      details: { next_open_at: '2026-11-04T03:30:00.000Z' },
    });
    expect(agentRetryRefusal(hours, 'x')).toMatch(/^The campaign is outside its calling hours\. It opens again /);
    const cooldown = new ApiError(409, {
      error: 'Conflict', code: 'contact_not_retryable', message: 'no',
      details: { blocked: 'cooldown', available_at: '2026-11-03T10:00:00.000Z' },
    });
    expect(agentRetryRefusal(cooldown, 'x')).toContain(RETRY_BLOCK_COPY.cooldown);
    expect(agentRetryRefusal(new ApiError(409, { code: 'dnc_listed' }), 'x')).toBe(AGENT_RETRY_REFUSAL_COPY.dnc_listed);
  });
  it('falls back to the server’s sentence for a code this build does not know', () => {
    expect(agentRetryRefusal(new ApiError(409, { code: 'brand_new', message: 'Server words' }), 'x'))
      .toBe('Server words');
  });
});

const CONTACT: AgencyMyContact = {
  id: 'c1', campaign_id: 'camp-1', phone_e164: '+919800000001', bucket: 'pending', state: 'pending',
  attempt_count: 0, last_outcome: null, last_disposition: null,
  next_attempt_at: '2026-11-03T10:00:00.000Z', last_attempt_at: null, hero: [],
  retry: { eligible: false, blocked: 'not_retryable', rounds_used: 0, available_at: null },
  override: null,
};
const NOW = Date.parse('2026-11-03T10:05:00.000Z');
const STATION = { sessionId: 's1', agentState: 'available' as const, dialing: true };

describe('contactCallGate', () => {
  it('allows a contact due now, a retry-eligible one, and one holding a call-early override', () => {
    expect(contactCallGate(CONTACT, STATION, NOW)).toEqual({ ok: true });
    const later = { ...CONTACT, next_attempt_at: '2026-11-03T12:00:00.000Z' };
    expect(contactCallGate(later, STATION, NOW).ok).toBe(false);
    expect(contactCallGate({
      ...later,
      override: { disposition: 'ptp', extra_attempts: 0, retry_delay: true, calling_hours: false, granted_at: '' },
    }, STATION, NOW)).toEqual({ ok: true });
    expect(contactCallGate({
      ...CONTACT, bucket: 'not_reached', state: 'exhausted',
      retry: { eligible: true, blocked: null, rounds_used: 0, available_at: null },
    }, STATION, NOW)).toEqual({ ok: true });
  });

  it('refuses with the reason when the station cannot dial or the contact cannot be called', () => {
    expect(contactCallGate(CONTACT, { ...STATION, agentState: 'break' }, NOW))
      .toEqual({ ok: false, reason: 'Go available to call a contact.' });
    expect(contactCallGate(CONTACT, { ...STATION, sessionId: null }, NOW).ok).toBe(false);
    expect(contactCallGate(CONTACT, { ...STATION, dialing: false }, NOW).ok).toBe(false);
    expect(contactCallGate({ ...CONTACT, bucket: 'suppressed', state: 'suppressed' }, STATION, NOW))
      .toEqual({ ok: false, reason: RETRY_BLOCK_COPY.suppressed });
    const cooling = {
      ...CONTACT, bucket: 'not_reached' as const, state: 'exhausted' as const,
      retry: { eligible: false, blocked: 'cooldown' as const, rounds_used: 0, available_at: '2026-11-03T11:00:00.000Z' },
    };
    const gate = contactCallGate(cooling, STATION, NOW);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain(RETRY_BLOCK_COPY.cooldown);
  });
});

describe('overrides and retry offer', () => {
  it('badges an unspent override and nothing else', () => {
    expect(overrideBadge(null)).toBeNull();
    expect(overrideBadge({ disposition: 'p', extra_attempts: 2, retry_delay: false, calling_hours: true, granted_at: '' }))
      .toBe('Override: 2 extra attempts, may call outside hours');
    expect(overrideBadge({ disposition: 'p', extra_attempts: 0, retry_delay: false, calling_hours: false, granted_at: '' }))
      .toBeNull();
  });

  it('holds the calling-hours note to 10–500 characters, trimmed', () => {
    // The soft phone's note check: the my-contacts note shares its bounds.
    expect(overrideNoteBlock('   short   ')).toBe('too_short');
    expect(overrideNoteBlock('Customer asked for 9pm')).toBeNull();
    expect(overrideNoteBlock('x'.repeat(501))).toBe('too_long');
  });

  it('offers "Retry not reached" only when allowed, nothing is due and something is eligible', () => {
    expect(showRetryNotReached({ due_now: 0, retry: { allowed: true, eligible: 3 } })).toBe(true);
    expect(showRetryNotReached({ due_now: 1, retry: { allowed: true, eligible: 3 } })).toBe(false);
    expect(showRetryNotReached({ due_now: 0, retry: { allowed: true, eligible: 0 } })).toBe(false);
    expect(showRetryNotReached({ due_now: 0, retry: { allowed: false, eligible: 3 } })).toBe(false);
  });
});
