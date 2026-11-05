/**
 * A random dialling history for the insights rollup suites: campaigns in several zones, agents,
 * contacts in several zones (one unresolvable), and attempts across two days with every shape
 * the rollup reads (outcomes, live calls, abandons past the bridge grace, wrap-up redial chains
 * up to the limit, reopened and manual dials, spent overrides, callbacks, recordings, measured
 * and unmeasured wrap-ups, dials exactly on a bucket boundary). Seeded (`createRng`), so a red
 * run is reproducible from `LOAD_SEED`.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createRng, type Rng } from '../../helpers/load-scale.js';
import { DEFAULTS } from '../setup/factories.js';

export const WORLD_BASE = new Date('2026-10-01T00:00:00.000Z');
export const WORLD_MINUTES = 2 * 24 * 60;

export const CATALOG = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'appointment', label: 'Appointment', is_success: true },
  { code: 'callback', label: 'Call back', is_success: false },
  { code: 'not_interested', label: 'Not interested', is_success: false },
  { code: 'retry_later', label: 'Retry later', is_success: false, override: { extra_attempts: 1 } },
  { code: 'voicemail', label: 'Voicemail', is_success: false },
];
export const SUCCESS_CODES = ['sale', 'appointment'];
export const OVERRIDE_CODES = ['retry_later', 'callback'];
const CODES = ['sale', 'appointment', 'callback', 'not_interested', 'retry_later', 'voicemail', 'no_disposition'];
const RESOLUTIONS = ['disposition_submitted', 'auto_return', 'agent_returned', 'forced', 'agent_left', 'campaign_stopped'];
const CONTACT_ZONES = [null, 'Asia/Kolkata', 'Asia/Kathmandu', 'America/New_York', 'Not/AZone', 'asia/kolkata'];
const CALLER_IDS = ['+919000000001', '+919000000002', '+919000000003'];

export interface WorldCampaign { id: string; zone: string; agents: Array<{ sessionId: string; userId: string }>; contactIds: string[] }

const ATTEMPT_COLUMNS: Array<[string, string]> = [
  ['id', 'uuid'], ['campaign_id', 'uuid'], ['contact_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'],
  ['attempt_number', 'int'], ['webrtc_call_id', 'uuid'], ['caller_id', 'text'], ['reserved_agent_id', 'uuid'],
  ['state', 'text'], ['outcome', 'text'], ['disposition_code', 'text'], ['callback_at', 'timestamptz'],
  ['dialed_at', 'timestamptz'], ['answered_at', 'timestamptz'], ['bridged_at', 'timestamptz'], ['ended_at', 'timestamptz'],
  ['wrapup_started_at', 'timestamptz'], ['wrapup_ended_at', 'timestamptz'], ['wrapup_resolution', 'text'],
  ['redial_of_attempt_id', 'uuid'], ['redial_number', 'int'], ['agent_reopened', 'boolean'], ['agent_manual', 'boolean'],
  ['override_applied', 'text[]'],
];

/** INSERT rows as one statement from a JSON array (so statement triggers see one statement). */
export async function bulkInsert(pool: pg.Pool | pg.PoolClient, table: string, columns: Array<[string, string]>, rows: Array<Record<string, unknown>>): Promise<void> {
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await pool.query(
      `INSERT INTO ${table} (${columns.map(([c]) => c).join(', ')})
       SELECT ${columns.map(([c]) => c).join(', ')}
         FROM jsonb_to_recordset($1::jsonb) AS x(${columns.map(([c, t]) => `${c} ${t}`).join(', ')})`,
      [JSON.stringify(chunk)],
    );
  }
}

const at = (minutes: number, seconds = 0): Date => new Date(WORLD_BASE.getTime() + minutes * 60_000 + seconds * 1000);
const plus = (d: Date, seconds: number): Date => new Date(d.getTime() + seconds * 1000);

