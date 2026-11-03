import {
  AGENCY_ASSIGNMENT_RANGE_MAX,
  type AgencyAssignmentContactFilter,
  type AgencyAssignmentKind,
  type AgencyAssignmentOperation,
  type AgencyAssignmentPreview,
} from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyContactState } from '@magick-agency/contracts/agency';
import { errorCode } from './agencyErrors';
import { rosterFiltersToParams } from './agencyRosterFilters';

/**
 * The roster's assignment tools, as pure functions: the form a supervisor fills
 * in for each operation, the operation it becomes on the wire, and the row
 * selection (shift-click ranges, "select page") the "Selected rows" and
 * "Unassign selected" operations send.
 *
 * Every operation is set-based on the server; the client names a rule, and only
 * the two selection-based ones carry ids (at most {@link AGENCY_ASSIGNMENT_RANGE_MAX}).
 */

/** How "Unassign" picks its contacts: one agent's open contacts, or the ticked rows. */
export type UnassignSource = 'agent' | 'selected';

/** The dialog's form, one shape for every kind (each kind reads its own fields). */
export interface AssignmentDraft {
  kind: AgencyAssignmentKind;
  /** `random_split`, `filter`, `rebalance`: the agents receiving contacts. */
  agentIds: string[];
  /** `count`, `range`, and `reassign`'s target. */
  agentId: string;
  /** `reassign`, and `unassign` by agent: whose contacts move. */
  fromId: string;
  /** `count` (required), `reassign` / `unassign` (optional; blank = all), as typed. */
  count: string;
  unassignSource: UnassignSource;
  /** `random_split`, `filter`: only contacts in the pool (the server's default). */
  onlyUnassigned: boolean;
  filterStates: string[];
  filterDispositions: string[];
  columnName: string;
  /** One value per line, or comma-separated, as typed. */
  columnValues: string;
  /** Keep contacts sharing a number with one agent (default on). */
  groupSameNumber: boolean;
}

export function emptyDraft(kind: AgencyAssignmentKind, prefill: Partial<AssignmentDraft> = {}): AssignmentDraft {
  return {
    kind,
    agentIds: [],
    agentId: '',
    fromId: '',
    count: '',
    unassignSource: 'agent',
    onlyUnassigned: true,
    filterStates: [],
    filterDispositions: [],
    columnName: '',
    columnValues: '',
    groupSameNumber: true,
    ...prefill,
  };
}

export type BuiltOperation =
  | { ok: true; operation: AgencyAssignmentOperation }
  | { ok: false; reason: string };

/** A whole number ≥ 1 typed in a box, or null. */
function positiveCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** `North, East` or one per line → `['North', 'East']`, trimmed, blanks and repeats dropped. */
export function splitValues(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]/)) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/**
 * The form → the wire operation, or the reason it is not complete yet (shown
 * beside the disabled Preview button, never as an error after a round trip).
 * `selectedIds` is the roster's ticked rows, for `range` and `unassign` by rows.
 */
