import { type PlatformAuditAction } from '../audit/platform/catalog.js';
import { type AuditActionGroup, type AuditActionOption } from '../audit/platform/vocabulary.js';

/**
 * The action vocabulary of the campaign activity trail — served, not mirrored.
 *
 * ── Why this is master's to publish ─────────────────────────────────────────
 * The trail is a merge of two stores with different vocabularies
 * (`agency-activity.ts`), and the only process that knows BOTH halves is this
 * one. CusUI used to keep its own hand-written copy for the filter control, and
 * that copy could not be checked against anything: master is not a dependency
 * of cusui, core is not a dependency of either, and in cusui's CI only cusui is
 * checked out. So the copy drifted silently and the drift was invisible until
 * a supervisor ticked a box that could no longer match a row. Publishing the
 * list on the response it filters removes the second copy entirely — there is
 * one vocabulary and it travels with the data it describes.
 *
 * ── What a client may assume ────────────────────────────────────────────────
 * This is the set of actions worth OFFERING as a filter, not a claim about what
 * the trail can contain. A row whose action is absent here must still render:
 * an unrecognised audit row is exactly the one nobody anticipated, and hiding
 * it is the one omission an audit view cannot afford.
 *
 * ── Served on the JSON route only, deliberately ─────────────────────────────
 * `…/activity` is read by the screen that draws the filter; `…/activity.csv` is
 * a file, and a file has no filter to draw. Its ten columns are a fixed
 * contract a spreadsheet reads, so the list has nowhere to go inside it except
 * the preamble — where it would be a catalogue of controls the reader of a CSV
 * does not have, and would push the one thing that export DOES need to say (the
 * filters actually applied, which the preamble already carries) further down.
 */

/**
 * The filter's sections, in the operator's vocabulary rather than the schema's.
 *
 * Expressed as a subtraction from the tenant-wide log's groups rather than as
 * its own three-way union, so the two filters cannot end up with groups that
 * differ by a typo. `Scheduling` is the one this screen does not have, for the
 * same reason it carries no `schedule.*` actions: nothing scheduler-shaped
 * belongs to a single campaign. Adding a group to `AuditActionGroup` therefore
 * makes it available here too — narrow it out below if it should not be.
 */
export type ActivityActionGroup = Exclude<AuditActionGroup, 'Scheduling'>;

/**
 * One shape for both filters — the fields come from `AuditActionOption`, this
 * only narrows the group and drops the product axis. Two independently-declared
 * shapes was how the two lists could have drifted in the ONE thing a client
 * parses.
 *
 * ── Why `product` is omitted rather than stated on every entry (E9) ──────────
 * The tenant-wide log spans both products, so there the axis is the answer to a
 * real question. This filter only ever renders inside one campaign, and a
 * campaign is an agency object — every row on this screen is `'agency'` by
 * construction. Restating that on 22 entries would be 22 chances to typo the one
 * value it can hold, and would put a control on the screen whose only option is
 * "the thing you are already looking at". If this trail ever merges in something
 * that is not campaign-scoped, that is the moment to re-add it.
 */
export type ActivityActionOption =
  Omit<AuditActionOption, 'product'> & { group: ActivityActionGroup };

/**
 * Master's half, taken from the frozen catalog rather than retyped.
 *
 * `schedule.*` and `recurring_schedule.*` are deliberately excluded and the
 * exclusion is what this type states: they are scheduler events that never
 * carry a campaign scope, so offering them here would be a filter that always
 * returns nothing on this screen. Everything master writes ABOUT a campaign is
 * `agency_*` or `dnc_*`, which is why the boundary can be drawn on the prefix.
 */
type CampaignScopedAuditAction = Extract<
  PlatformAuditAction,
  `agency_${string}` | `dnc_${string}`
>;

/**
 * Core's half. **This is a transcription, and it cannot be anything else.**
 *
 * Core is a separate repository and is not a dependency of this one — there is
 * no module to import and nothing in master's CI that could compare the two. So
 * this list pins what master BELIEVES core writes, not what core writes, and
 * the honest statement of its weakness is: it catches this file drifting from
 * the values below, not master drifting from core. Same weakness, same shape,
 * as cusui's permission mirror — with one thing bought back, that the belief now
 * lives in ONE place instead of one per client.
 *
 * Re-derive it rather than trusting it, from magic-voice-core (read at v1.82.5):
 *
 *  - `src/api/routes/agency-campaigns.routes.ts:386` writes
 *    `agency_campaign.created` on campaign creation.
 *  - `src/api/routes/agency-campaigns.routes.ts:665`, inside the `transition`
 *    helper, writes `agency_campaign.${to}` — so the set is exactly that
 *    helper's call sites: `/start` and `/resume` → `running` (687, 700),
 *    `/pause` → `paused` (693), `/stop` → `stopping` (725). Note `/stop` does
 *    NOT write `stopped`: 200 there means "accepted and draining".
 *  - `src/agency/pacing-engine.ts:1038` (`maybeFinalize`) writes the two
 *    TERMINAL transitions, `completed` (a running campaign that ran out of
 *    work) and `stopped` (a stopping campaign whose attempts drained). Nothing
 *    else writes them — the leader is their single writer.
 *  - `src/agency/abandonment-guardrail.ts:135` writes
 *    `agency_campaign.auto_paused`.
 *
 * `paused` and `stopped` are also in master's catalog; both services writing one
 * action name is the design, not a duplicate (`source` tells the two rows
 * apart), so they appear once in the vocabulary below.
 */
