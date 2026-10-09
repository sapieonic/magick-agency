import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_ACTOR_TYPES,
  PLATFORM_AUDIT_RESOURCE_TYPES,
  type PlatformAuditAction,
  type PlatformAuditActorType,
  type PlatformAuditResourceType,
} from './catalog.js';

/*
 * PORT NOTE (magick-agency): ported from master `src/audit/vocabulary.ts`
 * (v3.24.0), trimmed with the catalog. Removed, each in PORTING.md:
 *  - the eleven `schedule.*` / `recurring_schedule.*` action entries and the two
 *    resource-type entries (AI scheduling);
 *  - the `'Scheduling'` group, which no remaining action belongs to;
 *  - the `'ai'` product (from `AuditProduct`, `AUDIT_PRODUCTS` and the product
 *    vocabulary): every action that carried it was a scheduling action, and an
 *    option that always returns nothing is exactly what this module's own rule
 *    forbids ("reads as 'this never happened'");
 *  - the `api_key` actor-type entry (decision #5, no API keys).
 * The compile-time exhaustiveness checks at the bottom are master's, unchanged,
 * and still bind the vocabulary to the trimmed catalog in both directions.
 * Comments above entries are master's and describe master's two-product world.
 */

/**
 * The vocabulary of the tenant-wide audit log — served, not mirrored.
 *
 * ── Why this is master's to publish ─────────────────────────────────────────
 * `platform_audit_log` is written by this service and read by this service;
 * `catalog.ts` is the complete, frozen truth about what can appear in it. CusUI
 * nonetheless kept a hand-written copy of both arrays to draw the Audit Log
 * page's two dropdowns, and that copy could not be checked against anything:
 * master is not a dependency of cusui, and cusui's "lockstep" test compared its
 * copy against a second transcription inside its own test file — so it could
 * only catch someone editing one cusui file and not the other, never master
 * actually changing. Publishing the vocabulary on the response it filters
 * removes the second copy entirely.
 *
 * This case is strictly easier than the campaign trail's
 * (`src/agency/agency-activity-actions.ts`), and the difference is worth
 * naming: that trail merges master's store with core's, so its list contains an
 * irreducible transcription of action names master cannot import. Nothing here
 * is transcribed. Every value below is `Exclude`-checked against the catalog it
 * comes from, in both directions, at compile time.
 *
 * ── What a client may assume ────────────────────────────────────────────────
 * This is the set worth OFFERING as a filter, not a claim about what the table
 * can contain. A row whose action or resource type is absent here must still
 * render: an unrecognised audit row is exactly the one nobody anticipated, and
 * hiding it is the one omission an audit view cannot afford.
 *
 * ── Why the labels are not the campaign trail's labels ──────────────────────
 * `CAMPAIGN_ACTIVITY_ACTIONS` labels `agency_campaign.paused` as "Paused" and
 * `agency_session.joined` as "Agent joined". It can: that filter only ever
 * renders inside one campaign, so the subject is on the screen already. This
 * view is tenant-wide and the reader is inside nothing — "Paused" beside
 * "Schedule cancelled" does not say what was paused. So the labels here are
 * self-standing ("Campaign paused", "Agent joined session"), and the two lists
 * are deliberately NOT deduplicated into one. Anyone tempted to fold them
 * together will have to pick one register, and either choice is wrong on the
 * other screen.
 */

/**
 * The filter's sections, in the operator's vocabulary rather than the schema's.
 *
 * `Team` is the newest and the only one that is not about work being done: it
 * covers who is IN the workspace and how they got there. It is kept apart from
 * `Staffing` deliberately, and the two are easy to confuse — `Staffing` is which
 * campaign an agent is pointed at TODAY, `Team` is whether that person is a
 * member of this tenant at all. A reader asking "who let this person in" and a
 * reader asking "who is on the queue this afternoon" are not the same reader.
 */
export type AuditActionGroup = 'Campaign' | 'Calls' | 'Staffing' | 'Team';

