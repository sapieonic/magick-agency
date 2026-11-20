import type { AgencyContextDisplay } from '../../types/agency';
import type { AgencyInboundCall } from '../../types/inbound';
import type { AgencyManualCall, AgencySoftphoneCampaign } from '../../types/softphone';
import { SIDE_COPY } from './sideViewCopy';
import { customerCard, lastCallRows, type CustomerCard, type LastCallRow } from './stationCustomer';

/**
 * The customer card and Last calls on the station's side views (an inbound call, the soft phone),
 * built by the outbound card's own rules (`stationCustomer.ts`) from what those calls carry: an
 * inbound caller's matched contact, a soft-phone call's roster contact. Neither carries typed facts
 * (BE-6 rides on the reserved attempt only), so the card reads the contact's columns with the
 * matched work's `context_display`, as phase 0 does on an outbound call.
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
 * contact's name, place and facts when the number is on the tagged work's list.
 */
export function softphoneCustomerCard(
  call: AgencyManualCall,
  display: AgencyContextDisplay | undefined,
): CustomerCard {
  const contact = call.contact;
  return customerCard(
    { phone_e164: call.destination_e164, context: contact?.context ?? {}, prior_attempts: contact?.prior_attempts ?? [] },
    display,
    { phoneDisplay: 'full' },
  );
}

/** The roster contact's earlier calls, named from the tagged work's list. */
export function softphoneLastCalls(call: AgencyManualCall, campaign: AgencySoftphoneCampaign | null): LastCallRow[] {
  const contact = call.contact;
  const campaignId = campaign?.campaign_id ?? call.tag?.campaign_id ?? null;
  if (!contact?.prior_attempts || campaignId === null) return [];
  return lastCallRows({ campaign_id: campaignId, prior_attempts: contact.prior_attempts }, campaign?.disposition_catalog);
}
