import type { PoolClient } from 'pg';
import { getPool } from '../connection.js';
import type { MembershipRecord, CreateMembershipInput, MembershipRole } from '../models/membership.model.js';

/**
 * Outcome of a write guarded by {@link MembershipRepository.withLastOwnerGuard}.
 * `role_changed` means the membership was promoted or demoted between the
 * caller's RBAC check and the write, so that check no longer applies.
 */
export type LastOwnerGuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'role_changed' | 'last_owner' };

/**
 * Declared here rather than imported from a feature module, for the reason
 * `userRepository`'s identical constant gives: the DB layer does not depend
 * upward. See {@link MembershipRepository.findAnyByUsersAndTenant} for why this
 * layer needs it at all.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * The user fields `GET /tenants/:id/members` needs, plus the one it must never
 * serve.
 *
 * `firebase_uid` is here because `deriveMembershipInviteState` reads it,
 * and for no other reason. The ticket forbids putting it — or the
 * `pending_<uuid>` stub it may hold — on the wire, so the route names the four
 * fields it serves rather than spreading this object.
 */
export interface TenantMemberUser {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  firebase_uid: string;
}

/**
 * One active member of a tenant, with their identity row. Produced by
 * {@link MembershipRepository.findByTenantIdWithUser}.
 */
export interface TenantMemberWithUser {
  membership: MembershipRecord;
  /**
   * `null` when the member's `users` row is missing.
   *
   * Unreachable while `memberships.user_id` stays `NOT NULL REFERENCES
   * users(id) ON DELETE CASCADE` (migration 001) — a membership cannot outlive
   * its user. The LEFT JOIN and this arm are what keep a relaxed FK from
   * silently dropping a member off their own tenant's Team page rather than
   * showing them with no identity; the route has always carried the shape.
   */
  user: TenantMemberUser | null;
}

/**
 * The raw joined row, before it is split into {@link TenantMemberWithUser}.
 *
 * The user columns are aliased `u_*` rather than left bare so `m.*` can stay a
 * wildcard: `id`, `status`, `created_at` and `updated_at` all exist on both
 * sides of the join, and the membership half is what the response spreads
 * verbatim. The prefix is short and deliberately unlike anything in
 * `memberships`, since a future column of the same name there would shadow it
 * silently.
 */
type TenantMemberRow = MembershipRecord & {
  u_id: string | null;
  u_email: string | null;
  u_display_name: string | null;
  u_avatar_url: string | null;
  u_firebase_uid: string | null;
};

