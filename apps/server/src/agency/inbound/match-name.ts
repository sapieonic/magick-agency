/**
 * A roster contact's display name on the surfaces that name a customer beside a call or a row: the
 * inbound "Your customer is waiting" notice (`customer_waiting.match_name`) and the Missed row's
 * `match_name` (IQ54, docs/inbound.md §6, §7), the floor's and the live calls list's call, the
 * listening history, and the callbacks list. It is the domain's one reading
 * (`customerNameFrom`, `@magick-agency/domain/customer-name`, AS19 S1), the one the station's card
 * reads: the campaign's `name` role's column when set (none when blank on this row), else the
 * guess from the column names (the domain's `NAME_GUESS_COLUMNS`, matched ignoring case, spaces,
 * `_`, `-` and `.`), never a hidden column, a fact's or one `types` reads as a phone number.
 * Trimmed, at most the domain's `CUSTOMER_TEXT_MAX` characters. Pure.
 *
 * The SQL reads that feed it send only the columns it can read (`contactNameContextSql`), with the
 * campaign's `context_display` beside them.
 */
import { customerNameFrom, type CustomerNameDisplay } from '@magick-agency/domain/customer-name';

/**
 * The contact's display name, or undefined when it has none.
 *
 * @param context the contact's roster row (`agency_contacts.context`), or the part of it the read sent
 * @param display the contact's campaign's `context_display` (null when the campaign is not known:
 *                the guess alone)
 */
export function matchName(
  context: Record<string, unknown> | null | undefined,
  display: CustomerNameDisplay | null | undefined,
): string | undefined {
  return customerNameFrom(context, display);
}
