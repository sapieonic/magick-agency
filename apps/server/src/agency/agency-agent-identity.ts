import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { ROLE_HIERARCHY, type MembershipRole } from '@magick-agency/contracts/rbac';
import type { AgencyCampaignAgentRecord } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { createChildLogger } from '@magick-agency/observability';
import { pageRows } from './agency-spine.js';

const log = createChildLogger({ component: 'agency-agent-identity' });

/**
 * Identity for the campaign STAFFING list — who a supervisor has assigned to a
 * campaign, as opposed to who is currently live on it.
 *
 * ── The same split as `agency-stats-enrichment.ts` ──────────────────────────
 * `agency_campaign_agents` rows carry a `user_id` and nothing else that a human
 * can read, and the dialer's own tables keep agent ids with no foreign key to
 * `users`. So identity is resolved here, at the public API layer, for exactly the
 * reason `agent_name` is resolved there — `users` and `memberships` are where the
 * fact lives.
 *
 * ── Enrichment must never turn a 200 into a 500 ─────────────────────────────
 * The rule that file states, followed here exactly. The ASSIGNMENT is the fact
 * this endpoint exists to report and it is already in hand before any lookup
 * runs; a failed identity read must degrade to `name: null` / `email: null` /
 * `role: null` on every row, never fail the request. The KEYS are always
 * produced — a sometimes-absent key is a different defect, and a client cannot
 * tell it from a field it forgot to read.
 */

/** One row of `GET /proxy/agency/campaigns/:id/agents`. */
export interface AgencyAssignedAgent {
  user_id: string;
  /**
   * Display name, or `null`. Distinct from `email` rather than folded into it
   * (which is what `userRepository.findDisplayNamesInTenant` does for the stats
   * poll): a supervisor choosing between two people called "Sam" disambiguates by
   * address, so the two facts have to arrive separately.
   */
  name: string | null;
  email: string | null;
  /** Their role in this tenant; see {@link foldHighestRole} for "which" role. */
  role: MembershipRole | null;
  assigned_at: Date;
}

function isMembershipRole(value: string): value is MembershipRole {
  return Object.prototype.hasOwnProperty.call(ROLE_HIERARCHY, value);
}

/**
 * Fold one row per membership into one identity per person, keeping the
 * HIGHEST-authority role.
 *
 * A user can hold several memberships in one tenant — one per account, plus
 * possibly a tenant-level one (`account_id IS NULL`) that reaches every account.
 * The staffing list shows one row per person, so one of those roles has to be
 * reported, and the highest is the only defensible choice: it is what
 * `requirePermission` will actually let them do somewhere in this tenant, and
 * reporting the lower one would show a supervisor an "agent" who can in fact
 * start and stop campaigns.
 *
 * Pure and exported so it can be tested without a database. An unrecognised role
 * string (a column value from a future migration this build predates) is dropped
 * rather than ranked: `ROLE_HIERARCHY[unknown]` is `undefined`, and comparing
 * against it is how an unknown role would silently win.
 */
export function foldHighestRole(
  rows: ReadonlyArray<{ id: string; display_name: string | null; email: string; role: string }>,
): Map<string, { name: string | null; email: string; role: MembershipRole | null }> {
  const folded = new Map<string, { name: string | null; email: string; role: MembershipRole | null }>();

  for (const row of rows) {
    // An empty/whitespace display name is not a name. Normalised to null here so
    // every consumer does not have to re-decide what `'   '` means.
    const name = row.display_name?.trim();
    const role = isMembershipRole(row.role) ? row.role : null;

    const current = folded.get(row.id);
    if (!current) {
      folded.set(row.id, { name: name && name.length > 0 ? name : null, email: row.email, role });
      continue;
    }
    if (role === null) continue;
    if (current.role === null || ROLE_HIERARCHY[role] > ROLE_HIERARCHY[current.role]) {
      current.role = role;
    }
  }

  return folded;
}