/**
 * WHICH PRODUCT an audited action belongs to (E9).
 *
 * The company sells two products off one platform and the audit taxonomy leaned
 * entirely AI-ward: `group` says what KIND of thing happened ("Calls",
 * "Scheduling"), and nothing anywhere said which product's surface it happened
 * on. So a tenant running both cannot ask the one question a two-product audit
 * log invites — *what did the agency side do today* — and the axis telemetry is
 * due to get as a super-property (E8) had no counterpart here.
 *
 * ── Reserved now, deliberately, before anyone asks to filter by it ──────────
 * Because the alternative is worse later. `platform_audit_log` rows are
 * historical record: the action keys in `catalog.ts` are already persisted and
 * cannot be renamed or renumbered to carry a product prefix. Adding the axis as
 * a DERIVED property of the action key costs nothing today and stays correct for
 * every row already written; adding it as a persisted column later would need a
 * migration plus a backfill that could only ever re-derive what this function
 * already computes.
 *
 * ── Three values, and the third arrived exactly as this note predicted ──────
 * `'ai'` and `'agency'` are the two PRODUCTS, spelled the same way E8's
 * telemetry super-property will spell them so the two axes can be read together
 * across repos. The three-zone model (`docs/agency-dialer-design.md` §7b) also
 * names a **platform** zone — team, credits, API keys, settings — that is shared
 * by design; the previous revision of this paragraph said master wrote no audit
 * action for it *yet*, and that this union would gain `'platform'` when it did.
 *
 * It has. `user.invite_sent` and `user.invite_claimed` (migration 069) are
 * platform-zone actions and cannot honestly be filed under either product: a
 * membership is what a person holds in the WORKSPACE, and the same invite
 * mechanism serves an `agent` and an `account_admin`. Filing them under
 * `'agency'` because the only role currently receiving mail is an agent would
 * bake today's scope into a historical record that outlives it — and would show
 * agency rows to a tenant that has no dialer at all.
 *
 * The mechanism that forced the choice rather than letting it default is worth
 * keeping in view for whatever lands next: `product` is a REQUIRED field on
 * every entry of {@link PLATFORM_AUDIT_ACTION_VOCABULARY}, and the catalog
 * exhaustiveness checks below mean a new action cannot be written without one.
 * The same "no default, so the compiler enumerates the call sites" discipline
 * the repository `scope` parameter uses in core.
 */
export type AuditProduct = 'agency' | 'platform';

/**
 * The product axis as a value list, for a Zod enum and for the served
 * vocabulary. Declaration order is presentation order, primary product first.
 */
export const AUDIT_PRODUCTS = ['agency', 'platform'] as const satisfies readonly AuditProduct[];

export interface AuditActionOption {
  /** The wire value, passed back verbatim as `?action=`. */
  value: string;
  /** Operator-facing copy. Rendered as the control's label. */
  label: string;
  group: AuditActionGroup;
  /**
   * Which product's surface this action happens on. See {@link AuditProduct}.
   *
   * Required, with no default, on purpose — a new action must state its product
   * or it does not compile. It sits here rather than in `catalog.ts` for the
   * same reason `group` does: it is a property of the action, this is the file
   * that describes actions, and one declaration per action is one place for the
   * two axes to be read together. `catalog.ts` stays the frozen list of keys.
   */
  product: AuditProduct;
}

export interface AuditResourceTypeOption {
  /** The wire value, passed back verbatim as `?resource_type=`. */
  value: string;
  /** Operator-facing copy. Rendered as the control's label. */
  label: string;
}

/**
 * The served action vocabulary, in the order a filter should render it.
 *
 * Declaration order IS the presentation order — within each group the campaign,
 * schedule or session's lifecycle runs top to bottom, which is how someone
 * scanning for "where did it stop" reads it. Do not sort this client-side:
 * alphabetically, `schedule.cancelled` leads and `schedule.created` follows it,
 * which reads as noise.
 *
 * `schedule.*` and `recurring_schedule.*` are the Scheduling group, and they are
 * exactly the actions `agency-activity-actions.ts` deliberately EXCLUDES. That
 * is the whole reason these are two lists rather than one filtered list: those
 * actions carry no campaign scope, so on a campaign-scoped screen every one of
 * them is a control that returns nothing — while here, where the query is the
 * whole tenant, they are half of what the log contains.
 *
 * ── `product` is the second axis, and it is orthogonal to `group` ────────────
 * `group` says what kind of thing happened; `product` says which product it
 * happened on (E9, {@link AuditProduct}). They do not nest: "Calls" holds four
 * agency actions and both DNC actions, and the Scheduling group is entirely the
 * AI product — master's scheduler dispatches broadcasts, static calls, IVR and
 * messaging, and an agency campaign's pacing and calling windows live in core's
 * engine, never here. DNC is agency by Q2 despite the AI-neutral action name,
 * which is exactly why the axis is stated per action rather than derived from
 * the name.
 */
