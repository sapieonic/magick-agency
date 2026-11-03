import type {
  AgencyAssignmentErrorCode,
  AgencyAssignmentKind,
  AgencyAssignmentMode,
  AgencyAssignmentPreview,
  AgencyAssignmentReason,
  AgencyAssignmentResult,
  AgencyCallbackFallback,
  AgencyMyContactBucket,
  AgencyOnUnstaff,
} from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyCampaignStatus } from '../types/agency-campaign';
import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';
import { formatCount } from './format/number';

/**
 * The words for contact assignment on the supervisor's side: the campaign
 * settings, the roster's assignment tools and the per-agent progress.
 *
 * Every vocabulary from the contract is a `Record` over its whole union, so a
 * value added to the contract without copy fails the type check instead of
 * reaching a supervisor as a wire token. The agent's side (refusals of their own
 * contact routes) is `agencyMyContactsCopy.ts`.
 */

/**
 * The flag that gates the whole surface (settings, roster tools, progress, My
 * contacts, agent retry). Typed against the contract so a renamed flag fails to
 * compile; read through `useFeatureFlagEnabled`, which fails closed.
 */
export const CONTACT_ASSIGNMENT_FLAG: ClientExposedAgencyFlagKey = 'agency_contact_assignment_enabled';

// ─── Campaign settings ──────────────────────────────────────────────────────

export const ASSIGNMENT_MODE_COPY: Record<AgencyAssignmentMode, { label: string; explain: string }> = {
  pool: {
    label: 'Shared pool',
    explain: 'Every agent dials from one queue. Who a contact is assigned to is ignored.',
  },
  strict: {
    label: 'Own contacts only',
    explain:
      'Agents are dialled only the contacts assigned to them. Unassigned contacts are never dialled.',
  },
  preferred: {
    label: 'Own contacts first',
    explain:
      'Agents are dialled their own due contacts first, then unassigned ones — never another agent’s.',
  },
};

export const ON_UNSTAFF_COPY: Record<AgencyOnUnstaff, string> = {
  return_to_pool: 'Return their open contacts to the pool',
  keep: 'Keep their contacts assigned to them',
};

export const CALLBACK_FALLBACK_COPY: Record<AgencyCallbackFallback, string> = {
  pool: 'Hand the callback to the pool',
  wait: 'Keep waiting for its agent',
};

/**
 * `assignment_mode` changes only while the campaign is `draft` or `paused` (the
 * server refuses `409 mode_change_requires_pause` otherwise). Every other status
 * locks the control, with the reason beside it.
 */
export const MODE_EDITABLE_STATUSES: ReadonlySet<string> = new Set<AgencyCampaignStatus>([
  'draft',
  'paused',
]);

/** `status` is the campaign row's, a plain string on the console's wire type. */
export function assignmentModeLocked(status: string | null | undefined): boolean {
  // A campaign not created yet (the builder before its first save) is a draft.
  if (!status) return false;
  return !MODE_EDITABLE_STATUSES.has(status);
}

export const MODE_LOCKED_HINT = 'Pause the campaign to change how contacts are assigned.';

// ─── Buckets (one definition on the server; these are its names) ───────────

export const CONTACT_BUCKET_LABELS: Record<AgencyMyContactBucket, string> = {
  pending: 'Not called yet',
  callback: 'Callback booked',
  not_reached: 'Not reached',
  in_progress: 'On a call',
  reached: 'Reached',
  exhausted: 'Out of attempts',
  suppressed: 'Do not call / suppressed',
};

/**
 * The roster `state` a bucket count links to. Several buckets share a state
 * (`pending` holds new, callback and not-reached contacts), so the link narrows
 * to the state and the owner; the count beside it is the exact number.
 */
export const BUCKET_ROSTER_STATES: Record<AgencyMyContactBucket, readonly string[]> = {
  pending: ['pending'],
  callback: ['pending'],
  not_reached: ['pending'],
  in_progress: ['in_flight', 'connected'],
  reached: ['completed'],
  exhausted: ['exhausted'],
  suppressed: ['suppressed'],
};

// ─── Operations ─────────────────────────────────────────────────────────────