export const CORE_AGENCY_EVENT_TYPES = [
  'agency_campaign.created',
  'agency_campaign.running',
  'agency_campaign.paused',
  'agency_campaign.auto_paused',
  'agency_campaign.stopping',
  'agency_campaign.stopped',
  'agency_campaign.completed',
] as const;

type CoreAgencyEventType = (typeof CORE_AGENCY_EVENT_TYPES)[number];

/**
 * The served vocabulary, in the order a filter should render it: the campaign's
 * lifecycle first, then what happened on the calls, then who was staffing it.
 *
 * Declaration order IS the presentation order — sorting it client-side would put
 * `auto_paused` next to `created` alphabetically, which reads as noise to
 * someone scanning for the pause.
 */
export const CAMPAIGN_ACTIVITY_ACTIONS = [
  { value: 'agency_campaign.created', label: 'Created', group: 'Campaign' },
  { value: 'agency_campaign.started', label: 'Start pressed', group: 'Campaign' },
  { value: 'agency_campaign.running', label: 'Started running', group: 'Campaign' },
  { value: 'agency_campaign.paused', label: 'Paused', group: 'Campaign' },
  { value: 'agency_campaign.auto_paused', label: 'Auto-paused', group: 'Campaign' },
  { value: 'agency_campaign.resumed', label: 'Resumed', group: 'Campaign' },
  { value: 'agency_campaign.stopping', label: 'Stopping', group: 'Campaign' },
  { value: 'agency_campaign.stopped', label: 'Stopped', group: 'Campaign' },
  { value: 'agency_campaign.completed', label: 'Completed', group: 'Campaign' },
  // Master's, not core's — see the catalog entry for why the two stores split
  // this one the way they do. It sits at the END of the lifecycle block rather
  // than beside `created` because that block is in the order a campaign moves
  // through it, and authoring a retry is something that happens to a campaign
  // that has already finished.
  { value: 'agency_campaign.retry_created', label: 'Retry campaign created', group: 'Campaign' },
  { value: 'agency_disposition.created', label: 'Disposition filed', group: 'Calls' },
  { value: 'agency_attempt.hung_up', label: 'Call ended by agent', group: 'Calls' },
  // MAG-159. A bulk export of every number on a campaign takes no permission
  // beyond `agency.supervise`, on the reasoning that a second gate to keep
  // aligned is a second gate to drift. Attribution is what answers the exposure
  // instead — so the export has to be visible HERE, on the campaign's own
  // trail, not only in a log line. Grouped with Calls rather than given a group
  // of its own: two entries do not earn a heading.
  { value: 'agency_attempts.exported', label: 'Call attempts exported', group: 'Calls' },
  { value: 'agency_contacts.exported', label: 'Contact roster exported', group: 'Calls' },
  { value: 'dnc_entry.created', label: 'Marked do-not-call', group: 'Calls' },
  { value: 'dnc_entry.deleted', label: 'Do-not-call removed', group: 'Calls' },
  { value: 'agency_campaign_agent.assigned', label: 'Agent assigned', group: 'Staffing' },
  { value: 'agency_campaign_agent.unassigned', label: 'Agent unassigned', group: 'Staffing' },
  { value: 'agency_session.joined', label: 'Agent joined', group: 'Staffing' },
  { value: 'agency_session.left', label: 'Agent left', group: 'Staffing' },
  { value: 'agency_session.break_started', label: 'Break started', group: 'Staffing' },
  { value: 'agency_session.break_cancelled', label: 'Break cancelled', group: 'Staffing' },
  { value: 'agency_session.force_available', label: 'Made available by supervisor', group: 'Staffing' },
] as const satisfies readonly ActivityActionOption[];

type ServedAction = (typeof CAMPAIGN_ACTIVITY_ACTIONS)[number]['value'];

/**
 * Exhaustiveness against the catalog, at compile time.
 *
 * `satisfies` above only proves every entry is well-SHAPED; it says nothing
 * about anything missing. A new `agency_*`/`dnc_*` action added to
 * `PLATFORM_AUDIT_ACTIONS` and forgotten here is a filter that cannot select
 * rows master is already writing — so it is a type error, and
 * `test/unit/agency/agency-activity-actions.test.ts` fails on it too (vitest
 * does not type-check, so the test is what catches it in `npm test`).
 *
 * Core's half is in the same check for symmetry of failure, but it is a weaker
 * guarantee by construction: it pins this file against its own transcription
 * above, which is all a repository that cannot see core can do.
 */
type MissingAction = Exclude<CampaignScopedAuditAction | CoreAgencyEventType, ServedAction>;
const _allActionsServed: MissingAction extends never ? true : MissingAction = true;
void _allActionsServed;

/**
 * And the other direction: an entry here that neither store writes.
 *
 * That one is not a crash, it is worse — a checkbox an operator can tick that
 * always returns an empty trail, which reads as "this never happened".
 */
type UnwrittenAction = Exclude<ServedAction, CampaignScopedAuditAction | CoreAgencyEventType>;
const _noUnwrittenActions: UnwrittenAction extends never ? true : UnwrittenAction = true;
void _noUnwrittenActions;
