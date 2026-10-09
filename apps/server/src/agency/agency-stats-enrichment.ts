import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { createChildLogger } from '@magick-agency/observability';

/*
 * PORT NOTE (magick-agency): plan §2 drops credits. DELETED from master's module, each listed in
 * PORTING.md: the `credits_low` stall arm (`mergeStall`), `rankOf`, the credit-balance and
 * rate-card reads, `DEFAULT_CREDITS_LOW_CONNECTS_THRESHOLD`, the context's
 * `creditsLowConnectsThreshold`, the `AGENCY_CONNECTED_CALL_OPERATION` import, and
 * `AGENCY_STALL_PRIORITY` (its only reader was `mergeStall`; the one list is
 * `@magick-agency/contracts/agency`'s). What remains is the `agent_name` half, verbatim: the
 * `stall`/`other_stalls` keys now pass through untouched like every other field.
 */

const log = createChildLogger({ component: 'agency-stats-enrichment' });

/**
 * The two fields on `GET /agency-campaigns/:id/stats` that core declares and
 * **cannot produce**, filled in on the proxy hop (MAG-148 + MAG-141).
 *
 * PORT NOTE (magick-agency): ONLY HALF OF THIS SURVIVES. Item 2 below (the `credits_low` stall arm)
 * and every sentence about credits/balance are master's text, kept as the record of why the
 * module exists, but DELETED in agency (plan §2: no credits). Read "two fields" as one:
 * `agent_name`. `stall` / `other_stalls` now pass through exactly as core sent them.
 *
 * ── The defect class ───────────────────────────────────────────────────────
 * This is MAG-120's shape for the third time: a contract member with a named
 * owner and no producer. Core's `contracts.ts` names master as the owner of
 * both, in prose and (for the stall) in a runtime constant — and until this
 * module existed, `grep -rn "credits_low\|other_stalls" src/` in this repo
 * returned nothing at all. A declared arm with no producer reads as reachable
 * to every consumer and to the compiler, which is exactly why neither the
 * compiler nor either service's suite could see the hole.
 *
 *  1. **`agent_name`** on each `agents[]` row. Core's own comment on
 *     `agent_user_id` (`contracts.ts:1429`): "Core never resolves it to a name
 *     (D3) — there is no user table here… master… is the only service that
 *     knows identity."
 *  2. **[DELETED, plan §2] The `credits_low` stall arm.** Core builds `AGENCY_CORE_STALL_CODES` by
 *     filtering `credits_low` out of `AGENCY_STALL_PRIORITY`, so core states in
 *     executable form that it never emits it. Credits are master's fact.
 *
 * ── Byte-identity is a requirement, not an aspiration ──────────────────────
 * With every name resolving (and, in master, the balance healthy), the body master sends must
 * be core's body plus one `agent_name` key per agent row — same key order, same
 * values, nothing reshaped, reordered or dropped. Every transform below is a
 * spread over the object core sent, never a reconstruction from a field list:
 * a field list would silently drop whatever core adds next (a core lane is
 * adding `last_heartbeat` to the agent row right now, and it must arrive at
 * cusui untouched without this file being edited).
 *
 * ── Enrichment must never turn a 200 into a 500 ────────────────────────────
 * cusui polls this endpoint every 5 seconds. Both halves are wrapped: a DB or
 * balance failure degrades the enrichment, it does not fail the request. The two
 * halves degrade DIFFERENTLY, deliberately (only the first remains):
 *
 *  - names fall back to `agent_name: null` **on every row** — the key is still
 *    produced, because a sometimes-absent key is the very defect being fixed;
 *  - [DELETED, plan §2] credits fall back to leaving `stall` / `other_stalls` exactly as core sent
 *    them — master cannot assert `credits_low` without knowing the balance, and
 *    inventing the diagnosis is worse than omitting it.
 */

/** What the proxy hop knows that core does not. */
export interface AgencyStatsEnrichmentContext {
  tenantId: string;
  /** Core's HTTP status. Only a 2xx body is enriched. */
  status: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Add `agent_name` to every agent row — one query for the whole roster.
 *
 * Returns the ORIGINAL body reference when there is no `agents` array to enrich,
 * so a non-stats body (an error, a shape core has changed) passes through
 * identically rather than being rebuilt.
 */
async function enrichAgentNames(
  body: Record<string, unknown>,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const agents = body['agents'];
  if (!Array.isArray(agents)) return body;

  const ids: string[] = [];
  for (const row of agents) {
    if (isRecord(row) && typeof row['agent_user_id'] === 'string') {
      ids.push(row['agent_user_id']);
    }
  }

  let names = new Map<string, string | null>();
  try {
    // ONE query for the whole floor, scoped to this tenant. A foreign or deleted
    // id is simply absent from the map and therefore resolves to null — see
    // `findDisplayNamesInTenant`.
    names = await userRepository.findDisplayNamesInTenant(ids, tenantId);
  } catch (err) {
    // Degrade to nulls rather than failing a 5-second poll. The KEY is still
    // produced on every row: an absent key is the defect, a null is an answer.
    log.warn(
      { tenantId, agents: agents.length, err: err instanceof Error ? err.message : String(err) },
      'agency stats: agent name resolution failed; emitting agent_name: null',
    );
  }

  return {
    ...body,
    agents: agents.map((row) => {
      if (!isRecord(row)) return row;
      const id = row['agent_user_id'];
      // Spread FIRST so `agent_name` is appended and every existing key keeps its
      // position and value — including fields core adds after this was written.
      return { ...row, agent_name: typeof id === 'string' ? names.get(id) ?? null : null };
    }),
  };
}

/**
 * Fill the master-owned `agent_name` field on a campaign-stats body (the `credits_low` half is deleted, plan §2).
 *
 * Non-2xx bodies and non-object bodies are returned by reference, untouched —
 * an error body must reach the error mask exactly as core wrote it.
 */
export async function enrichAgencyCampaignStats(
  body: unknown,
  ctx: AgencyStatsEnrichmentContext,
): Promise<unknown> {
  if (ctx.status < 200 || ctx.status >= 300 || !isRecord(body)) return body;

  const enriched = await enrichAgentNames(body, ctx.tenantId);

  return enriched;
}