/**
 * Attach identity to a campaign's staffing rows.
 *
 * ONE query for the whole list, never one per row — the "no per-item loops over
 * I/O" rule, and the same N+1 `findDisplayNamesInTenant` was introduced to
 * avoid.
 *
 * A user id that resolves to nothing — deleted, or belonging to another tenant —
 * yields nulls rather than being dropped from the list. Dropping it would hide a
 * stale assignment from the one person who can fix it, and a missing row reads as
 * "nobody is staffed" rather than "somebody unidentifiable is".
 */
export async function enrichAssignedAgents(
  assignments: readonly AgencyCampaignAgentRecord[],
  tenantId: string,
): Promise<AgencyAssignedAgent[]> {
  let identities = new Map<
    string,
    { name: string | null; email: string; role: MembershipRole | null }
  >();

  if (assignments.length > 0) {
    try {
      identities = foldHighestRole(
        await userRepository.findIdentitiesInTenant(
          assignments.map((a) => a.user_id),
          tenantId,
        ),
      );
    } catch (err) {
      // Degrade, never fail: the assignment list is the answer and it is already
      // in hand. See the module header.
      log.warn(
        {
          tenantId,
          assignments: assignments.length,
          err: err instanceof Error ? err.message : String(err),
        },
        'agency staffing: identity resolution failed; emitting null name/email/role',
      );
    }
  }

  return assignments.map((assignment) => {
    const identity = identities.get(assignment.user_id);
    return {
      user_id: assignment.user_id,
      name: identity?.name ?? null,
      email: identity?.email ?? null,
      role: identity?.role ?? null,
      assigned_at: assignment.assigned_at,
    };
  });
}

/**
 * The identity lookup every agent-facing enrichment goes through.
 *
 * ── One binding ────────────────────────────────────────────────────────────
 * A named export rather than a closure per call site: the campaign spine's JSON
 * list, its CSV drain, and the supervisor's view of one agent all have to name
 * the same person, and two call sites reaching for two different lookups is how
 * one of them starts reporting an email where the other reports a display name.
 * It is the only declaration of the lookup in the repository, which is what
 * makes that checkable — do not declare a local copy beside a caller.
 *
 * Lives here rather than beside its callers because this module is the one place
 * that owns "turn a user id into something a human reads" — see the header for
 * why that job belongs to the public API layer.
 */
export const resolveAgentNames = (
  ids: readonly string[],
  tenantId: string,
): Promise<Map<string, string | null>> => userRepository.findDisplayNamesInTenant(ids, tenantId);

/**
 * Put `agent_name` beside the `agent_user_id` on a body whose SUBJECT is one
 * agent — the handler's per-agent stats payload, as opposed to a page of rows.
 *
 * ── Why the per-agent stats body needs its own enricher ─────────────────────
 * `enrichAttemptAgentNames` (`agency-spine.ts`) handles the row-page shape:
 * `{ rows: [{ agent_user_id, … }] }`. The handler's `GET /agency-agents/:id/stats` is
 * neither a page nor a list — the agent is the whole subject of the document and
 * their id sits at the top level. Reusing the page enricher would silently do
 * nothing (there is no `rows` array, so it returns the body untouched), which is
 * the failure mode that ships looking like it works.
 *
 * ── Shape rules, inherited from every other enrichment on this feature ──────
 * A SPREAD over the body the handler returned, never a reconstruction — the
 * totals and bucket arrays it adds next must arrive untouched without this file being
 * edited. The KEY is produced whether or not the lookup succeeds: a
 * sometimes-absent key is indistinguishable from a client that forgot to read it,
 * while `null` is an answer. And a failed lookup degrades to `null` rather than
 * failing the read — a name is an improvement on the id, not a precondition for
 * showing the numbers. The rule `agency-stats-enrichment.ts` states: enrichment
 * must never turn a 200 into a 500.
 *
 * A body that carries no string `agent_user_id` (an error body, a shape the
 * handler has changed) is returned BY REFERENCE, so an error reaches
 * `errorMaskHook` exactly as the handler wrote it.
 */
export async function enrichAgentStatsIdentity(
  body: unknown,
  tenantId: string,
  resolveNames: (ids: readonly string[], tenantId: string) => Promise<Map<string, string | null>>,
  onError?: (err: unknown) => void,
): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const agentUserId = record['agent_user_id'];
  if (typeof agentUserId !== 'string' || agentUserId.length === 0) return body;

  let names = new Map<string, string | null>();
  try {
    names = await resolveNames([agentUserId], tenantId);
  } catch (err) {
    onError?.(err);
  }

  return { ...record, agent_name: names.get(agentUserId) ?? null };
}

