import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'agency-stats-enrichment' });

/**
 * `agent_name` on `GET /agency-campaigns/:id/stats`: the field the stats body
 * declares and the internal handler instance does not produce, filled in by the
 * public API layer's stats route.
 *
 * ── The defect class ───────────────────────────────────────────────────────
 * A contract member with no producer reads as reachable to every consumer and to
 * the compiler, which is exactly why neither the compiler nor a test suite could
 * see the hole. The dialer runtime's stats carry `agent_user_id` on each
 * `agents[]` row and never resolve it to a name; the name is resolved here.
 *
 * ── Byte-identity is a requirement, not an aspiration ──────────────────────
 * With every name resolving, the body sent must be the handler's body plus one
 * `agent_name` key per agent row — same key order, same values, nothing reshaped,
 * reordered or dropped. The transform below is a spread over the object the
 * handler returned, never a reconstruction from a field list: a field list would
 * silently drop whatever the stats body adds next (a new field on the agent row
 * must reach the console untouched without this file being edited).
 *
 * ── Enrichment must never turn a 200 into a 500 ────────────────────────────
 * The console polls this endpoint every 5 seconds. A DB failure degrades the
 * enrichment; it does not fail the request. Names fall back to `agent_name: null`
 * **on every row** — the key is still produced, because a sometimes-absent key is
 * the very defect being fixed. `stall` / `other_stalls` pass through untouched
 * like every other field.
 */

/** What the stats route knows that the stats body does not. */
export interface AgencyStatsEnrichmentContext {
  tenantId: string;
  /** The internal handler's HTTP status. Only a 2xx body is enriched. */
  status: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Add `agent_name` to every agent row — one query for the whole roster.
 *
 * Returns the ORIGINAL body reference when there is no `agents` array to enrich,
 * so a non-stats body (an error, a changed shape) passes through
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
      // position and value — including fields added after this was written.
      return { ...row, agent_name: typeof id === 'string' ? names.get(id) ?? null : null };
    }),
  };
}

/**
 * Fill the `agent_name` field on a campaign-stats body.
 *
 * Non-2xx bodies and non-object bodies are returned by reference, untouched —
 * an error body must reach the error mask exactly as the handler wrote it.
 */
export async function enrichAgencyCampaignStats(
  body: unknown,
  ctx: AgencyStatsEnrichmentContext,
): Promise<unknown> {
  if (ctx.status < 200 || ctx.status >= 300 || !isRecord(body)) return body;

  const enriched = await enrichAgentNames(body, ctx.tenantId);

  return enriched;
}