export class MembershipRepository {
  async create(
    input: CreateMembershipInput,
    options: { requireProvenEmail?: string } = {},
  ): Promise<MembershipRecord | null> {
    const pool = getPool();

    /**
     * ── `requireProvenEmail` is a RACE guard, not a second permission check ──
     * The by-address reuse paths resolve a typed-in address to a row and then
     * attach authority to it, and those are two statements. In between, a
     * concurrent `POST /invites/:token/claim` can bind an identity to that very
     * row — so the predicate held when the row was READ and not when it was
     * USED, and the membership lands on a row that is now somebody else's. That
     * is the original takeover reached through an interleaving rather than
     * through a missing check.
     *
     * The CTE closes it by doing both in ONE statement: `FOR UPDATE` blocks
     * while a concurrent bind is in flight and, when it unblocks, Postgres
     * re-evaluates the qual against the NEW row version — a row the claim just
     * changed no longer matches, the CTE yields nothing, and the INSERT writes
     * nothing rather than writing onto it. A zero-row result is therefore
     * "somebody bound this address while we were deciding", which the caller
     * answers the same way it answers finding the row already unusable.
     *
     * ── The option is the ADDRESS, and a flag-only recheck missed half of it ──
     * The value is the address the caller resolved this row BY, and the guard
     * asserts the row still keys under it. Rechecking `email_unverified` alone
     * covered only the UNVERIFIED claim, and the claim path deliberately
     * accepts a verified address that differs from the invited one: that arm
     * takes `adoptEmail`'s proven branch, which REWRITES `users.email` to the
     * claimant's own address and sets the flag to `false`. So the row the
     * invite resolved as `victim@corp.test` could become the claimant's,
     * keyed under the claimant's address, with the flag clear — and a
     * flag-only CTE saw nothing wrong and attached the membership to it. The
     * follow-up re-read never ran, because the INSERT succeeded.
     *
     * Equality rather than `lower(btrim(...))` deliberately: this must be the
     * SAME comparison `resolveByProvenEmail` used to pick the row, or the guard
     * can pass on a row that lookup would never have returned.
     *
     * Off by default: every other caller either creates its own user row in the
     * same breath or is not address-keyed at all, and a lock nobody needs is a
     * lock somebody eventually waits behind.
     */
    if (options.requireProvenEmail !== undefined) {
      const guarded = await pool.query<MembershipRecord>(
        `WITH proven AS (
           SELECT id FROM users
            WHERE id = $1
              AND email = $6
              AND email_unverified = false
            FOR UPDATE
         )
         INSERT INTO memberships (user_id, tenant_id, account_id, role, invited_by)
         SELECT $1, $2, $3, $4, $5 FROM proven
         RETURNING *`,
        [
          input.user_id,
          input.tenant_id,
          input.account_id || null,
          input.role,
          input.invited_by || null,
          options.requireProvenEmail,
        ],
      );
      return guarded.rows[0] || null;
    }

    const result = await pool.query<MembershipRecord>(
      `INSERT INTO memberships (user_id, tenant_id, account_id, role, invited_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.user_id, input.tenant_id, input.account_id || null, input.role, input.invited_by || null],
    );
    return result.rows[0]!;
  }

  /**
   * One membership by id, scoped to a tenant.
   *
   * ── There is deliberately no unscoped `findById` sibling ───────────────────
   * `accountRepository` keeps one, for the super-admin tree and the name
   * resolver. Nothing here needs one, and adding it would be an invitation to
   * fetch-then-check. The boundary belongs in the same statement as the lookup —
   * CLAUDE.md's RBAC rule 1, and the reason `accountRepository.findByIdInTenant`
   * exists at all: a fetch-then-compare is a read and a check that can disagree,
   * and it materialises a foreign tenant's row into this process before refusing
   * it, after which the next reader adds a log line or an error message over a
   * row that was never theirs to see.
   *
   * Both callers take a `membership_id` from an untrusted place. `POST
   * /invites/resend` takes it from a request body; `POST /invites/:token/claim`
   * takes it from an invite row and pairs it with that row's OWN `tenant_id`, so
   * a membership that had somehow been re-pointed cannot carry a claim across a
   * tenant boundary. Both answer 404 on a miss, so a foreign id and a
   * nonexistent one stay indistinguishable — structurally, since both are one
   * `null` here and there is no second branch that could drift.
   *
   * `status = 'active'` matches the other lookups on this repository, and on the
   * claim path it is load-bearing rather than conventional: offboarding
   * (`DELETE /users/:id/membership`) sets `status = 'revoked'` and touches
   * nothing in `membership_invites`, so this predicate is the only thing that
   * stops an outstanding invitation from binding an identity to a membership
   * that no longer grants anything.
   */
  async findByIdInTenant(id: string, tenantId: string): Promise<MembershipRecord | null> {
    const pool = getPool();
    const result = await pool.query<MembershipRecord>(
      `SELECT * FROM memberships WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [id, tenantId],
    );
    return result.rows[0] || null;
  }

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord[]> {
    const pool = getPool();
    const result = await pool.query<MembershipRecord>(
      // Ordered so "the first row" means something. `tenantContextMiddleware`
      // falls back to one of these when no X-Account-Id is sent, and without an
      // ORDER BY that choice was heap order — a user holding two account-scoped
      // memberships could resolve to a different account from one request (or
      // one cache refresh) to the next. `selectMembership` re-applies the same
      // order in code, because arrays already sitting in the membership cache
      // predate this clause.
      `SELECT * FROM memberships
        WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'
        ORDER BY created_at ASC, id ASC`,
      [userId, tenantId],
    );
    return result.rows;
  }