// ─── The supervisory ROSTER's row filter ────────────────────────────────────

/**
 * One roster row, as much of it as the public layer reads.
 *
 * `AgencyRosterAgentRow` narrowed to the ONE field this module's logic depends
 * on. Mirroring the whole row would be a second, drifting definition of
 * arithmetic this layer deliberately does not own (the rates, the AHT, the
 * occupancy denominator). The generic below carries the rest through untouched
 * instead, so a field the handler adds next arrives without this file being
 * edited.
 */
export interface RosterAgentRowRef {
  agent_user_id: string;
}

/**
 * One `memberships` row, as much of it as the row filter reads.
 *
 * `account_id` is here because "still on the roster" has to be answered against
 * the account the READ is scoped to — see {@link filterRowsByMembership}. `null`
 * is a TENANT-LEVEL membership, which reaches every account.
 *
 * Optional as well as nullable, and the two are read the same way on purpose:
 * `findAnyByUsersAndTenant` selects `*` so the column is always there, but a
 * caller holding some narrower projection must degrade towards KEEPING the row
 * rather than towards hiding it. An unknown scope treated as "some other
 * account" would drop a working colleague from their own supervisor's roster,
 * which is the expensive half of this filter's asymmetry (a missed NAME is a
 * null; a missed MEMBERSHIP is a person who is not on the page).
 */
export interface RosterMembershipRef {
  user_id: string;
  status: string;
  account_id?: string | null;
}

/** What {@link filterRosterRowsByMembership} decided, for one page. */
export interface RosterMembershipFilter<TRow> {
  rows: TRow[];
  /**
   * Rows dropped because the person has LEFT — a `revoked`/`inactive` membership
   * in this tenant. Served to the client as `inactive_omitted`, so a console can
   * say "3 departed agents hidden" instead of quietly showing a short list.
   * Always 0 when `includeInactive` is true, because nothing was dropped for that
   * reason.
   */
  inactiveOmitted: number;
  /**
   * Rows dropped because the id has NO membership row of any status in this
   * tenant — never one of ours, or not a user id at all.
   *
   * Counted apart from `inactiveOmitted` and served under its OWN name,
   * `unattributed_omitted`. Two rules, and they pull in opposite directions so
   * both have to be stated: the counts are never folded together, because
   * reporting a stranger as a departed colleague is a different lie from hiding
   * one — and neither is withheld, because a row that vanishes with no
   * counter behind it makes the console's one quantitative claim (the visible
   * rows fall short of the campaign total by exactly the departed agents' work)
   * false with nothing on the wire to say so.
   *
   * ⚠️ It is NOT an unreachable case. Scoping every statement on `tenant_id` AND
   * `account_id` is what makes a FOREIGN agent impossible; it says nothing about
   * a former one. Attempt history is kept while a `memberships` row goes away
   * with the user, so an id the dialer can still name is an id `memberships` can
   * no longer account for — and on the grouped read one such id costs N rows,
   * because an `agent,campaign` page emits one row per campaign for the same
   * agent.
   */
  unknownOmitted: number;
}