export const ASSIGNMENT_KIND_COPY: Record<AgencyAssignmentKind, { label: string; explain: string }> = {
  random_split: {
    label: 'Split at random',
    explain: 'Share the unassigned contacts evenly, at random, across the agents you pick.',
  },
  count: {
    label: 'Next N to an agent',
    explain: 'Give the next unassigned contacts, in upload order, to one agent.',
  },
  filter: {
    label: 'By filter',
    explain: 'Give the contacts matching a state, an outcome or a column value to one or several agents.',
  },
  range: {
    label: 'Selected rows',
    explain: 'Give the rows you ticked to one agent.',
  },
  reassign: {
    label: 'Reassign',
    explain: 'Move one agent’s open contacts to another agent.',
  },
  unassign: {
    label: 'Unassign',
    explain: 'Return contacts to the pool.',
  },
  rebalance: {
    label: 'Rebalance',
    explain:
      'Even out the backlog: never-called contacts move from the busiest agents to the quietest. Callbacks and contacts already called stay put.',
  },
};

export const ASSIGNMENT_REASON_LABELS: Record<AgencyAssignmentReason, string> = {
  manual: 'Assigned by hand',
  random_split: 'Random split',
  count: 'Next N',
  filter: 'By filter',
  range: 'Selected rows',
  rebalance: 'Rebalance',
  unstaffed: 'Agent taken off the campaign',
  reassign: 'Reassigned',
  unassign: 'Unassigned',
  callback: 'Kept for the agent’s callback',
  callback_fallback: 'Callback handed to the pool',
  superseded: 'Roster replaced',
  inherited: 'Kept from the original campaign',
};

/** Refusals of the supervisor's assignment routes, in the console's words. */
export const ASSIGNMENT_REFUSAL_COPY: Record<AgencyAssignmentErrorCode, string> = {
  assignment_disabled: 'Contact assignment is turned off for this account.',
  assignment_invalid: 'That assignment isn’t complete. Check the agents and the numbers you entered.',
  agent_not_staffed:
    'One of the agents you picked is no longer on this campaign. Refresh and pick again.',
  preview_stale:
    'The roster changed since you looked. Here is the up-to-date result — check it and confirm again.',
  mode_change_requires_pause: 'Pause the campaign before you change how contacts are assigned.',
  contact_not_found: 'That contact is no longer on this campaign.',
  campaign_not_found: 'This campaign no longer exists, or isn’t in this account.',
};

/** Who a contact belongs to, for the roster's "Assigned to" column. */
export const UNASSIGNED_LABEL = 'Unassigned';
export const FORMER_MEMBER_LABEL = 'Former member';

export function assigneeLabel(
  userId: string | null,
  names: ReadonlyMap<string, string>,
): string {
  if (userId === null) return UNASSIGNED_LABEL;
  return names.get(userId) ?? FORMER_MEMBER_LABEL;
}

/**
 * The preview, in one sentence above the numbers: what will move and what will
 * not. Live contacts are named separately because they are the ones a
 * supervisor would otherwise expect to have moved.
 */
export function previewSentence(preview: AgencyAssignmentPreview): string {
  if (preview.matched === 0) return 'No contacts match. Nothing will change.';
  const parts: string[] = [];
  const s = (n: number) => (n === 1 ? '' : 's');
  parts.push(
    preview.moving === 0
      ? `${formatCount(preview.matched)} contact${s(preview.matched)} matched, and none will move.`
      : `${formatCount(preview.moving)} of ${formatCount(preview.matched)} contact${s(preview.matched)} will move.`,
  );
  if (preview.to_pool > 0) {
    parts.push(`${formatCount(preview.to_pool)} go${preview.to_pool === 1 ? 'es' : ''} back to the pool.`);
  }
  if (preview.unchanged > 0) {
    parts.push(`${formatCount(preview.unchanged)} already with that agent.`);
  }
  if (preview.skipped_live > 0) {
    parts.push(`${formatCount(preview.skipped_live)} on a call — won’t move.`);
  }
  return parts.join(' ');
}

/** The toast after a commit: what moved, and what did not. */
export function assignmentResultToast(result: AgencyAssignmentResult): string {
  const s = (n: number) => (n === 1 ? '' : 's');
  const parts = [
    result.to_pool > 0 && result.moved === result.to_pool
      ? `Returned ${formatCount(result.moved)} contact${s(result.moved)} to the pool.`
      : `Moved ${formatCount(result.moved)} contact${s(result.moved)}.`,
  ];
  if (result.skipped_live > 0) {
    parts.push(`${formatCount(result.skipped_live)} on a call didn’t move.`);
  }
  return parts.join(' ');
}

/** Strict mode: open contacts nobody owns, which are never dialled. */
export function unassignedOpenWarning(count: number): string {
  return `${formatCount(count)} open contact${count === 1 ? ' is' : 's are'} unassigned and will not be dialled.`;
}

/** An agent away while their contacts fall due. */
export function dueWhileAbsentFlag(count: number, minutes: number): string {
  return `${formatCount(count)} due — agent away > ${minutes} min`;
}