export const PLATFORM_AUDIT_ACTION_VOCABULARY = [
  // The campaign lifecycle, as master records it. Note master writes only the
  // four operator-pressed transitions; the ones core observes (`created`,
  // `running`, `auto_paused`, `stopping`, `completed`) are core's audit store
  // and are not in this catalog, so they are not offered here.
  { value: 'agency_campaign.started', label: 'Campaign start pressed', group: 'Campaign', product: 'agency' },
  { value: 'agency_campaign.paused', label: 'Campaign paused', group: 'Campaign', product: 'agency' },
  { value: 'agency_campaign.resumed', label: 'Campaign resumed', group: 'Campaign', product: 'agency' },
  { value: 'agency_campaign.stopped', label: 'Campaign stopped', group: 'Campaign', product: 'agency' },
  // The label says "retry campaign", never "retry", because `attempts_retried`
  // on the campaign stats already means a WITHIN-campaign redial of one contact
  // (`agency.md` §7.4). Two unrelated things called "retry" on adjacent surfaces
  // is how an operator reads a roster of 812 new contacts as 812 redials.
  { value: 'agency_campaign.retry_created', label: 'Retry campaign created', group: 'Campaign', product: 'agency' },

  { value: 'agency_disposition.created', label: 'Call disposition filed', group: 'Calls', product: 'agency' },
  { value: 'agency_attempts.exported', label: 'Call attempts exported', group: 'Calls', product: 'agency' },
  { value: 'agency_contacts.exported', label: 'Contact roster exported', group: 'Calls', product: 'agency' },
  { value: 'agency_attempt.hung_up', label: 'Call ended by agent', group: 'Calls', product: 'agency' },
  { value: 'dnc_entry.created', label: 'Number marked do-not-call', group: 'Calls', product: 'agency' },
  { value: 'dnc_entry.deleted', label: 'Do-not-call entry removed', group: 'Calls', product: 'agency' },

  { value: 'agency_campaign_agent.assigned', label: 'Agent assigned to campaign', group: 'Staffing', product: 'agency' },
  { value: 'agency_campaign_agent.unassigned', label: 'Agent unassigned from campaign', group: 'Staffing', product: 'agency' },
  { value: 'agency_session.joined', label: 'Agent joined session', group: 'Staffing', product: 'agency' },
  { value: 'agency_session.left', label: 'Agent left session', group: 'Staffing', product: 'agency' },
  { value: 'agency_session.break_started', label: 'Agent break started', group: 'Staffing', product: 'agency' },
  { value: 'agency_session.break_cancelled', label: 'Agent break cancelled', group: 'Staffing', product: 'agency' },
  { value: 'agency_session.force_available', label: 'Agent made available by supervisor', group: 'Staffing', product: 'agency' },

  // Team, and the PLATFORM product — see {@link AuditProduct}. The labels say
  // "invitation" rather than "invite" because the noun is what the reader is
  // filtering for, and they name the two ENDS of the hand-off ("sent" /
  // "accepted") rather than its internal state, since the row that matters in a
  // dispute is the second one: it is the only record that a particular Firebase
  // identity was bound to this membership, and the only place a mismatch between
  // the invited address and the one used is written down.
  { value: 'user.invite_sent', label: 'Invitation sent', group: 'Team', product: 'platform' },
  { value: 'user.invite_claimed', label: 'Invitation accepted', group: 'Team', product: 'platform' },
] as const satisfies readonly AuditActionOption[];

/**
 * The served resource-type vocabulary, in the same order as the actions above:
 * what a campaign is made of first, then what schedules it.
 *
 * The labels answer "what kind of thing is this row about" for someone who has
 * never seen the schema — `agency_campaign_agent` is an assignment, not an
 * agent, and a filter labelled "Agent" would quietly select the wrong rows.
 */
export const PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY = [
  { value: 'agency_campaign', label: 'Campaign' },
  { value: 'agency_session', label: 'Agent session' },
  { value: 'agency_attempt', label: 'Call attempt' },
  { value: 'agency_disposition', label: 'Call disposition' },
  { value: 'agency_campaign_agent', label: 'Campaign agent assignment' },
  { value: 'dnc_entry', label: 'Do-not-call entry' },
  // "Invitation", not "Membership": the rows filed under it are about the token
  // and its life (sent, accepted), and on every refusal path there is no
  // membership change to point at. Same reasoning as `agency_campaign_agent`
  // being labelled an assignment rather than an agent.
  { value: 'membership_invite', label: 'Invitation' },
] as const satisfies readonly AuditResourceTypeOption[];