/** One attempt's lifecycle columns for a dial at `dialed`. */
function lifecycle(rng: Rng, dialed: Date, opts: { forceConnected?: boolean; allowLive: boolean }): Record<string, unknown> {
  const live = opts.allowLive && !opts.forceConnected && rng.chance(0.03);
  const kind = opts.forceConnected ? 'connected' : rng.pick(['connected', 'connected', 'connected', 'no_answer', 'busy', 'failed', 'abandoned', 'canceled', 'orphaned', 'invalid']);
  const row: Record<string, unknown> = { state: 'ended', outcome: kind };
  if (live) {
    const answered = plus(dialed, rng.int(3, 20));
    return { state: 'bridged', outcome: null, answered_at: answered, bridged_at: plus(answered, 0.4) };
  }
  if (kind === 'connected' || kind === 'orphaned') {
    const answered = plus(dialed, rng.int(3, 25));
    // Some bridges land after the 1 s grace: abandoned by the predicate though outcome says connected.
    const bridged = plus(answered, rng.chance(0.08) ? 1.5 + rng.next() : rng.next() * 0.9);
    const ended = plus(bridged, rng.int(5, 600) + rng.next());
    row['answered_at'] = answered;
    row['bridged_at'] = bridged;
    row['ended_at'] = ended;
    if (rng.chance(0.9)) {
      row['wrapup_started_at'] = ended;
      row['wrapup_ended_at'] = plus(ended, rng.int(2, 90) + rng.next());
      row['wrapup_resolution'] = rng.pick(RESOLUTIONS);
    }
    if (rng.chance(0.85)) row['disposition_code'] = rng.pick(CODES);
  } else if (kind === 'abandoned') {
    const answered = plus(dialed, rng.int(3, 25));
    row['answered_at'] = answered;
    row['ended_at'] = plus(answered, 8);
  } else {
    row['ended_at'] = plus(dialed, rng.int(5, 40));
  }
  return row;
}

/**
 * Seed `campaigns` campaigns (zones in order: UTC, Asia/Kolkata, Asia/Kathmandu, ...) with
 * `contactsPer` contacts each. Returns the campaigns and the number of attempts.
 */
