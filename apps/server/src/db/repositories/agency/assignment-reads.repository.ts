/**
 * Contact assignment reads: the supervisor's progress per agent and the agent's own contacts
 * (list and summary). Every bucket, due and retry answer is built from `assignment-sql.ts`,
 * the one definition, so the agent's numbers and the supervisor's agree.
 *
 * "Due now" everywhere here: open (`pending`, not DNC) and `next_attempt_at <= now()`.
 *
 * Plans: the agent reads probe `idx_agency_contacts_assignee` (campaign, owner, ...); the
 * progress read is one grouped pass over the campaign's contacts plus one grouped join of
 * its attempts to their owners (`last_activity_at`): a supervisor screen, not a hot path.
 */
import { getPool } from '@magick-agency/db';
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type { AgencyKeysetPage } from '@magick-agency/contracts/agency';
import {
  AGENCY_MY_CONTACT_BUCKETS,
  type AgencyAgentRetryBlock,
  type AgencyContactBucketCounts,
  type AgencyMyContact,
  type AgencyMyContactBucket,
} from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyCampaignRecord } from '../../models/agency.model.js';
import type { PhoneFilter } from '../../../agency/spine-filters.js';
import {
  agentRetryAvailableAtSql,
  agentRetryBlockSql,
  callbackCodes,
  contactBucketSql,
  lastAttemptAtSql,
} from './assignment-sql.js';
import { params, phoneCondition, toKeysetPage } from './query-builders.js';

const OPEN_BUCKETS: readonly AgencyMyContactBucket[] = ['pending', 'callback', 'not_reached'];

export function emptyBucketCounts(): AgencyContactBucketCounts {
  return Object.fromEntries(AGENCY_MY_CONTACT_BUCKETS.map((b) => [b, 0])) as AgencyContactBucketCounts;
}

/** The campaign's hero columns, in order, minus hidden ones. */
export function heroColumns(campaign: Pick<AgencyCampaignRecord, 'context_display'>): string[] {
  const display = campaign.context_display ?? {};
  const hidden = new Set(Array.isArray(display.hidden) ? display.hidden : []);
  const hero = Array.isArray(display.hero) ? display.hero : [];
  return [...new Set(hero.filter((h): h is string => typeof h === 'string' && h.length > 0 && !hidden.has(h)))];
}

/** One owner's (or the pool's) contacts, folded. */
export interface OwnerTally {
  total: number;
  counts: AgencyContactBucketCounts;
  attempted: number;
  due_now: number;
}

export interface ProgressRaw {
  /** Keyed by owner user id; the pool is `null`'s entry, under `pool`. */
  owners: Map<string, OwnerTally>;
  pool: OwnerTally;
  /** Per agent: whether a live campaign session exists, and when last seen. */
  sessions: Map<string, { live: boolean; last_seen_at: Date | null }>;
  /** Per agent: the latest attempt on one of their contacts. */
  lastActivity: Map<string, Date>;
}

export interface MyContactsTally {
  own: OwnerTally & { eligible: number; open_non_callback: number; next_open_at: Date | null };
  /**
   * The other contacts the agent's queue draws on: the pool (strict, preferred) or the whole
   * campaign (pool mode). `open` is counted only in strict mode (`unassigned_open`);
   * `due_now` / `open_non_callback` are 0/1 presence flags from the earliest due time: the
   * simple reading (see `queue-state.ts`).
   */
  pool: { open: number | null; due_now: number; open_non_callback: number; next_open_at: Date | null };
}

