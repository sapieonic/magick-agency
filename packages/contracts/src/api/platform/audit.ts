/**
 * The tenant audit log's resource types in words: what kind of thing an audit row is about. The
 * server serves them as the Audit Log's `resource_type` filter (its `vocabulary.ts` checks them
 * against the catalog of what it writes, both ways); the console's campaign Activity page labels
 * a row's "On what" with them. One list, so the two screens cannot name a type differently.
 */

export interface AuditResourceTypeOption {
  /** The wire value, passed back unchanged as `?resource_type=`. */
  value: string;
  /** Operator-facing copy. Rendered as the control's label. */
  label: string;
}

/**
 * The resource types, in the Audit Log filter's order.
 *
 * The labels answer "what kind of thing is this row about" for someone who has never seen the
 * schema: `agency_campaign_agent` is an assignment, not an agent, and a filter labelled "Agent"
 * would quietly select the wrong rows.
 */
export const PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY = [
  { value: 'agency_campaign', label: 'Campaign' },
  { value: 'agency_session', label: 'Agent session' },
  { value: 'agency_attempt', label: 'Call attempt' },
  // "Call outcome", the product's word for a disposition. The row's id is the attempt it was
  // filed on.
  { value: 'agency_disposition', label: 'Call outcome' },
  { value: 'agency_campaign_agent', label: 'Agent assignment' },
  { value: 'agency_contact', label: 'Contact' },
  { value: 'agency_manual_call', label: 'Soft-phone call' },
  { value: 'agency_softphone_settings', label: 'Soft-phone settings' },
  { value: 'customer_history', label: 'Customer history search' },
  { value: 'agency_report', label: 'Report' },
  { value: 'agency_report_subscription', label: 'Scheduled report' },
  { value: 'agency_inbound_route', label: 'Inbound route' },
  { value: 'agency_inbound_call', label: 'Inbound call' },
  { value: 'agency_inbound_clip', label: 'Inbound recording' },
  // Capitalised as the Do Not Call page names its list.
  { value: 'dnc_entry', label: 'Do Not Call entry' },
  // "Invitation", not "Membership": the rows filed under it are about the token
  // and its life (sent, accepted), and on every refusal path there is no
  // membership change to point at. Same reasoning as `agency_campaign_agent`
  // being labelled an assignment rather than an agent.
  { value: 'membership_invite', label: 'Invitation' },
  { value: 'account', label: 'Account' },
] as const satisfies readonly AuditResourceTypeOption[];

/** {@link PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY}'s labels by wire value. */
export const AUDIT_RESOURCE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY.map((type) => [type.value, type.label])),
);