/**
 * Decide which of the handler's roster rows the public route shows.
 *
 * ── Why the public route filters a list the handler just computed ──────────
 * `agency_agent_sessions.agent_user_id` has no FK to `users`, and the roster
 * query reads only the dialer's tables, so it returns every agent who dialled in
 * the window and cannot know that one of them left in April. The answer is in
 * `memberships`, which this layer reads — the same division of labour as the
 * `agent_name` enrichment, applied to which rows exist rather than to what they
 * are called.
 *
 * ── Three states, not two ──────────────────────────────────────────────────
 * `active` is kept always. A `revoked`/`inactive` membership is a DEPARTED
 * colleague: dropped by default and kept under `include_inactive`, because the
 * dispute case this surface exists for is read after somebody leaves (see
 * `membershipRepository.findAnyByUserAndTenant`). **No membership row at all is a
 * third thing** and is dropped under either flag: `include_inactive` means "show
 * me the people who left", not "show me ids you cannot account for".
 *
 * ── "Active" means active IN THE ACCOUNT THIS READ IS SCOPED TO ─────────────
 * `accountId` is a parameter and not an afterthought: the roster is scoped to
 * one account by a required predicate, so an agent revoked from THIS account is
 * a departure from this page even while they are active on another. A
 * tenant-level membership (`account_id IS NULL`) reaches every account and
 * therefore counts. The reasoning, and the case that makes a tenant-wide test
 * wrong, are on {@link filterRowsByMembership} beside the code.
 *
 * ── What this function must NOT touch, ever ────────────────────────────────
 * The `benchmark`. Its cohort is "every agent who dialled in the window,
 * including one whose membership was later revoked" — the floor as it actually
 * was, which is what makes a single agent's number readable. A benchmark that
 * moved when a supervisor toggled a ROW filter would be a different number under
 * the same name. So this returns rows and two counters and is given no way to
 * reach the rest of the body; the caller spreads it.
 *
 * Pure, and exported for that reason: the policy is three lines and the whole
 * cost of getting it wrong is invisible in a status code, so it is tested
 * without a database or a router.
 */
export function filterRosterRowsByMembership<TRow extends RosterAgentRowRef>(
  rows: readonly TRow[],
  memberships: ReadonlyArray<RosterMembershipRef>,
  accountId: string,
  includeInactive: boolean,
): RosterMembershipFilter<TRow> {
  return filterRowsByMembership(
    rows, memberships, accountId, includeInactive, (row) => row.agent_user_id,
  );
}

/**
 * The membership policy itself, over rows whose agent id the caller says how to
 * find.
 *
 * ── Why the accessor is a parameter rather than a second copy of the policy ──
 * The roster's rows carry `agent_user_id` at the top level. The GROUPED read's
 * rows carry a `key` object whose `agent_user_id` member exists only
 * when `agent` is one of the grouped dimensions, so the same three-state
 * decision has to be made about a differently-nested id. The decision is the
 * part where a mistake is invisible in a status code — a departed agent served
 * under `inactive_omitted: 0` is a 200 that states, falsely, that nothing was
 * hidden — so it exists once and each caller supplies a selector.
 * {@link filterRosterRowsByMembership} is the roster's, and keeps its own name
 * because its rows are typed on the field.
 *
 * The three states, the `include_inactive` meaning and the hands-off rule about
 * the rest of the body are all documented on
 * {@link filterRosterRowsByMembership}; they are properties of this policy, not
 * of either caller.
 */
