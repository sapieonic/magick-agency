/**
 * Contact assignment: a supervisor assigns roster contacts to agents, and pacing reads the owner
 * per the campaign's `assignment_mode` (migration 0009). The campaign settings' vocabularies and
 * defaults live here; the supervisor's operations, the agent's own contact list and agent-led
 * retry are console wire types (`../api/agency/assignment.ts`); the agent's queue frame is in
 * `./station.ts`.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the contract's header.
 */

import type { AllListed } from '../primitives';

/**
 * How pacing pairs a campaign's contacts with agents.
 *
 *  - `pool`: one shared queue; the owner is ignored (the default, and every campaign before 0009).
 *  - `strict`: an agent is dialled only the contacts assigned to them. Unassigned contacts are
 *    never dialled, and while any is still open the campaign does not complete.
 *  - `preferred`: an agent is dialled their own due contacts first, then unassigned ones; never
 *    another agent's.
 *
 * Set at creation; changed only while the campaign is `draft` or `paused` (audited).
 */
export type AgencyAssignmentMode = 'pool' | 'strict' | 'preferred';
export const AGENCY_ASSIGNMENT_MODES = ['pool', 'strict', 'preferred'] as const;

/** When an agent is unstaffed from a campaign: their open contacts go back to the pool, or stay theirs. */
export type AgencyOnUnstaff = 'return_to_pool' | 'keep';
export const AGENCY_ON_UNSTAFF_VALUES = ['return_to_pool', 'keep'] as const;

/**
 * A due callback whose owner is not live on the campaign waits `callback_owner_grace_minutes`;
 * then `pool` hands it to the pool (it loses its owner) and `wait` keeps waiting for the owner.
 */
export type AgencyCallbackFallback = 'pool' | 'wait';
export const AGENCY_CALLBACK_FALLBACK_VALUES = ['pool', 'wait'] as const;

/** Why a contact changed owner (`agency_contact_assignment_events.reason`). */
export type AgencyAssignmentReason =
  | 'manual'
  | 'random_split'
  | 'count'
  | 'filter'
  | 'range'
  | 'rebalance'
  | 'unstaffed'
  | 'reassign'
  | 'unassign'
  /** An agent's callback on a contact they took from the pool stays with them. */
  | 'callback'
  /** A due callback whose owner stayed away past the grace went to the pool. */
  | 'callback_fallback'
  | 'superseded'
  /** A retry campaign kept its parent's assignment. */
  | 'inherited';
export const AGENCY_ASSIGNMENT_REASONS = [
  'manual',
  'random_split',
  'count',
  'filter',
  'range',
  'rebalance',
  'unstaffed',
  'reassign',
  'unassign',
  'callback',
  'callback_fallback',
  'superseded',
  'inherited',
] as const;

/** The 0009 column defaults: a campaign that says nothing behaves as before. */
export const AGENCY_CONTACT_ASSIGNMENT_DEFAULTS = Object.freeze({
  assignment_mode: 'pool',
  on_unstaff: 'return_to_pool',
  callback_owner_grace_minutes: 30,
  callback_fallback: 'pool',
  allow_agent_retry: false,
  agent_retry_rounds: 1,
  agent_retry_cooldown_minutes: 30,
} as const);

/** Bounds the database enforces (0009 CHECKs), for both validators and the console form. */
export const AGENCY_CALLBACK_GRACE_MINUTES_MAX = 10080;
export const AGENCY_AGENT_RETRY_ROUNDS_MIN = 1;
export const AGENCY_AGENT_RETRY_ROUNDS_MAX = 10;
export const AGENCY_AGENT_RETRY_COOLDOWN_MINUTES_MAX = 10080;

const _modesListed: AllListed<AgencyAssignmentMode, typeof AGENCY_ASSIGNMENT_MODES> = true;
const _unstaffListed: AllListed<AgencyOnUnstaff, typeof AGENCY_ON_UNSTAFF_VALUES> = true;
const _fallbackListed: AllListed<AgencyCallbackFallback, typeof AGENCY_CALLBACK_FALLBACK_VALUES> = true;
const _reasonsListed: AllListed<AgencyAssignmentReason, typeof AGENCY_ASSIGNMENT_REASONS> = true;
void [_modesListed, _unstaffListed, _fallbackListed, _reasonsListed];
