import type { PoolClient } from 'pg';
import { getPool } from '../connection.js';
import type { UserRecord, CreateUserInput } from '../models/user.model.js';

/**
 * What an address resolves to for a caller about to attach authority to it.
 * `unproven_conflict` is a REFUSAL, never a "write a stub" — see
 * {@link UserRepository.resolveByProvenEmail}.
 */
export type ProvenEmailResolution =
  | { status: 'found'; user: UserRecord }
  | { status: 'none' }
  | { status: 'unproven_conflict' };

/**
 * Declared here rather than imported from `src/agency/agency-billing-contract.ts`
 * so the DB layer does not depend upward on a feature module.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export class UserRepository {
  async create(input: CreateUserInput): Promise<UserRecord> {
    const pool = getPool();
    const result = await pool.query<UserRecord>(
      `INSERT INTO users (firebase_uid, email, phone_number, display_name, avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.firebase_uid, input.email, input.phone_number || '0000000000', input.display_name || null, input.avatar_url || null],
    );
    return result.rows[0]!;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const pool = getPool();
    const result = await pool.query<UserRecord>(
      `SELECT * FROM users WHERE id = $1`,
      [id],
    );
    return result.rows[0] || null;
  }

  async findByFirebaseUid(firebaseUid: string): Promise<UserRecord | null> {
    const pool = getPool();
    const result = await pool.query<UserRecord>(
      `SELECT * FROM users WHERE firebase_uid = $1`,
      [firebaseUid],
    );
    return result.rows[0] || null;
  }

  /**
   * Resolve an address to a row, for a caller that has PROVEN the address.
   *
   * `POST /auth/session` path 2/3 is the only such caller: `sessionLinkEmail`
   * has already refused anything but `email_verified === true`, so whoever is
   * asking controls that inbox and is entitled to whatever row keys under it —
   * including one an earlier unverified invite claim flagged
   * (`email_unverified`), which the adopt then CLEARS. That repair is the whole
   * reason this method does not filter the flag.
   *
   * ── Every other caller wants {@link findByProvenEmail} ────────────────────
   * `users.email` carries only a NON-unique index (`001_initial_schema.sql:60`)
   * and duplicates are a shape the schema permits, so this is not a unique
   * lookup and never has been. The ORDER BY makes "whichever row Postgres hands
   * back first" deterministic and puts the trustworthy row first: a flagged row
   * and a clean stub for one address is exactly what happens after an attacker
   * poisons an address and an honest invite then writes a fresh stub beside it
   * (migration 073), and the person arriving with a verified token for that
   * address wants the stub, not the trap.
   *
   * Note which repair this is and is not. Adopting here clears the flag on the
   * row it lands on, so a verified sign-in that REACHES path 2 repairs it. The
   * commoner flagged row never reaches path 2 at all — the claim already wrote
   * that person's `firebase_uid`, so they resolve at path 1 forever — and
   * {@link clearEmailUnverifiedIfProven} is what repairs those. Two branches,
   * two repairs, because there are two ways to arrive holding proof.
   */
  async findByEmail(email: string): Promise<UserRecord | null> {
    const pool = getPool();
    const result = await pool.query<UserRecord>(
      `SELECT * FROM users
        WHERE email = $1
        ORDER BY email_unverified ASC, created_at ASC
        LIMIT 1`,
      [email],
    );
    return result.rows[0] || null;
  }

  /**
   * Resolve an address to a row for a caller that is about to ATTACH AUTHORITY
   * to it — `POST /users/invite` and the super-admin tenant-create/add-user
   * paths, all three through THIS method. The two super-admin callers pass
   * their provisioning transaction's client; they used to run a hand-copied
   * statement instead, and a mutation dropping the flag predicate from either
   * copy failed zero tests anywhere, because the test that appeared to cover
   * them ran its own third copy of the SQL from the test body.
   *
   * These callers have proven nothing: the address is a string somebody typed
   * into a form. Reuse is still right for the ordinary row, because it is what
   * makes one person invited by two workspaces one person rather than two. What
   * it must not do is reuse a row whose address an identity was bound to
   * WITHOUT proving — the attacker registers an unverified Firebase account for
   * `victim@corp.test`, invites it into their own tenant as an `agent`, reads
   * the join link out of their own 201, claims it, and then waits for an honest
   * admin (or a super admin provisioning the real customer) to name that
   * address and hand them the membership. Migration 073 has the full chain.
   *
   * ── Three outcomes, not two, and the third is why this is not a plain find ──
   * A miss can mean two very different things, and collapsing them produced an
   * unclaimable row:
   *
   *  - `none` — nothing keys under this address. Write a fresh stub.
   *  - `unproven_conflict` — rows exist and EVERY one of them is flagged. A
   *    flagged row is always BOUND (only `adoptFirebaseIdentity` sets the flag,
   *    and it binds), so the identity behind it already holds this address's
   *    only `users` row. Writing a fresh stub beside it looks right and is a
   *    trap: `firebase_uid` is `TEXT NOT NULL UNIQUE`, so when that same person
   *    claims the new invitation the bind raises `23505` and the route answers
   *    `identity_in_use` — the membership is stranded on a row nobody can ever
   *    activate, and nothing reports it. The caller must REFUSE instead, and
   *    say what unblocks it: the account holder signs in with a verified token
   *    once (`/auth/session` path 1 clears the flag) and the invitation works.
   *  - `found` — an unflagged row. Reuse it, exactly as before.
   *
   * Note which way this leans. A fresh stub IS right when the flagged row
   * belongs to somebody else — two principals sharing a string, which
   * `users.email` has always permitted — and that case still works, because
   * the other person's claim carries a DIFFERENT uid and hits no constraint.
   * The refusal exists for the case where it is the same person, which is the
   * only case that cannot be repaired after the fact.
   *
   * ── `lock` is what makes the answer survive until the caller writes ────────
   * Without it this is a snapshot read: a clean stub is returned here, a claim
   * binds an unverified identity to it and flags it, and the caller then
   * attaches the membership to a row that is now a trap — the predicate held
   * when it was read and not when it was used. `FOR UPDATE` holds every row
   * for the address until the caller's transaction commits, so a concurrent
   * bind blocks rather than racing. It requires a `client`, because a lock
   * taken on a pooled connection with no transaction is released immediately
   * and would be pure theatre.
   */
  async resolveByProvenEmail(
    email: string,
    options: { client?: PoolClient; lock?: boolean } = {},
  ): Promise<ProvenEmailResolution> {
    const { client, lock = false } = options;
    if (lock && !client) {
      throw new Error('resolveByProvenEmail: lock requires a transaction client');
    }
    const executor = client ?? getPool();
    const result = await executor.query<UserRecord>(
      `SELECT * FROM users
        WHERE email = $1
        ORDER BY email_unverified ASC, created_at ASC${lock ? '\n        FOR UPDATE' : ''}`,
      [email],
    );

    const first = result.rows[0];
    // Ordered flag-ascending, so an unflagged row is row 0 when one exists.
    if (first && first.email_unverified === false) return { status: 'found', user: first };
    if (first) return { status: 'unproven_conflict' };
    return { status: 'none' };
  }

  /**
   * The `found`-or-null convenience over {@link resolveByProvenEmail}, for a
   * caller that only reads and attaches nothing — it cannot distinguish the
   * two miss cases and must not be used where a stub would be written.
   */
  async findByProvenEmail(email: string, client?: PoolClient): Promise<UserRecord | null> {
    const resolved = await this.resolveByProvenEmail(email, { client });
    return resolved.status === 'found' ? resolved.user : null;
  }

  /**
   * Clear `email_unverified` for a caller that has just PROVED the row's own
   * address — `POST /auth/session` path 1, and nowhere else.
   *
   * ── Why this method has to exist ──────────────────────────────────────────
   * Migration 073 flags a row whose identity was bound without proving its
   * address, and the flag bars the row from every by-address reuse path. The
   * repair was documented as "the rightful owner signing in repairs the row on
   * the way in" — through `adoptFirebaseIdentity`, which sets the column. That
   * repair was UNREACHABLE for the population that gets flagged:
   *
   *   1. The common flagged shape is an email/password account created on the
   *      join page and claimed while Firebase still reports
   *      `email_verified: false`. The bind leaves the row holding THAT PERSON'S
   *      `firebase_uid`.
   *   2. Every later sign-in therefore resolves at path 1
   *      (`findByFirebaseUid`), which returns the session payload and never
   *      calls `adoptFirebaseIdentity` at all.
   *   3. So verifying the address in Firebase changed nothing here, and the
   *      flag was permanent — silently, with no operator remedy anywhere.
   *
   * What that cost is not cosmetic: `firebase_uid` is `TEXT NOT NULL UNIQUE`
   * (`001_initial_schema.sql:51`), so a second workspace inviting the flagged
   * address missed on {@link findByProvenEmail}, wrote a DUPLICATE stub, and
   * then could never bind it — `agent` invites died on `23505` →
   * `identity_in_use`, and every other role activates through path 2, which a
   * uid-bearing row can no longer reach. Multi-workspace onboarding was broken
   * for the majority of claimants.
   *
   * ── Why the address predicate is IN the statement ─────────────────────────
   * Reading the row and then deciding in TypeScript is a read and a write that
   * can disagree; this is one statement, so the row can only lose its flag in
   * the same instant it is proved. `email_unverified` stays a conjunct too, so
   * a row that was never flagged is not needlessly written on every sign-in.
   *
   * The comparison is `lower(btrim(...))` on both sides while
   * `idx_users_email`'s lookups are a case-sensitive `=`. That asymmetry is
   * deliberate and only ever narrows: clearing the flag on a row whose stored
   * spelling differs in case from the proven token makes that row findable by
   * its OWN stored spelling, which the person demonstrably controls. It cannot
   * make a row findable under an address nobody proved.
   */
  async clearEmailUnverifiedIfProven(
    userId: string,
    provenEmail: string,
  ): Promise<UserRecord | null> {
    const pool = getPool();
    const result = await pool.query<UserRecord>(
      `UPDATE users
          SET email_unverified = false
        WHERE id = $1
          AND email_unverified = true
          AND lower(btrim(email)) = lower(btrim($2))
      RETURNING *`,
      [userId, provenEmail],
    );
    return result.rows[0] || null;
  }

  /**
   * Resolve a SET of user ids to display names, scoped to one tenant — one
   * query, never one per id.
   *
   * ── Why this is set-shaped and not a loop over `findById` ──────────────────
   * Its only caller is the agency supervisor dashboard's stats hop, which the console
   * polls every 5 seconds and which carries the whole live floor. A per-row
   * lookup there is an N+1 on the hot path — 30 agents on shift is 30 serial
   * round trips per poll, per open dashboard. Per-item loops over I/O are
   * not allowed.
   *
   * ── The tenant predicate is the security property, not an optimisation ─────
   * `agent_user_id` arrives from the dialer runtime, which holds no user table and does no
   * tenant checking of its own on this field — it is echoing back an id the public API layer
   * gave it at some point in the past. An unscoped `WHERE id = ANY(...)` would
   * therefore happily resolve an id belonging to another tenant and put that
   * person's name on this tenant's dashboard. This is the exact class of defect
   * tenancy rule describes: `requirePermission` proves the
   * caller's ROLE and never looks at the target row, so the tenant predicate has
   * to be in the same statement as the read.
   *
   * A missing id and a foreign id are deliberately indistinguishable — both are
   * simply absent from the result — for the same reason a cross-tenant miss
   * answers 404 rather than 403: anything else is a user-id oracle.
   *
   * Membership STATUS is deliberately not filtered. A revoked membership still
   * means this person was legitimately in this tenant, and the dialer runtime can still be
   * holding their live session row for the shift they were mid-way through; the
   * supervisor needs to see who that is. The predicate exists to stop names
   * crossing a tenant boundary, which a revoked membership does not do.
   *
   * `users.status = 'deleted'` IS excluded — a soft-deleted user is one the system
   * can no longer claim to identify.
   *
   * Ids that are not UUID-shaped are filtered out in JS rather than sent to
   * Postgres, which would raise `22P02` from inside the read and turn a
   * dashboard poll into a 500. Same trap `normalizeSettlementAccountId` documents
   * for `VARCHAR(100)` account ids.
   */
  async findDisplayNamesInTenant(
    userIds: readonly string[],
    tenantId: string,
  ): Promise<Map<string, string | null>> {
    const resolved = new Map<string, string | null>();

    const candidates = [...new Set(userIds)].filter(isUuid);
    if (candidates.length === 0 || !isUuid(tenantId)) return resolved;

    const pool = getPool();
    const result = await pool.query<{ id: string; display_name: string | null; email: string }>(
      `SELECT DISTINCT u.id, u.display_name, u.email
         FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE u.id = ANY($1::uuid[])
          AND m.tenant_id = $2::uuid
          AND u.status <> 'deleted'`,
      [candidates, tenantId],
    );

    for (const row of result.rows) {
      // `display_name` is nullable and a user who never set one is still RESOLVED
      // — a different fact from "cannot identify this person", which is
      // what a null answer means to the caller. Falling back to the email keeps
      // those two apart; collapsing them would make a missing profile field read
      // as a cross-tenant miss.
      const name = row.display_name?.trim();
      resolved.set(row.id, name && name.length > 0 ? name : row.email);
    }

    return resolved;
  }

  /**
   * Resolve a SET of user ids to name, email AND tenant role — one query, for the
   * agency campaign-staffing list.
   *
   * ── Why this is not {@link findDisplayNamesInTenant} with more columns ──────
   * That method answers "what do I call this person", and it deliberately folds a
   * missing `display_name` into the email so a caller cannot tell an unset profile
   * field from a cross-tenant miss. The staffing list needs the two SEPARATELY —
   * a supervisor picking between two people called "Sam" is disambiguating by
   * email — so folding them would destroy the distinction the screen exists to
   * make. Changing the existing method instead would change what its caller (the
   * 5-second stats poll) receives.
   *
   * ── Rows, not a map, and the reason is the ROLE ─────────────────────────────
   * A user can legitimately hold more than one membership in a tenant: an
   * account-scoped one per account, plus a tenant-level one (`account_id IS
   * NULL`, which reaches every account). So this returns one row per membership
   * and leaves the choice of which role to *report* to the caller, where
   * `ROLE_HIERARCHY` lives. Deciding it here would put an RBAC policy in the DB
   * layer and quietly pick whichever row Postgres returned first.
   *
   * Every security property of `findDisplayNamesInTenant` applies unchanged and
   * for the same reasons: the tenant predicate is in the same statement as the
   * read, non-UUID ids are filtered in JS rather than raising `22P02` from inside
   * the query, soft-deleted users are excluded, and membership STATUS is not
   * filtered — a revoked membership still means this person was legitimately in
   * this tenant, and a supervisor looking at a stale assignment needs to see who
   * it names.
   */
  async findIdentitiesInTenant(
    userIds: readonly string[],
    tenantId: string,
  ): Promise<Array<{ id: string; display_name: string | null; email: string; role: string }>> {
    const candidates = [...new Set(userIds)].filter(isUuid);
    if (candidates.length === 0 || !isUuid(tenantId)) return [];

    const pool = getPool();
    const result = await pool.query<{
      id: string;
      display_name: string | null;
      email: string;
      role: string;
    }>(
      `SELECT u.id, u.display_name, u.email, m.role
         FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE u.id = ANY($1::uuid[])
          AND m.tenant_id = $2::uuid
          AND u.status <> 'deleted'`,
      [candidates, tenantId],
    );

    return result.rows;
  }

  /**
   * Everybody who could be addressed about something that happened inside one
   * account — email plus the role each membership grants, one row per
   * membership.
   *
   * ── Rows and a ROLE, not a filtered list ───────────────────────────────────
   * The same argument as {@link findIdentitiesInTenant}: which roles are allowed
   * to hear about a thing is RBAC policy, and `PERMISSION_MATRIX` /
   * `ROLE_HIERARCHY` live in `src/rbac/`. A floor applied here would put that
   * policy in the DB layer, where the caller cannot see it and a second caller
   * with a different floor would have to add a second method.
   *
   * ── Two arms, because a tenant-level membership reaches every account ───────
   * `memberships.account_id IS NULL` is the tenant-wide form (`001`'s partial
   * unique index), and those people administer every account — so an
   * account-scoped notification legitimately reaches them. Omitting that arm
   * would silently skip the tenant owner on a single-account tenant, which is
   * the common shape.
   *
   * ── A non-UUID `accountId` NARROWS, and deliberately does not widen ─────────
   * The dialer's `account_id` is `VARCHAR(100)` with a `'default'` literal available
   * (migration 072), so a value arriving from a dialer webhook may not be
   * UUID-shaped at all — the trap `normalizeSettlementAccountId` exists for.
   * Passing it to Postgres raises `22P02` from inside the read; guessing "then
   * everyone in the tenant" would mail people who cannot see the account.
   * Undefined/unresolvable therefore means the tenant-level arm only, and the
   * caller can see the audience it got.
   *
   * `status = 'active'` here, unlike `findIdentitiesInTenant`: that method
   * answers "who was this", where a revoked membership is still the honest
   * answer, and this one answers "who should be told", where it is not.
   *
   * ── And the same rule on the USER, not only on the membership ───────────────
   * `u.status = 'active'`, not `u.status <> 'deleted'`. The looser predicate was
   * carried over from {@link findIdentitiesInTenant}, where it belongs — an
   * `inactive` user is still who a stale assignment names — and here it mailed
   * suspended accounts. The distinction this docstring already draws settles it:
   * "who should be told" is a question about a mailbox somebody is expected to be
   * reading, and `inactive` is the system's own record that they are not.
   */
  async findAddressableMembersInAccount(
    tenantId: string,
    accountId?: string | null,
  ): Promise<Array<{ email: string; role: string }>> {
    if (!isUuid(tenantId)) return [];
    const scopedAccountId = isUuid(accountId) ? accountId : null;

    const pool = getPool();
    const result = await pool.query<{ email: string; role: string }>(
      `SELECT DISTINCT u.email, m.role
         FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE m.tenant_id = $1::uuid
          AND m.status = 'active'
          AND u.status = 'active'
          AND (m.account_id IS NULL OR m.account_id = $2::uuid)`,
      [tenantId, scopedAccountId],
    );

    return result.rows;
  }

  async update(id: string, fields: Partial<Pick<UserRecord, 'display_name' | 'avatar_url' | 'phone_number' | 'status'>>): Promise<UserRecord | null> {
    const pool = getPool();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (fields.display_name !== undefined) {
      setClauses.push(`display_name = $${paramIndex++}`);
      values.push(fields.display_name);
    }
    if (fields.avatar_url !== undefined) {
      setClauses.push(`avatar_url = $${paramIndex++}`);
      values.push(fields.avatar_url);
    }
    if (fields.phone_number !== undefined) {
      setClauses.push(`phone_number = $${paramIndex++}`);
      values.push(fields.phone_number);
    }
    if (fields.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(fields.status);
    }

    if (setClauses.length === 0) return this.findById(id);

    values.push(id);
    const result = await pool.query<UserRecord>(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }
}

export const userRepository = new UserRepository();