export function filterRowsByMembership<TRow>(
  rows: readonly TRow[],
  memberships: ReadonlyArray<RosterMembershipRef>,
  accountId: string,
  includeInactive: boolean,
  agentIdOf: (row: TRow) => unknown,
): RosterMembershipFilter<TRow> {
  /**
   * Every id is folded to lower case, on the way IN here and on the way out at
   * the lookup below.
   *
   * ── Why a Set of uuids needs normalising at all ────────────────────────────
   * The two sides of this comparison come from different places and only one of
   * them is guaranteed normalised. `memberships.user_id` is a Postgres `uuid`,
   * which the driver renders in canonical LOWER case whatever was inserted. The
   * row ids reach this function as plain strings in the handler's response body,
   * with nothing here that promises their case — so the same person's id in
   * upper case would be the same person to Postgres and a different string to a
   * JavaScript `Set`.
   *
   * That mismatch is invisible one layer up, which is what makes it worth this
   * comment: `findAnyByUsersAndTenant` casts to `::uuid[]`, so an UPPER-case id
   * matches its membership row in SQL and comes back lower case. The membership
   * therefore exists, was read, and was paid for — and was then missed here, and
   * the row was dropped as `unattributed_omitted`. A working colleague vanishes
   * from their supervisor's roster and the payload's own counter says they were
   * somebody nobody could account for.
   */
  const fold = (value: string): string => value.toLowerCase();
  const scopedAccount = fold(accountId);

  const everMember = new Set<string>();
  const activeMember = new Set<string>();
  for (const membership of memberships) {
    if (typeof membership.user_id !== 'string' || membership.user_id.length === 0) continue;
    const userId = fold(membership.user_id);
    everMember.add(userId);
    /**
     * "Still on the roster" is answered against the account this READ is scoped
     * to, not against the tenant.
     *
     * ── Narrower than "any active row in the tenant", and the read is why ────
     * Counting ANY active row in the tenant reasons that a person revoked from
     * one account and active in another has not left the company. True, and not
     * the question. `GET /agents/stats` is scoped to ONE account — a required
     * predicate, not an optional filter — so every row on the page is somebody's
     * work IN THIS ACCOUNT, and an agent revoked from this account while active
     * on another would be served as a current colleague of a supervisor who
     * cannot see the account they moved to. The supervisor's question is "who is
     * on my floor", and the answer must not be "somebody else's floor, also".
     *
     * A TENANT-LEVEL membership (`account_id IS NULL`) reaches every account by
     * design, so it counts here — that is not a special case, it is what a
     * tenant-level row means.
     *
     * Still ANY qualifying row rather than a fold over all of them: a person can
     * hold several memberships that reach this
     * account (a tenant-level one plus an account one), and the presence of an
     * active one decides it. An all-must-be-active fold would hide a working
     * colleague depending on row order.
     */
    const reachesThisAccount =
      membership.account_id === null
      || membership.account_id === undefined
      || fold(membership.account_id) === scopedAccount;
    if (membership.status === 'active' && reachesThisAccount) activeMember.add(userId);
  }

  const kept: TRow[] = [];
  let inactiveOmitted = 0;
  let unknownOmitted = 0;

  for (const row of rows) {
    const rawId = agentIdOf(row);
    if (typeof rawId !== 'string' || rawId.length === 0) {
      unknownOmitted += 1;
      continue;
    }
    const id = fold(rawId);
    if (!everMember.has(id)) {
      unknownOmitted += 1;
      continue;
    }
    if (activeMember.has(id) || includeInactive) {
      kept.push(row);
      continue;
    }
    inactiveOmitted += 1;
  }

  return { rows: kept, inactiveOmitted, unknownOmitted };
}

// ─── The GROUPED read's rows ────────────────────────────────────────────────

/**
 * One grouped row, as much of it as the public layer reads.
 *
 * The same narrowing rule as {@link RosterAgentRowRef}: the one member this
 * module's logic depends on, with the metrics carried through untouched by the
 * generic at the call site. `key` is typed `unknown` rather than as the
 * contract's `AgencyGroupKey` because nothing here reads any other member of it
 * and a fuller mirror here would be a second, drifting definition of a shape the
 * handler owns.
 */
export interface AgencyGroupRowRef {
  key?: unknown;
}

/**
 * Is the `agent` DIMENSION on this row's key — whatever the value turns out to
 * be?
 *
 * ── Why this is a separate predicate from {@link groupedRowAgentId} ──────────
 * The contract's row key holds a member **if and only if** its dimension is in
 * `group_by`, so "the key has an `agent_user_id` member" is this layer's
 * readable form of "`agent` was grouped". That is a question about the KEY'S
 * SHAPE, and answering it with the id EXTRACTOR instead — `rows.some((r) =>
 * groupedRowAgentId(r) !== null)` — conflates two different facts: was `agent`
 * grouped, and is this particular id usable.
 *
 * The two come apart on exactly the page that matters. A page whose only agent
 * keys are empty strings, nulls or numbers is agent-grouped with unusable ids;
 * asked through the extractor it looks NOT agent-grouped, takes the
 * pass-through branch, and is served **unfiltered with both omission counters
 * at 0** — every row about a person nobody could account for, under a payload
 * that states nothing was hidden. A sole `{ key: { agent_user_id: '' } }`
 * row must be dropped and counted as unattributed, and that is only reachable if
 * the branch is chosen on shape and the row is judged on value.
 *
 * `Object.hasOwn`, so a member that is present and wrong (`''`, `null`, `42`)
 * still counts as the dimension being grouped, and an inherited property does
 * not. Everything else about the path — `key` absent, null, a primitive, an
 * array — means no dimension at all.
 *
 * Reading this off the ROWS is what this layer can actually verify. The
 * alternatives are both worse: re-parsing the caller's `group_by` would mean
 * reimplementing the handler's comma splitting, whitelist and canonicalisation (a
 * second parser that drifts from the one that produced the rows), and trusting
 * the handler's echoed `group_by` would make the membership filter depend on a
 * field no row is keyed to.
 */