export function buildOperation(draft: AssignmentDraft, selectedIds: readonly string[]): BuiltOperation {
  const group = { group_same_number: draft.groupSameNumber };
  switch (draft.kind) {
    case 'random_split':
      if (draft.agentIds.length === 0) return { ok: false, reason: 'Pick at least one agent.' };
      return {
        ok: true,
        operation: {
          kind: 'random_split',
          agent_user_ids: [...draft.agentIds],
          only_unassigned: draft.onlyUnassigned,
          ...group,
        },
      };
    case 'count': {
      if (!draft.agentId) return { ok: false, reason: 'Pick the agent.' };
      const count = positiveCount(draft.count);
      if (count === null) return { ok: false, reason: 'Enter how many contacts, a whole number from 1.' };
      return { ok: true, operation: { kind: 'count', agent_user_id: draft.agentId, count, ...group } };
    }
    case 'filter': {
      if (draft.agentIds.length === 0) return { ok: false, reason: 'Pick at least one agent.' };
      const filter: AgencyAssignmentContactFilter = {};
      if (draft.filterStates.length > 0) filter.states = draft.filterStates as AgencyContactState[];
      if (draft.filterDispositions.length > 0) filter.last_dispositions = [...draft.filterDispositions];
      const columnName = draft.columnName.trim();
      const columnValues = splitValues(draft.columnValues);
      if (columnName || columnValues.length > 0) {
        if (!columnName) return { ok: false, reason: 'Name the column the values are in.' };
        if (columnValues.length === 0) return { ok: false, reason: `Enter at least one value for ${columnName}.` };
        filter.column = { name: columnName, values: columnValues };
      }
      if (Object.keys(filter).length === 0) {
        return { ok: false, reason: 'Pick a state, a last outcome or a column to select on.' };
      }
      return {
        ok: true,
        operation: {
          kind: 'filter',
          agent_user_ids: [...draft.agentIds],
          filter,
          only_unassigned: draft.onlyUnassigned,
          ...group,
        },
      };
    }
    case 'range':
      if (!draft.agentId) return { ok: false, reason: 'Pick the agent.' };
      if (selectedIds.length === 0) return { ok: false, reason: 'Tick the rows to assign first.' };
      if (selectedIds.length > AGENCY_ASSIGNMENT_RANGE_MAX) {
        return { ok: false, reason: `Select at most ${AGENCY_ASSIGNMENT_RANGE_MAX} rows at a time.` };
      }
      return {
        ok: true,
        operation: { kind: 'range', agent_user_id: draft.agentId, contact_ids: [...selectedIds], ...group },
      };
    case 'reassign': {
      if (!draft.fromId) return { ok: false, reason: 'Pick whose contacts to move.' };
      if (!draft.agentId) return { ok: false, reason: 'Pick who receives them.' };
      if (draft.fromId === draft.agentId) return { ok: false, reason: 'Pick two different agents.' };
      const count = draft.count.trim() ? positiveCount(draft.count) : undefined;
      if (count === null) return { ok: false, reason: 'Enter a whole number from 1, or leave it blank for all.' };
      return {
        ok: true,
        operation: {
          kind: 'reassign',
          from_user_id: draft.fromId,
          to_user_id: draft.agentId,
          ...(count !== undefined ? { count } : {}),
          ...group,
        },
      };
    }
    case 'unassign': {
      if (draft.unassignSource === 'selected') {
        if (selectedIds.length === 0) return { ok: false, reason: 'Tick the rows to unassign first.' };
        if (selectedIds.length > AGENCY_ASSIGNMENT_RANGE_MAX) {
          return { ok: false, reason: `Select at most ${AGENCY_ASSIGNMENT_RANGE_MAX} rows at a time.` };
        }
        return { ok: true, operation: { kind: 'unassign', contact_ids: [...selectedIds], ...group } };
      }
      if (!draft.fromId) return { ok: false, reason: 'Pick whose contacts go back to the pool.' };
      const count = draft.count.trim() ? positiveCount(draft.count) : undefined;
      if (count === null) return { ok: false, reason: 'Enter a whole number from 1, or leave it blank for all.' };
      return {
        ok: true,
        operation: {
          kind: 'unassign',
          from_user_id: draft.fromId,
          ...(count !== undefined ? { count } : {}),
          ...group,
        },
      };
    }
    case 'rebalance':
      if (draft.agentIds.length < 2) return { ok: false, reason: 'Pick at least two agents to balance between.' };
      return { ok: true, operation: { kind: 'rebalance', agent_user_ids: [...draft.agentIds], ...group } };
  }
}

/**
 * The operation to COMMIT for a preview: the same operation with the seed the
 * preview used, so a random split commits exactly the split that was shown.
 */
export function withPreviewSeed(
  operation: AgencyAssignmentOperation,
  preview: AgencyAssignmentPreview,
): AgencyAssignmentOperation {
  if ((operation.kind === 'random_split' || operation.kind === 'filter') && preview.seed !== null) {
    return { ...operation, seed: preview.seed };
  }
  return operation;
}