/**
 * The product axis as a filter, in the same shape as the two above.
 *
 * ── The labels avoid the word "dialer", and that is Q1, not fussiness ────────
 * Q1 handed both "dialer" and "campaign" to the agency offering, so "Dialer"
 * beside "Agency" in one control would name the same product twice. The AI
 * product's label is the product, not its surfaces: an operator filtering here
 * is asking "which half of my subscription did this", not "which page".
 *
 * `'platform'` is now offered, having previously been absent because master wrote
 * no platform-zone action — see {@link AuditProduct} for what changed. The rule
 * that kept it out still holds and is the reason it is in now: an option that
 * always returns nothing reads to an operator as "this never happened", which is
 * the failure the two-direction checks below exist to prevent.
 */
export const PLATFORM_AUDIT_PRODUCT_VOCABULARY = [
  { value: 'agency', label: 'Agency dialer' },
  // The shared zone (docs/agency-dialer-design.md §7b): team, credits, API keys,
  // settings. "Workspace" rather than "Platform" because an operator reading
  // this control is picking which half of their SUBSCRIPTION an action belongs
  // to, and "platform" is our word for the service, not theirs for the thing
  // they administer. It is offered because master now writes actions under it —
  // an option that always returns nothing reads as "this never happened", which
  // is exactly what the two-direction checks below exist to prevent.
  { value: 'platform', label: 'Workspace' },
] as const satisfies readonly { value: AuditProduct; label: string }[];

/**
 * The actor-type axis, served the same way and for the same reason (86d45t7rm).
 *
 * ── The labels are the reader's question, not the schema's word ─────────────
 * "API key" rather than "api_key", and "Automatic" rather than "system", because
 * the distinction this axis draws only pays off if a non-engineer reading the log
 * can act on it. The one it must never blur is `api_key` against `system`: both
 * render today as a row with no person's name on it, and they mean opposite
 * things for an incident — "someone used a credential" versus "nothing human was
 * involved". The descriptions carry that, since two labels alone cannot.
 *
 * ── There is no option for a NULL `actor_type` ──────────────────────────────
 * Rows written before migration 067 have one, and they are not offerable as a
 * filter: "unknown" is an absence rather than a value, and an operator selecting
 * it would be selecting "everything before the upgrade", which is a date range
 * and is already expressible as one. The module header's rule applies to those
 * rows as it does to an unrecognised action — they must still RENDER, and
 * `normalizeMasterRow` keeps rendering them exactly as it did before the column
 * existed.
 */
export const PLATFORM_AUDIT_ACTOR_TYPE_VOCABULARY = [
  {
    value: 'human',
    label: 'Person',
    description: 'A signed-in user performed this action.',
  },
  {
    value: 'system',
    label: 'Automatic',
    description: 'No caller — a scheduled or background process performed this action.',
  },
] as const satisfies readonly { value: PlatformAuditActorType; label: string; description: string }[];

/**
 * The product an action belongs to, or `null` for one this deployment does not
 * know.
 *
 * ── `null`, not a guess, and not a prefix rule ───────────────────────────────
 * The obvious shortcut is `action.startsWith('agency_')`. It is **already wrong
 * today**: `dnc_entry.created` and `dnc_entry.deleted` carry no such prefix and
 * are agency-only by Q2 (the primary application has no bearing on do-not-call),
 * so a prefix rule would file every DNC mark under the AI product — silently,
 * and on the one surface whose whole job is to be believable. The mapping is
 * therefore stated per action, where a reader can disagree with it.
 *
 * `null` for an unrecognised action is the same rule the module header states
 * for the vocabulary as a whole: a row whose action is absent here must still
 * render. An unrecognised audit row is exactly the one nobody anticipated, and
 * labelling it with a product master is guessing at is worse than saying
 * nothing.
 */
export function auditProductForAction(action: string): AuditProduct | null {
  return PRODUCT_BY_ACTION.get(action) ?? null;
}

/**
 * Every action belonging to one product — what a `?product=` filter expands to.
 *
 * Derived from the vocabulary rather than listed again: a second list is a
 * second thing to forget, and this one has a compile-time guarantee of covering
 * exactly the catalog (see the `Exclude` pairs below).
 */