export async function seedWorld(pool: pg.Pool, opts: { campaigns: number; contactsPer: number; seed?: number }): Promise<{ campaigns: WorldCampaign[]; attempts: number }> {
  const rng = createRng(opts.seed ?? 0x1215);
  const zones = ['UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/New_York'];
  const campaigns: WorldCampaign[] = [];
  const attempts: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];
  for (let ci = 0; ci < opts.campaigns; ci++) {
    const id = randomUUID();
    const zone = zones[ci % zones.length]!;
    await pool.query(
      `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids, status, default_timezone, disposition_catalog)
       VALUES ($1, $2, $3, $4, $5, $8, $6, $7::jsonb)`,
      [id, DEFAULTS.tenantId, DEFAULTS.accountId, `insights-${ci}`, CALLER_IDS, zone, JSON.stringify(CATALOG), ci === 0 ? 'running' : 'paused'],
    );
    const agents = Array.from({ length: 6 }, () => ({ sessionId: randomUUID(), userId: randomUUID() }));
    for (const a of agents) {
      await pool.query(
        `INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, state, left_at)
         VALUES ($1, $2, $3, $4, $5, 'offline', now())`,
        [a.sessionId, DEFAULTS.tenantId, DEFAULTS.accountId, id, a.userId],
      );
    }
    const contacts = Array.from({ length: opts.contactsPer }, (_, i) => ({
      id: randomUUID(), campaign_id: id, tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId,
      phone_e164: `+91${(9_000_000_000 + ci * 100_000 + i).toString()}`, context: {}, state: rng.pick(['pending', 'completed', 'exhausted', 'pending']),
      timezone: rng.pick(CONTACT_ZONES),
    }));
    await bulkInsert(pool, 'agency_contacts', [
      ['id', 'uuid'], ['campaign_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['phone_e164', 'text'],
      ['context', 'jsonb'], ['state', 'text'], ['timezone', 'text'],
    ], contacts);
    campaigns.push({ id, zone, agents, contactIds: contacts.map((c) => c.id) });

    for (const contact of contacts) {
      let minute = rng.int(0, WORLD_MINUTES - 600);
      let number = 0;
      const dials = rng.int(1, 6);
      for (let d = 0; d < dials && minute < WORLD_MINUTES; d++) {
        const agent = rng.chance(0.05) ? null : rng.pick(agents);
        // 10% exactly on a bucket boundary (the half-open edge), the rest anywhere in the minute.
        const dialed = rng.chance(0.1) ? at(Math.floor(minute / 15) * 15) : at(minute, rng.int(0, 59) + rng.next());
        let chainOf: string | null = null;
        for (let redial = 0; redial <= 2; redial++) {
          number += 1;
          const attemptId = randomUUID();
          const dialedAt = redial === 0 ? dialed : plus(dialed, redial * 700);
          const row: Record<string, unknown> = {
            id: attemptId, campaign_id: id, contact_id: contact.id, tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId,
            attempt_number: number, caller_id: rng.pick(CALLER_IDS), reserved_agent_id: agent?.sessionId ?? null,
            dialed_at: dialedAt, redial_of_attempt_id: chainOf, redial_number: redial,
            agent_reopened: redial === 0 && rng.chance(0.06), agent_manual: redial === 0 && rng.chance(0.06),
            override_applied: redial === 0 && rng.chance(0.07) ? rng.pick([['extra_attempts'], ['retry_delay', 'calling_hours']]) : [],
            ...lifecycle(rng, dialedAt, { forceConnected: redial > 0 && rng.chance(0.5), allowLive: d === dials - 1 }),
          };
          if (row['disposition_code'] === 'callback') row['callback_at'] = plus(dialedAt, rng.int(600, 30 * 3600));
          if (row['bridged_at']) {
            const callId = randomUUID();
            row['webrtc_call_id'] = callId;
            calls.push({
              id: callId, tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId, caller_id: row['caller_id'],
              destination_phone: contact.phone_e164, provider: 'voicelink', status: 'completed', metadata: {},
              campaign_id: id, recording_url: rng.chance(0.6) ? `https://recording.example/${callId}.mp3` : null,
              error_code: null,
            });
          } else if (row['outcome'] === 'failed' && number % 4 !== 0) {
            // A carrier failure with a call row and (mostly) its error code; every fourth has no
            // call row at all. Chosen from the attempt number, not the rng, so the rest of the
            // world is the seed it always was.
            const callId = randomUUID();
            row['webrtc_call_id'] = callId;
            calls.push({
              id: callId, tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId, caller_id: row['caller_id'],
              destination_phone: contact.phone_e164, provider: 'voicelink', status: 'failed', metadata: {},
              campaign_id: id, recording_url: null,
              error_code: [null, 'TELEPHONY_ERROR', 'TELEPHONY_INIT_FAILED'][number % 3],
            });
          }
          // A wrap-up redial: this call is closed `redialed` and the next attempt continues it.
          const redialNext = row['bridged_at'] && row['state'] === 'ended' && redial < 2 && rng.chance(0.15);
          if (redialNext) {
            row['disposition_code'] = 'redialed';
            row['wrapup_resolution'] = 'redialed';
            row['callback_at'] = null;
          }
          attempts.push(row);
          if (!redialNext) break;
          chainOf = attemptId;
        }
        minute += rng.int(30, 900);
      }
    }
  }
  await bulkInsert(pool, 'agency_calls', [
    ['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['caller_id', 'text'], ['destination_phone', 'text'],
    ['provider', 'text'], ['status', 'text'], ['metadata', 'jsonb'], ['campaign_id', 'uuid'], ['recording_url', 'text'],
    ['error_code', 'text'],
  ], calls);
  await bulkInsert(pool, 'agency_call_attempts', ATTEMPT_COLUMNS, attempts);
  return { campaigns, attempts: attempts.length };
}