  /**
   * Every membership this user has EVER held in this tenant — `revoked` and
   * `inactive` rows included.
   *
   * ── Why the status-filtered sibling is the wrong lookup for a HISTORY read ──
   * {@link findByUserAndTenant} answers "what may this person do here", so it
   * filters `status = 'active'` and every authorization caller wants that. The
   * supervisory agent-record routes ask a different question — "was this person
   * ever one of ours" — and offboarding sets `status = 'revoked'`. Asked through
   * the active-only lookup, a departed agent's record therefore answered *"That
   * user is not a member of this workspace"*, which is precisely the dispute case
   * the surface is justified by: the numbers are read AFTER somebody leaves, not
   * while they are still on the roster.
   *
   * ── It is still a TENANT boundary, not an absence of one ───────────────────
   * The `tenant_id` predicate is in the same statement as the read (rule 1 of
   * CLAUDE.md's RBAC section), so a user who was never in this tenant still
   * resolves to nothing and the caller still answers 404. What is dropped is the
   * status filter and nothing else — the same deliberate choice, for the same
   * reason and in the same words, as `userRepository.findDisplayNamesInTenant`:
   * *a revoked membership still means this person was legitimately in this
   * tenant, and the predicate exists to stop reads crossing a tenant boundary,
   * which a revoked membership does not do.*
   *
   * A SECOND method rather than a flag on the first, following the precedent
   * `agencyCampaignAgentRepository.listAllForUser` sets over `listActiveForUser`:
   * every existing caller of the active-only lookup is an authorization decision
   * and would be WRONG with more rows, so the distinction belongs in the name
   * rather than one wrong argument away.
   */
  async findAnyByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord[]> {
    const pool = getPool();
    const result = await pool.query<MembershipRecord>(
      `SELECT * FROM memberships WHERE user_id = $1 AND tenant_id = $2`,
      [userId, tenantId],
    );
    return result.rows;
  }

  /**
   * The SET form of {@link findAnyByUserAndTenant} — every membership, of every
   * status, that any of these users has ever held in this tenant. One query for a
   * whole page of ids.
   *
   * ── Why a set-shaped sibling exists at all ─────────────────────────────────
   * The supervisory ROSTER read (`GET /proxy/agency/agents/stats`) gets its rows
   * from core, which has no user table and therefore returns **every** agent who
   * dialled in the window — including one whose membership has since been
   * revoked, because it cannot know (design D3, `agency_agent_sessions.agent_user_id`
   * has no FK). Master decides which of those rows survive, and that decision
   * needs the status of up to `limit` (200) memberships at once. Asked through
   * {@link findAnyByUserAndTenant} it would be one query per row — the "no
   * per-item loops over I/O" rule in CLAUDE.md, and the same N+1
   * `userRepository.findDisplayNamesInTenant` was introduced to avoid.
   *
   * ── Status is RETURNED, not filtered ──────────────────────────────────────
   * The caller needs all three answers apart: `active` (a current member),
   * `revoked`/`inactive` (departed — a row to drop or keep depending on
   * `include_inactive`), and **no row at all** (never in this tenant — a row that
   * must not be shown under any flag). A status predicate here would collapse the
   * last two into one, which is precisely the distinction the filter is made of.
   * Same reasoning as {@link findAnyByUserAndTenant}, one cardinality up.
   *
   * ── Still a tenant boundary, and non-UUIDs never reach the cast ────────────
   * `tenant_id` is in the same statement as the read (rule 1 of CLAUDE.md's RBAC
   * section), so a user who was never in this tenant resolves to nothing here and
   * the caller drops their row. The ids come from CORE's response body, where
   * `agent_user_id` is an opaque string with no FK behind it — so a malformed one
   * is reachable, and it would raise Postgres `22P02` from inside
   * `= ANY($1::uuid[])`, which `errorMaskHook` turns into "contact support". They
   * are filtered in JS instead, exactly as `userRepository.findDisplayNamesInTenant`
   * does, and the caller then sees them as "no membership row" — which is the
   * truth about an id that cannot be a user id.
   */
  async findAnyByUsersAndTenant(
    userIds: readonly string[],
    tenantId: string,
  ): Promise<MembershipRecord[]> {
    const candidates = [...new Set(userIds)].filter(isUuid);
    if (candidates.length === 0 || !isUuid(tenantId)) return [];

    const pool = getPool();
    const result = await pool.query<MembershipRecord>(
      `SELECT * FROM memberships WHERE user_id = ANY($1::uuid[]) AND tenant_id = $2::uuid`,
      [candidates, tenantId],
    );
    return result.rows;
  }