export function auditActionsForProduct(product: AuditProduct): string[] {
  return PLATFORM_AUDIT_ACTION_VOCABULARY
    .filter((action) => action.product === product)
    .map((action) => action.value);
}

const PRODUCT_BY_ACTION: ReadonlyMap<string, AuditProduct> = new Map(
  PLATFORM_AUDIT_ACTION_VOCABULARY.map((action) => [action.value, action.product]),
);

type ServedAction = (typeof PLATFORM_AUDIT_ACTION_VOCABULARY)[number]['value'];
type ServedResourceType = (typeof PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY)[number]['value'];

/**
 * Exhaustiveness against the catalog, at compile time, in both directions.
 *
 * `satisfies` above only proves each entry is well-SHAPED; it says nothing about
 * anything missing, and nothing about an entry the catalog does not contain.
 *
 * Missing: a new action or resource type added to `catalog.ts` and forgotten
 * here is a filter that cannot select rows master is already writing.
 *
 * Extra: an entry the catalog does not contain is worse than a crash — it is a
 * dropdown option an operator can pick that always returns nothing, which reads
 * as "this never happened".
 *
 * These are `tsc --noEmit` checks and `npm run lint` is exactly that, but vitest
 * does NOT type-check: a source file with a type error still runs. So
 * `test/unit/audit/vocabulary.test.ts` re-states all four checks at runtime,
 * and that is what fails under `npm test`.
 */
type MissingAction = Exclude<PlatformAuditAction, ServedAction>;
const _allActionsServed: MissingAction extends never ? true : MissingAction = true;
void _allActionsServed;

type UnwrittenAction = Exclude<ServedAction, PlatformAuditAction>;
const _noUnwrittenActions: UnwrittenAction extends never ? true : UnwrittenAction = true;
void _noUnwrittenActions;

type MissingResourceType = Exclude<PlatformAuditResourceType, ServedResourceType>;
const _allResourceTypesServed: MissingResourceType extends never ? true : MissingResourceType = true;
void _allResourceTypesServed;

type UnwrittenResourceType = Exclude<ServedResourceType, PlatformAuditResourceType>;
const _noUnwrittenResourceTypes: UnwrittenResourceType extends never ? true : UnwrittenResourceType = true;
void _noUnwrittenResourceTypes;

/**
 * Length, which the `Exclude` pairs above cannot see: they compare the union of
 * values, and a union collapses duplicates. Two entries with the same `value`
 * (a copy-paste while adding a group) would satisfy both directions and render
 * as the same option twice.
 */
type _ActionCountMatches = typeof PLATFORM_AUDIT_ACTIONS extends { length: infer N }
  ? typeof PLATFORM_AUDIT_ACTION_VOCABULARY extends { length: N } ? true : never
  : never;
const _actionCountMatches: _ActionCountMatches = true;
void _actionCountMatches;

type _ResourceTypeCountMatches = typeof PLATFORM_AUDIT_RESOURCE_TYPES extends { length: infer N }
  ? typeof PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY extends { length: N } ? true : never
  : never;
const _resourceTypeCountMatches: _ResourceTypeCountMatches = true;
void _resourceTypeCountMatches;

type ServedActorType = (typeof PLATFORM_AUDIT_ACTOR_TYPE_VOCABULARY)[number]['value'];

/**
 * The same two-direction exhaustiveness the actions and resource types get, for
 * the same two reasons: a member of the enum with no entry here is a principal
 * kind the filter cannot select but the table contains, and an entry the enum
 * does not contain is an option that always returns nothing.
 */
type MissingActorType = Exclude<PlatformAuditActorType, ServedActorType>;
const _allActorTypesServed: MissingActorType extends never ? true : MissingActorType = true;
void _allActorTypesServed;

type UnwrittenActorType = Exclude<ServedActorType, PlatformAuditActorType>;
const _noUnwrittenActorTypes: UnwrittenActorType extends never ? true : UnwrittenActorType = true;
void _noUnwrittenActorTypes;

type _ActorTypeCountMatches = typeof PLATFORM_AUDIT_ACTOR_TYPES extends { length: infer N }
  ? typeof PLATFORM_AUDIT_ACTOR_TYPE_VOCABULARY extends { length: N } ? true : never
  : never;
const _actorTypeCountMatches: _ActorTypeCountMatches = true;
void _actorTypeCountMatches;
