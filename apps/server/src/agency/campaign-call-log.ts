/**
 * The campaign's call log as one list: its dialler attempts and the soft-phone calls tagged to
 * it, newest first on one keyset (decision SR6). What the campaign call export
 * (`GET /proxy/agency/campaigns/:id/attempts.csv`) drains, through the internal
 * `GET /agency-campaigns/:id/call-log`.
 *
 * Every row says where it came from (`source`, wire-style values). A soft-phone row carries
 * the attempt row's field names, each mapped to the manual call's own column, and NULL where
 * the soft phone has no such thing (an attempt number, a wrap-up allotment, a redial link, the
 * campaign's automatic outcome, a reserved session). Untagged soft-phone calls belong to no
 * campaign and are never in it (SR4).
 *
 * A LEAF module: types and constants. No fastify, no db.
 */
import type {
  AgencyAttemptRow,
  AgencyManualCallOutcome,
  AgencyManualCallState,
} from '@magick-agency/contracts/agency';

/** Where a call-log row came from: the campaign's dialler, or an agent's soft phone. */
export type CampaignCallSource = 'dialler' | 'soft_phone';

/** Every {@link CampaignCallSource}, in the order a reader meets them. */
export const CAMPAIGN_CALL_SOURCES = ['dialler', 'soft_phone'] as const satisfies readonly CampaignCallSource[];

export function isCampaignCallSource(value: unknown): value is CampaignCallSource {
  return typeof value === 'string' && (CAMPAIGN_CALL_SOURCES as readonly string[]).includes(value);
}

/** A dialler row: the attempt list's own row, marked. */
export type CampaignDiallerLogRow = AgencyAttemptRow & { source: 'dialler' };

/**
 * A soft-phone call tagged to the campaign, in the attempt row's shape. `id` is the manual
 * call's id (`agency_manual_calls.id`, the soft-phone call detail's), `contact_id` the roster
 * contact the number matched (claimed or linked), else null; `phone_e164` the number dialled.
 */
export interface CampaignSoftphoneLogRow {
  source: 'soft_phone';
  id: string;
  campaign_id: string;
  contact_id: string | null;
  attempt_number: null;
  phone_e164: string;
  caller_id: string;
  /** Who placed it (a soft-phone call always has an agent). */
  agent_user_id: string;
  reserved_agent_id: null;
  state: AgencyManualCallState;
  outcome: AgencyManualCallOutcome | null;
  disposition_code: string | null;
  auto_disposition_code: null;
  notes: string | null;
  callback_at: string | null;
  /** The soft-phone call's own promise to pay (PT1): `YYYY-MM-DD`, and the amount's two-place string. */
  promise_date: string | null;
  promise_amount: string | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  webrtc_call_id: string | null;
  dialed_at: string | null;
  answered_at: string | null;
  bridged_at: string | null;
  ended_at: string | null;
  talk_seconds: number | null;
  wrapup_seconds: null;
  redial_of_attempt_id: null;
  redial_number: null;
  created_at: string;
}

export type CampaignCallLogRow = CampaignDiallerLogRow | CampaignSoftphoneLogRow;