/**
 * The fresh preview off a `409 preview_stale` refusal (`AgencyAssignmentStaleRefusal`),
 * or `null` for any other failure. Read off `ApiError.details`, the body.
 */
export function stalePreviewOf(err: unknown): AgencyAssignmentPreview | null {
  if (errorCode(err) !== 'preview_stale') return null;
  const body = (err as { details?: unknown }).details;
  const preview = body && typeof body === 'object' ? (body as { preview?: unknown }).preview : null;
  if (!preview || typeof preview !== 'object') return null;
  return typeof (preview as { preview_token?: unknown }).preview_token === 'string'
    ? (preview as AgencyAssignmentPreview)
    : null;
}

/** The agents an operation names as targets (for analytics: a count, never ids). */
export function operationAgentCount(operation: AgencyAssignmentOperation): number {
  switch (operation.kind) {
    case 'random_split':
    case 'filter':
    case 'rebalance':
      return operation.agent_user_ids.length;
    case 'count':
    case 'range':
      return 1;
    case 'reassign':
      return 1;
    case 'unassign':
      return 0;
  }
}

/**
 * The roster narrowed to one owner (an agent id, or `unassigned` for the pool)
 * and optionally some contact states: where a progress count links to. Built
 * with the roster's own URL encoder, so the link is exactly what its filter
 * panel would write.
 */
export function rosterLinkFor(
  campaignId: string,
  owner: string,
  states: readonly string[] = [],
): string {
  const params = rosterFiltersToParams({
    ...(states.length > 0 ? { state: [...states] } : {}),
    assigned_to: [owner],
  });
  return `/agency/campaigns/${campaignId}/contacts?${params.toString()}`;
}

// ─── Row selection ──────────────────────────────────────────────────────────

export interface RowSelection {
  selected: ReadonlySet<string>;
  /** The last row clicked without shift: the other end of a shift-click range. */
  anchor: string | null;
}

export const EMPTY_SELECTION: RowSelection = { selected: new Set(), anchor: null };

/**
 * One checkbox click. Without shift it toggles the row and moves the anchor.
 * With shift and an anchor on screen, every row between the anchor and this one
 * (inclusive) takes this row's new value — the spreadsheet gesture. Additions
 * stop at `cap`, so a range can never select more than one operation can send.
 */
export function toggleRow(
  selection: RowSelection,
  rowIds: readonly string[],
  id: string,
  checked: boolean,
  shift: boolean,
  cap: number = AGENCY_ASSIGNMENT_RANGE_MAX,
): RowSelection {
  const next = new Set(selection.selected);
  const from = selection.anchor !== null ? rowIds.indexOf(selection.anchor) : -1;
  const to = rowIds.indexOf(id);
  if (to === -1) return selection;
  const ids = shift && from !== -1
    ? rowIds.slice(Math.min(from, to), Math.max(from, to) + 1)
    : [id];
  for (const rowId of ids) {
    if (!checked) next.delete(rowId);
    else if (next.size < cap) next.add(rowId);
  }
  return { selected: next, anchor: shift && from !== -1 ? selection.anchor : id };
}

/** "Select page": every loaded row, up to `cap`; pressed again with all of them ticked, none. */
export function togglePage(
  selection: RowSelection,
  rowIds: readonly string[],
  cap: number = AGENCY_ASSIGNMENT_RANGE_MAX,
): RowSelection {
  const reachable = rowIds.slice(0, cap);
  const allTicked = reachable.length > 0 && reachable.every((id) => selection.selected.has(id));
  if (allTicked) return EMPTY_SELECTION;
  return { selected: new Set(reachable), anchor: null };
}

/** The ticked rows in on-screen order (the order a `range` sends). */
export function selectedInOrder(selection: RowSelection, rowIds: readonly string[]): string[] {
  return rowIds.filter((id) => selection.selected.has(id));
}