  async findByTenantId(tenantId: string): Promise<MembershipRecord[]> {
    const pool = getPool();
    const result = await pool.query<MembershipRecord>(
      `SELECT * FROM memberships WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows;
  }


  /**
   * The tenant's active members joined to their `users` rows — in ONE statement.
   *
   * ── Why this is a second method rather than a flag on {@link findByTenantId} ─
   * It is a genuinely different query — `LEFT JOIN users` — answering the
   * narrower question `GET /tenants/:id/members` asks, and a flag would put that
   * decision one wrong argument away from every caller of the plain lookup. Same
   * reasoning {@link findAnyByUserAndTenant} gives for being a second method.
   *
   * Worth knowing rather than assuming: `GET /tenants/:id/members` was
   * {@link findByTenantId}'s only production caller, so that method is now
   * reached from its own repository test alone. It is deliberately left in place
   * — removing an exported repository method is a separate change from this one
   * — but do not read its continued existence as evidence that something needs
   * the unjoined shape.
   *
   * ── It closes an N+1 ──────────────────────────────────────────────────────
   * The route used to do `Promise.all(memberships.map(m => userRepository
   * .findById(m.user_id)))` — one round trip per member, on a page a supervisor
   * opens to look at their whole floor. It collapses into the join here; see
   * CLAUDE.md's "No per-item loops over I/O".
   *
   * ── What is preserved exactly ─────────────────────────────────────────────
   * `status = 'active'` and `ORDER BY created_at DESC` are the filter and the
   * ordering `findByTenantId` has always applied, and — when `accountId` is
   * omitted — the response is the same list in the same order. `m.*` rather than an enumerated column list, so a
   * future `memberships` column keeps reaching the response body — the handler
   * spreads this row verbatim.
   *
   * The `ORDER BY` is qualified `m.created_at` because that is what this method
   * means, not because an unqualified one would fail: `ORDER BY` resolves
   * against OUTPUT column names first, and the select list exposes exactly one
   * `created_at` (the membership's, via `m.*`), so `ORDER BY created_at` runs
   * today. It becomes genuinely ambiguous the moment somebody adds `u.created_at`
   * or `u.*` to the select list — which is precisely why it is qualified now.
   *
   * ── `firebase_uid` comes back, and must not go out ────────────────────────
   * It is here for one consumer, `deriveMembershipInviteState`, and for nothing
   * else. The route names the four user fields it serves rather than spreading
   * this object, so the uid — stub or real — cannot reach the browser by
   * omission.
   *
   * ── `accountId` confines the roster to ONE account ────────────────────────
   * Passed by the route when the CALLER's own membership is account-scoped.
   * Without it an account-scoped `viewer` of account A (`tenant.read` floors at
   * `viewer`) received every active member of the tenant — sibling accounts'
   * emails, display names, roles and `account_id`s — the same enumeration
   * `GET /accounts` was already confined against. The predicate is an
   * EQUALITY, not `IS NULL OR =`: tenant-wide members (`account_id IS NULL`)
   * are deliberately NOT served to an account-scoped caller, matching
   * `dncRepository.deleteById`'s and `closeAllForUser`'s scoped branches and
   * `user.routes.ts`, where an account-scoped admin cannot manage a
   * tenant-level row either. `NULL = $2` is never true in SQL, so this needs
   * no extra clause. Omitted (a tenant-wide caller) ⇒ the whole roster,
   * exactly as before.
   */
  async findByTenantIdWithUser(
    tenantId: string,
    accountId?: string,
  ): Promise<TenantMemberWithUser[]> {
    const pool = getPool();
    const params: string[] = [tenantId];
    let accountClause = '';
    if (accountId !== undefined) {
      params.push(accountId);
      accountClause = ' AND m.account_id = $2';
    }
    const result = await pool.query<TenantMemberRow>(
      `SELECT
         m.*,
         u.id           AS u_id,
         u.email        AS u_email,
         u.display_name AS u_display_name,
         u.avatar_url   AS u_avatar_url,
         u.firebase_uid AS u_firebase_uid
       FROM memberships m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND m.status = 'active'${accountClause}
       ORDER BY m.created_at DESC`,
      params,
    );

    return result.rows.map((row) => {
      const {
        u_id,
        u_email,
        u_display_name,
        u_avatar_url,
        u_firebase_uid,
        ...membership
      } = row;

      return {
        membership,
        // `u_id` is NULL for exactly one reason — the LEFT JOIN found no user
        // row — so it is what decides the null arm, never `u_email`, which a
        // present row could in principle carry empty.
        user:
          u_id === null
            ? null
            : {
              id: u_id,
              email: u_email!,
              display_name: u_display_name!,
              avatar_url: u_avatar_url!,
              firebase_uid: u_firebase_uid!,
            },
      };
    });
  }

  async findByAccountId(accountId: string): Promise<MembershipRecord[]> {
    const pool = getPool();
    const result = await pool.query<MembershipRecord>(
      `SELECT * FROM memberships WHERE account_id = $1 AND status = 'active' ORDER BY created_at DESC`,
      [accountId],
    );
    return result.rows;
  }

  async findAllByUserId(userId: string): Promise<MembershipRecord[]> {
    const pool = getPool();
    const result = await pool.query<MembershipRecord>(
      `SELECT * FROM memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  /**
   * Flip a leftover `revoked`/`inactive` membership back to `active` with a
   * new role.
   *
   * Offboarding (`DELETE /users/:id/membership`) sets `status = 'revoked'`
   * rather than deleting the row, and tenant delete sets `'inactive'`. Unique
   * indexes still apply (`UNIQUE(user_id, tenant_id, account_id)` and
   * `idx_memberships_user_tenant_level` for `account_id IS NULL`), so a
   * subsequent INSERT of the same user+tenant is Postgres 23505, which
   * `errorMaskHook` rewrites into a generic duplicate-key 500.
   *
   * `status <> 'active'` is the predicate rather than an enumerated pair so an
   * already-active row is a miss (the caller 409s on that path itself) and a
   * concurrent reactivate of the same leftover still returns a row only to the
   * first writer.
   */
  async reactivateWithRole(
    id: string,
    role: MembershipRole,
    tenantId: string,
    options: { requireProvenEmail?: string } = {},
  ): Promise<MembershipRecord | null> {
    const pool = getPool();
    const client = await pool.connect();
    let rollbackFailed = false;
    try {
      await client.query('BEGIN');

      /**
       * The same race guard {@link create} carries, and it is needed here for
       * the same reason: reactivating a leftover membership attaches authority
       * to a user row that a concurrent invite claim may be rebinding right
       * now. Inside this transaction, so the lock is held until the reactivate
       * commits; a row that changed hands in the meantime yields no lock row
       * and the reactivate is abandoned rather than landing on a trap.
       *
       * Both halves of the predicate matter, for the reason {@link create}
       * spells out: the address, because a VERIFIED mismatched claim rewrites
       * `users.email` and leaves the flag clear, and the flag, because an
       * unverified one leaves the address alone and sets it.
       */
      if (options.requireProvenEmail !== undefined) {
        const proven = await client.query(
          `SELECT u.id
             FROM users u
             JOIN memberships m ON m.user_id = u.id
            WHERE m.id = $1
              AND u.email = $2
              AND u.email_unverified = false
            FOR UPDATE OF u`,
          [id, options.requireProvenEmail],
        );
        if (!proven.rows[0]) {
          await client.query('ROLLBACK');
          return null;
        }
      }

      const result = await client.query<MembershipRecord>(
        `UPDATE memberships
            SET status = 'active', role = $1
          WHERE id = $2 AND tenant_id = $3 AND status <> 'active'
          RETURNING *`,
        [role, id, tenantId],
      );
      const membership = result.rows[0];
      if (!membership) {
        await client.query('ROLLBACK');
        return null;
      }

      // Same statement as the reactivate. Claim treats a non-active membership
      // as revoked, so committing the role flip first would make a leftover
      // unclaimed token valid again until a later revoke — and non-agent
      // invites never write a replacement row that would supersede it.
      await client.query(
        `UPDATE membership_invites
            SET revoked_at = NOW()
          WHERE membership_id = $1
            AND tenant_id = $2
            AND claimed_at IS NULL
            AND revoked_at IS NULL`,
        [id, tenantId],
      );

      await client.query('COMMIT');
      return membership;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
      throw err;
    } finally {
      client.release(rollbackFailed ? true : undefined);
    }
  }

  /**
   * Unguarded role write. NOT for the tenant-facing routes — `PUT /users/:id/role`
   * must use {@link updateRoleGuardingLastOwner}, which makes the last-owner
   * check and the write one transaction. Pairing this with a separate
   * `countByTenantAndRole` read is the race that guard exists to close.
   */
  async updateRole(id: string, role: MembershipRole): Promise<MembershipRecord | null> {
    const pool = getPool();
    const result = await pool.query<MembershipRecord>(
      `UPDATE memberships SET role = $1 WHERE id = $2 RETURNING *`,
      [role, id],
    );
    return result.rows[0] || null;
  }

  /**
   * Unguarded revoke. NOT for the tenant-facing routes — see
   * {@link removeGuardingLastOwner}, and the note on {@link updateRole}.
   */
  async remove(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE memberships SET status = 'revoked' WHERE id = $1 AND status = 'active'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Demote or revoke a membership under a lock that makes the last-owner check
   * and the write ONE decision.
   *
   * The routes used to read the owner count and then write, which is two
   * statements and two snapshots: with two owners, a concurrent demotion of
   * each both read `count = 2`, both pass the guard, and the tenant is left
   * with zero owners. That is not a transient state — `updateRoleSchema` and
   * `inviteUserSchema` both exclude `tenant_owner`, so no customer-facing route
   * can put one back. It needs a super admin or a manual UPDATE.
   *
   * A single conditional UPDATE with a counting subquery does NOT fix it
   * (under READ COMMITTED both statements' subqueries still see the pre-image),
   * and having each statement lock its own target first deadlocks when two
   * owners are demoted at once. So: lock EVERY active owner row in the tenant
   * FIRST, in a fixed order, before reading anything. Two callers then queue,
   * and the second re-evaluates `role = 'tenant_owner'` against the first's
   * committed row (READ COMMITTED re-checks the predicate on a row it waited
   * for), sees one owner left, and refuses.
   *
   * `expectedRole` makes the whole thing a compare-and-swap: the caller checked
   * `canManageExistingRole` against the role it read outside this transaction,
   * so if the target has been promoted since, that check is stale and the write
   * must not land on the strength of it.
   *
   * Locking the owner rows on every role change serialises role changes per
   * tenant. They are rare admin operations; the last owner is not recoverable.
   */
  private async withLastOwnerGuard<T>(
    membershipId: string,
    tenantId: string,
    expectedRole: MembershipRole,
    write: (client: PoolClient, target: MembershipRecord) => Promise<T>,
  ): Promise<LastOwnerGuardResult<T>> {
    const pool = getPool();
    const client = await pool.connect();
    // Set when ROLLBACK itself fails; such a client may still hold an open
    // transaction, so it is destroyed rather than returned to the pool.
    let rollbackFailed = false;
    try {
      await client.query('BEGIN');

      // Every owner, locked, before the target is even read — see above. The
      // `ORDER BY id` is what keeps two concurrent callers from each holding
      // half the set and waiting on the other.
      const owners = await client.query<{ id: string }>(
        `SELECT id FROM memberships
          WHERE tenant_id = $1 AND role = 'tenant_owner' AND status = 'active'
          ORDER BY id
          FOR UPDATE`,
        [tenantId],
      );

      const found = await client.query<MembershipRecord>(
        `SELECT * FROM memberships
          WHERE id = $1 AND tenant_id = $2 AND status = 'active'
          FOR UPDATE`,
        [membershipId, tenantId],
      );
      const target = found.rows[0];

      if (!target) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      if (target.role !== expectedRole) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'role_changed' };
      }
      if (target.role === 'tenant_owner' && (owners.rowCount ?? 0) <= 1) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'last_owner' };
      }

      const value = await write(client, target);
      await client.query('COMMIT');
      return { ok: true, value };
    } catch (err) {
      // Guarded for the same reason as `agencyCampaignAgentRepository.assign`:
      // an unguarded ROLLBACK would replace the original error with its own and
      // still hand a possibly-open transaction back to the pool.
      try {
        await client.query('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
      throw err;
    } finally {
      client.release(rollbackFailed ? true : undefined);
    }
  }

  /** Demote a membership, refusing to leave the tenant with no owner. */
  async updateRoleGuardingLastOwner(
    membershipId: string,
    tenantId: string,
    expectedRole: MembershipRole,
    role: MembershipRole,
  ): Promise<LastOwnerGuardResult<MembershipRecord>> {
    return this.withLastOwnerGuard(membershipId, tenantId, expectedRole, async (client, target) => {
      const result = await client.query<MembershipRecord>(
        `UPDATE memberships SET role = $1 WHERE id = $2 RETURNING *`,
        [role, target.id],
      );
      return result.rows[0]!;
    });
  }

  /** Revoke a membership, refusing to leave the tenant with no owner. */
  async removeGuardingLastOwner(
    membershipId: string,
    tenantId: string,
    expectedRole: MembershipRole,
  ): Promise<LastOwnerGuardResult<true>> {
    return this.withLastOwnerGuard(membershipId, tenantId, expectedRole, async (client, target) => {
      await client.query(
        `UPDATE memberships SET status = 'revoked' WHERE id = $1 AND status = 'active'`,
        [target.id],
      );
      return true as const;
    });
  }

  /**
   * A point-in-time count. Safe for reporting; NOT safe as the guard on a write
   * that follows it — see {@link updateRoleGuardingLastOwner}.
   */
  async countByTenantAndRole(tenantId: string, role: MembershipRole): Promise<number> {
    const pool = getPool();
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memberships WHERE tenant_id = $1 AND role = $2 AND status = 'active'`,
      [tenantId, role],
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }
}

export const membershipRepository = new MembershipRepository();