interface MyContactRaw {
  id: string;
  campaign_id: string;
  phone_e164: string;
  bucket: AgencyMyContactBucket;
  state: AgencyMyContact['state'];
  attempt_count: number;
  last_outcome: string | null;
  last_disposition: string | null;
  next_attempt_at: Date;
  last_attempt_at: Date | null;
  hero: Array<{ name: string; value: string }>;
  retry_blocked: AgencyAgentRetryBlock | null;
  agent_retry_rounds_used: number;
  retry_available_at: Date | null;
  override_disposition: string | null;
  override_extra_attempts: number;
  override_retry_delay: boolean;
  override_calling_hours: boolean;
  override_granted_at: Date | null;
  cursor_at: string;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

function emptyTally(): OwnerTally {
  return { total: 0, counts: emptyBucketCounts(), attempted: 0, due_now: 0 };
}

export class AgencyAssignmentReadRepository {
  /** Counts per owner and bucket, sessions, and last activity for one campaign. */
  async progress(campaign: Pick<AgencyCampaignRecord, 'id' | 'disposition_catalog'>): Promise<ProgressRaw> {
    const pool = getPool();
    const bind = params();
    const id = bind.add(campaign.id);
    const codes = bind.add(callbackCodes(campaign.disposition_catalog));
    const bucket = contactBucketSql('c', codes);
    const [counts, sessions, activity] = await Promise.all([
      pool.query<{ uid: string | null; bucket: AgencyMyContactBucket; n: number; attempted: number; due: number }>(
        `SELECT c.assigned_user_id::text AS uid, ${bucket} AS bucket, count(*)::int AS n,
                (count(*) FILTER (WHERE c.attempt_count > 0))::int AS attempted,
                (count(*) FILTER (WHERE c.state = 'pending' AND c.suppressed_reason IS DISTINCT FROM 'dnc'
                                    AND c.next_attempt_at <= now()))::int AS due
           FROM agency_contacts c
          WHERE c.campaign_id = ${id}::uuid
          GROUP BY 1, 2`,
        bind.values,
      ),
      pool.query<{ uid: string; live: boolean; last_seen_at: Date | null }>(
        `SELECT s.agent_user_id::text AS uid, bool_or(s.left_at IS NULL) AS live,
                max(GREATEST(s.last_heartbeat, COALESCE(s.left_at, s.last_heartbeat))) AS last_seen_at
           FROM agency_agent_sessions s
          WHERE s.campaign_id = $1::uuid
          GROUP BY 1`,
        [campaign.id],
      ),
      pool.query<{ uid: string; last: Date }>(
        `SELECT c.assigned_user_id::text AS uid, max(a.created_at) AS last
           FROM agency_contacts c JOIN agency_call_attempts a ON a.contact_id = c.id
          WHERE c.campaign_id = $1::uuid AND c.assigned_user_id IS NOT NULL
          GROUP BY 1`,
        [campaign.id],
      ),
    ]);
    const owners = new Map<string, OwnerTally>();
    const poolTally = emptyTally();
    for (const r of counts.rows) {
      let t = poolTally;
      if (r.uid !== null) {
        t = owners.get(r.uid) ?? emptyTally();
        owners.set(r.uid, t);
      }
      t.total += r.n;
      t.counts[r.bucket] += r.n;
      t.attempted += r.attempted;
      t.due_now += r.due;
    }
    return {
      owners,
      pool: poolTally,
      sessions: new Map(sessions.rows.map((r) => [r.uid, { live: r.live, last_seen_at: r.last_seen_at }])),
      lastActivity: new Map(activity.rows.map((r) => [r.uid, r.last])),
    };
  }

  /**
   * The agent's own counts on a campaign and, for the queue, the pool they also draw from:
   * strict → the pool's open count (it blocks completion); preferred → its due/next; pool
   * mode → the whole campaign's open contacts (the owner is ignored there).
   */
  async myTally(campaign: AgencyCampaignRecord, userId: string): Promise<MyContactsTally> {
    const pool = getPool();
    const bind = params();
    const id = bind.add(campaign.id);
    const user = bind.add(userId);
    const codes = bind.add(callbackCodes(campaign.disposition_catalog));
    const block = agentRetryBlockSql('c', {
      allowed: bind.add(campaign.allow_agent_retry),
      rounds: bind.add(campaign.agent_retry_rounds),
      cooldownMinutes: bind.add(campaign.agent_retry_cooldown_minutes),
      callbackCodes: codes,
    });
    const own = await pool.query<{ bucket: AgencyMyContactBucket; n: number; attempted: number; due: number; eligible: number; next_open_at: Date | null }>(
      `SELECT b.bucket, count(*)::int AS n,
              (count(*) FILTER (WHERE b.attempt_count > 0))::int AS attempted,
              (count(*) FILTER (WHERE b.bucket IN ('pending', 'callback', 'not_reached') AND b.next_attempt_at <= now()))::int AS due,
              (count(*) FILTER (WHERE b.blocked IS NULL))::int AS eligible,
              min(b.next_attempt_at) FILTER (WHERE b.bucket IN ('pending', 'callback', 'not_reached')) AS next_open_at
         FROM (SELECT c.attempt_count, c.next_attempt_at, ${contactBucketSql('c', codes)} AS bucket, ${block} AS blocked
                 FROM agency_contacts c
                WHERE c.campaign_id = ${id}::uuid AND c.assigned_user_id = ${user}::uuid) b
        GROUP BY b.bucket`,
      bind.values,
    );
    const tally: MyContactsTally['own'] = { ...emptyTally(), eligible: 0, open_non_callback: 0, next_open_at: null };
    for (const r of own.rows) {
      tally.total += r.n;
      tally.counts[r.bucket] += r.n;
      tally.attempted += r.attempted;
      tally.due_now += r.due;
      tally.eligible += r.eligible;
      if (OPEN_BUCKETS.includes(r.bucket) && r.bucket !== 'callback') tally.open_non_callback += r.n;
      if (r.next_open_at && (!tally.next_open_at || r.next_open_at < tally.next_open_at)) tally.next_open_at = r.next_open_at;
    }

    const scope = campaign.assignment_mode === 'pool' ? '' : 'AND c.assigned_user_id IS NULL';
    // Strict needs the pool's open COUNT (unassigned_open); the others only its earliest due.
    const counted = campaign.assignment_mode === 'strict';
    const { rows } = await pool.query<{ open: number | null; next_open_at: Date | null }>(
      `SELECT ${counted ? 'count(*)::int' : 'NULL::int'} AS open, min(c.next_attempt_at) AS next_open_at
         FROM agency_contacts c
        WHERE c.campaign_id = $1::uuid ${scope}
          AND c.state = 'pending' AND c.suppressed_reason IS DISTINCT FROM 'dnc'`,
      [campaign.id],
    );
    const r = rows[0]!;
    const next = r.next_open_at;
    const due = next !== null && next.getTime() <= Date.now() ? 1 : 0;
    const exists = next !== null ? 1 : 0;
    return { own: tally, pool: { open: r.open, due_now: due, open_non_callback: exists, next_open_at: next } };
  }

