import type { AgencyManualCall, AgencyManualCallListQuery } from '../../types/softphone';

/**
 * The soft-phone list's stats strip, counted over the rows on screen.
 *
 * There is no aggregate route for manual calls (`docs/softphone.md` §6 lists the
 * keyset list and the detail only), so the strip says what it counts — "the N
 * calls listed below" — and grows as older pages load. A number that silently
 * described one page while reading like a total would be the worse product.
 */
export interface SoftphoneCallStats {
  calls: number;
  connected: number;
  /** Mean talk time over calls that connected and carry a duration; null when none do. */
  avgTalkSeconds: number | null;
  notLogged: number;
  awaitingOutcome: number;
}

export function summariseCalls(rows: readonly AgencyManualCall[]): SoftphoneCallStats {
  let connected = 0;
  let talkTotal = 0;
  let talkCount = 0;
  let notLogged = 0;
  let awaitingOutcome = 0;
  for (const row of rows) {
    if (row.outcome === 'connected' || row.bridged_at !== null) connected += 1;
    if (row.talk_seconds !== null && row.talk_seconds > 0) {
      talkTotal += row.talk_seconds;
      talkCount += 1;
    }
    if (row.tag === null) notLogged += 1;
    if (row.settled_at === null && row.state === 'ended' && row.requires_disposition) awaitingOutcome += 1;
  }
  return {
    calls: rows.length,
    connected,
    avgTalkSeconds: talkCount > 0 ? Math.round(talkTotal / talkCount) : null,
    notLogged,
    awaitingOutcome,
  };
}

/** The filter form, as the agent or supervisor drafts it. */
export interface SoftphoneCallsDraft {
  from: string;
  to: string;
  agentUserId: string;
  /** `''` any, `untagged` not logged, else a campaign id. */
  campaignId: string;
  outcome: string;
  phone: string;
  /** `''` any, else the server's `status`: `live`, `awaiting_outcome`, `settled`. */
  status: '' | NonNullable<AgencyManualCallListQuery['status']>;
}

export const EMPTY_SOFTPHONE_CALLS_DRAFT: SoftphoneCallsDraft = {
  from: '',
  to: '',
  agentUserId: '',
  campaignId: '',
  outcome: '',
  phone: '',
  status: '',
};

/** The Status filter's choices, in the words of the stats strip. */
export const SOFTPHONE_CALL_STATUS_OPTIONS: ReadonlyArray<{ value: NonNullable<AgencyManualCallListQuery['status']>; label: string }> = [
  { value: 'live', label: 'On a call now' },
  { value: 'awaiting_outcome', label: 'Waiting for an outcome' },
  { value: 'settled', label: 'Done' },
];

/**
 * Draft → query. Dates are the reader's calendar days, inclusive of the "to" day
 * (`to` is exclusive on the wire, so it is the next midnight), and the number
 * search sends digits only — the server matches digits against the E.164.
 */
export function queryFromDraft(
  draft: SoftphoneCallsDraft,
  fixed: { campaignId?: string; agentUserId?: string } = {},
): AgencyManualCallListQuery {
  const query: AgencyManualCallListQuery = {};
  if (draft.from) query.from = new Date(`${draft.from}T00:00:00`).toISOString();
  if (draft.to) {
    const end = new Date(`${draft.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    query.to = end.toISOString();
  }
  const agent = fixed.agentUserId ?? draft.agentUserId;
  if (agent) query.agent_user_id = agent;
  const campaign = fixed.campaignId ?? draft.campaignId;
  if (campaign) query.campaign_id = campaign;
  if (draft.outcome) query.outcome = draft.outcome as AgencyManualCallListQuery['outcome'];
  if (draft.status) query.status = draft.status;
  const digits = draft.phone.replace(/[^\d]/g, '');
  if (digits) query.phone = digits;
  return query;
}

/** How many independent filter groups are applied — for the filter card's badge. */
export function activeFilterCount(draft: SoftphoneCallsDraft, fixedCampaign: boolean, fixedAgent: boolean): number {
  let n = 0;
  if (draft.from || draft.to) n += 1;
  if (!fixedAgent && draft.agentUserId) n += 1;
  if (!fixedCampaign && draft.campaignId) n += 1;
  if (draft.outcome) n += 1;
  if (draft.status) n += 1;
  if (draft.phone.replace(/[^\d]/g, '')) n += 1;
  return n;
}

/** `YYYY-MM-DD` for today on the reader's calendar — the "Today" preset. */
export function todayLocal(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