export function groupedRowHasAgentKey(row: AgencyGroupRowRef): boolean {
  const key = row.key;
  if (!key || typeof key !== 'object' || Array.isArray(key)) return false;
  return Object.hasOwn(key, 'agent_user_id');
}

/**
 * The agent id on a grouped row, or `null` when the row carries no usable one.
 *
 * The VALUE extractor, and only that: whether `agent` was grouped at all is
 * {@link groupedRowHasAgentKey}'s question, and the two must not be collapsed
 * back into one — see that function for the page a single predicate serves
 * unfiltered.
 *
 * Defensive about every step of the path (`key` absent, null, an array, a
 * non-string or empty id) because this function sees the handler's body as
 * untyped JSON — nothing here can promise the shape. A `null` from here on an
 * agent-grouped page is not "not about a person"; it is "about a person nobody
 * can name", which is the membership filter's third state and a dropped row.
 */
export function groupedRowAgentId(row: AgencyGroupRowRef): string | null {
  const key = row.key;
  if (!key || typeof key !== 'object' || Array.isArray(key)) return null;
  const id = (key as Record<string, unknown>)['agent_user_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Put `agent_name` beside the `key.agent_user_id` on a page of GROUPED rows.
 *
 * ── Why not {@link enrichAttemptAgentNames} ────────────────────────────────
 * That one reads `row.agent_user_id`, which a grouped row does not have — the id
 * is one level down, inside `key`. Handed a grouped page it would find no ids,
 * resolve nothing and set `agent_name: null` on every row: the failure mode that
 * ships looking like it works, which is the same reason
 * {@link enrichAgentStatsIdentity} exists for the per-agent document shape.
 * `agent_name` stays at the ROW level rather than inside `key`, because `key` is
 * the grouping identity the handler computed and a name looked up here is not
 * part of it.
 *
 * Same rules as every other enrichment on this feature: one query for the whole
 * page (both lookups behind {@link resolveAgentNames} de-duplicate their input,
 * which matters here in a way it does not on the roster — an `agent,campaign`
 * page repeats each agent once per campaign); the body is SPREAD, never rebuilt;
 * the KEY is produced on every row even when the lookup fails, because an absent
 * key is indistinguishable from one a client forgot to read while `null` is an
 * answer; and a failed lookup degrades rather than failing the read.
 *
 * Called only on the agent-grouped branch, which is what makes `agent_name`
 * present *iff* `agent` was grouped. A body with no `rows` array is returned by
 * reference.
 *
 * Narrowed with {@link pageRows} and deliberately NOT with `asSpinePage`: this
 * function reads `rows` and nothing else, and `asSpinePage` refuses a body over
 * `next_cursor`/`limit` — paging fields a grouped page does not even carry. Under
 * that narrowing a page carrying a STRING `limit` would come back with no
 * `agent_name` key at all, on the branch whose entire contract is that the key is
 * always present.
 */
export async function enrichGroupedRowAgentNames(
  body: unknown,
  tenantId: string,
  resolveNames: (ids: readonly string[], tenantId: string) => Promise<Map<string, string | null>>,
  onError?: (err: unknown) => void,
): Promise<unknown> {
  const rows = pageRows<AgencyGroupRowRef & Record<string, unknown>>(body);
  if (!rows) return body;

  const ids = rows
    .map((row) => groupedRowAgentId(row))
    .filter((id): id is string => id !== null);

  let names = new Map<string, string | null>();
  if (ids.length > 0) {
    try {
      names = await resolveNames(ids, tenantId);
    } catch (err) {
      onError?.(err);
    }
  }

  return {
    ...(body as Record<string, unknown>),
    rows: rows.map((row) => {
      const id = groupedRowAgentId(row);
      return { ...row, agent_name: id === null ? null : names.get(id) ?? null };
    }),
  };
}