  /**
   * One page of the agent's own contacts, in due order (`next_attempt_at`, then id), keyset
   * paged. `bucket`, `phone` and `q` (text in a hero column, case-insensitive) narrow it.
   */
  async myContacts(input: {
    campaign: AgencyCampaignRecord;
    userId: string;
    buckets?: AgencyMyContactBucket[];
    phone?: PhoneFilter;
    q?: string;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyMyContact>> {
    const { campaign } = input;
    const bind = params();
    const codes = bind.add(callbackCodes(campaign.disposition_catalog));
    const cooldown = bind.add(campaign.agent_retry_cooldown_minutes);
    const block = agentRetryBlockSql('c', {
      allowed: bind.add(campaign.allow_agent_retry),
      rounds: bind.add(campaign.agent_retry_rounds),
      cooldownMinutes: cooldown,
      callbackCodes: codes,
    });
    const hero = bind.add(heroColumns(campaign));
    const bucket = contactBucketSql('c', codes);
    // THE OWNER PREDICATE: the caller's contacts on this campaign, never anyone else's.
    const conditions = [
      `c.campaign_id = ${bind.add(campaign.id)}::uuid`,
      `c.assigned_user_id = ${bind.add(input.userId)}::uuid`,
    ];
    if (input.buckets?.length) conditions.push(`${bucket} = ANY(${bind.add(input.buckets)}::text[])`);
    if (input.phone) conditions.push(phoneCondition(input.phone, 'c', bind));
    if (input.q) {
      conditions.push(`EXISTS (SELECT 1 FROM unnest(${hero}::text[]) AS hq(name)
                        WHERE strpos(lower(c.context ->> hq.name), lower(${bind.add(input.q)}::text)) > 0)`);
    }
    if (input.after) {
      conditions.push(`(c.next_attempt_at, c.id) > (${bind.add(input.after.at)}::timestamptz, ${bind.add(input.after.id)}::uuid)`);
    }
    const { rows } = await getPool().query<MyContactRaw>(
      `SELECT c.id, c.campaign_id, c.phone_e164, ${bucket} AS bucket, c.state, c.attempt_count,
              c.last_outcome, c.last_disposition, c.next_attempt_at,
              ${lastAttemptAtSql('c')} AS last_attempt_at,
              (SELECT COALESCE(json_agg(json_build_object('name', h.name, 'value', c.context ->> h.name) ORDER BY h.ord), '[]'::json)
                 FROM unnest(${hero}::text[]) WITH ORDINALITY AS h(name, ord)
                WHERE NULLIF(btrim(c.context ->> h.name), '') IS NOT NULL) AS hero,
              ${block} AS retry_blocked, c.agent_retry_rounds_used,
              ${agentRetryAvailableAtSql('c', cooldown)} AS retry_available_at,
              c.override_disposition, c.override_extra_attempts, c.override_retry_delay,
              c.override_calling_hours, c.override_granted_at,
              ${keysetAtSql('c.next_attempt_at')} AS cursor_at
         FROM agency_contacts c
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.next_attempt_at ASC, c.id ASC
        LIMIT ${bind.add(input.limit + 1)}`,
      bind.values,
    );
    return toKeysetPage(rows, input.limit, projectMyContact);
  }
}

export function projectMyContact(r: MyContactRaw): AgencyMyContact {
  const overrideUnspent = r.override_disposition !== null
    && (r.override_extra_attempts > 0 || r.override_retry_delay || r.override_calling_hours);
  return {
    id: r.id,
    campaign_id: r.campaign_id,
    phone_e164: r.phone_e164,
    bucket: r.bucket,
    state: r.state,
    attempt_count: r.attempt_count,
    last_outcome: r.last_outcome,
    last_disposition: r.last_disposition,
    next_attempt_at: iso(r.next_attempt_at)!,
    last_attempt_at: iso(r.last_attempt_at),
    hero: r.hero,
    retry: {
      eligible: r.retry_blocked === null,
      blocked: r.retry_blocked,
      rounds_used: r.agent_retry_rounds_used,
      available_at: r.retry_blocked === 'cooldown' ? iso(r.retry_available_at) : null,
    },
    override: overrideUnspent
      ? {
          disposition: r.override_disposition!,
          extra_attempts: r.override_extra_attempts,
          retry_delay: r.override_retry_delay,
          calling_hours: r.override_calling_hours,
          granted_at: iso(r.override_granted_at) ?? '',
        }
      : null,
  };
}

export const agencyAssignmentReadRepository = new AgencyAssignmentReadRepository();
