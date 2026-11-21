import { AGENCY_PHONE_DISPLAY_DEFAULT, type AgencyPhoneDisplay } from '../../types/agency';
import type { AgencyInboundCall } from '../../types/inbound';
import type { AgencyManualCall, AgencySoftphoneCampaign } from '../../types/softphone';
import { SIDE_COPY } from './sideViewCopy';
import { phoneForDisplay } from './stationFormat';
import { customerCard, lastCallRows, type CustomerCard, type LastCallRow } from './stationCustomer';

/**
 * The customer card and Last calls on the station's side views (an inbound call, the soft phone),
 * built by the outbound card's own rules (`stationCustomer.ts`) from what those calls carry: an
 * inbound caller's matched contact, a soft-phone call's roster contact. Neither carries typed facts
 * (BE-6 rides on the reserved attempt only), so the card reads the contact's columns with the
 * matched work's `context_display`: the name and the line under it by the server's rule (the
 * domain's `customerNameFrom` / `customerPlaceFrom`, S1; on a campaign without chosen facts the
 * name, when the rule finds none, by the card's guess from before AS19), and, when that work has chosen its facts
 * (AS19, `context_display.facts`), the tiles by the server's own builder (`chosenFactTiles`, S6,
 * through `chosenFactsFromContext`): the same tiles, names (`label ?? column`) and value formats
 * as on an outbound call. An inbound caller's phone facts follow the station's `phone_display`; a
 * soft-phone call's follow its tagged campaign's own (S3(b)).
 */

/**
 * An inbound caller: the matched contact's name, place and facts, the number as the station's
 * `phone_display` says (AS9), and "Number hidden" for a withheld number.
 */
export function inboundCustomerCard(call: AgencyInboundCall, phoneDisplay: 'full' | 'masked' = 'full'): CustomerCard {
  const match = call.match;
  const card = customerCard(
    { phone_e164: call.from_e164 ?? '', context: match?.context ?? {}, prior_attempts: match?.prior_attempts ?? [] },
    match?.context_display,
    { phoneDisplay },
  );
  return call.from_e164 ? card : { ...card, phone: SIDE_COPY.numberHidden };
}

/** The matched contact's earlier calls, the outcomes named from the matched work's own list. */
export function inboundLastCalls(call: AgencyInboundCall): LastCallRow[] {
  const match = call.match;
  if (!match) return [];
  return lastCallRows(
    { campaign_id: match.campaign_id, prior_attempts: match.prior_attempts },
    call.catalog_source === 'campaign' ? call.disposition_catalog : undefined,
  );
}

/**
 * A soft-phone call: the number the agent dialled (shown whole: they typed it), and the roster
 * contact's name, place and facts when the number is on the tagged work's list, read with that
 * campaign's `context_display`. The facts follow that campaign's own `phone_display` (S3(b)),
 * whatever campaign (if any) the session is on: a phone fact is masked under masked; only the
 * dialled number is not. No campaign (an untagged call), or one from an older server without the
 * setting: shown in full.
 */
export function softphoneCustomerCard(
  call: AgencyManualCall,
  campaign: Pick<AgencySoftphoneCampaign, 'context_display' | 'phone_display'> | null | undefined,
): CustomerCard {
  const contact = call.contact;
  const card = customerCard(
    { phone_e164: call.destination_e164, context: contact?.context ?? {}, prior_attempts: contact?.prior_attempts ?? [] },
    campaign?.context_display,
    { phoneDisplay: campaignPhoneDisplay(campaign) },
  );
  return { ...card, phone: phoneForDisplay(call.destination_e164, 'full') };
}

/** The roster contact's earlier calls, named from the tagged work's list. */
export function softphoneLastCalls(call: AgencyManualCall, campaign: AgencySoftphoneCampaign | null): LastCallRow[] {
  const contact = call.contact;
  const campaignId = campaign?.campaign_id ?? call.tag?.campaign_id ?? null;
  if (!contact?.prior_attempts || campaignId === null) return [];
  return lastCallRows({ campaign_id: campaignId, prior_attempts: contact.prior_attempts }, campaign?.disposition_catalog);
}

/** A soft-phone campaign's `phone_display` as the card reads it: anything but `masked` is full (AS18). */
function campaignPhoneDisplay(campaign: Pick<AgencySoftphoneCampaign, 'phone_display'> | null | undefined): AgencyPhoneDisplay {
  return campaign?.phone_display === 'masked' ? 'masked' : AGENCY_PHONE_DISPLAY_DEFAULT;
}
