/**
 * Which process an internal handler must run in, once the server runs as several
 * processes on one host (`docs/scaling.md` §3.4).
 *
 * Some internal agency handlers read state that lives only in the process holding the
 * agent's station socket: `isLocallyOwned` on `/available`, the `WrapupManager` on a
 * disposition, the `BreakRegistry` on a break, the soft phone's live call. With media
 * workers, `callCore` forwards those to the worker that owns the session; everything else
 * runs where it is called. In a single process every owner is this process and nothing is
 * forwarded: the table only classifies.
 *
 * The table is exhaustive for `/api/v1/agency`: `buildCoreHandlers` refuses to register an
 * agency route it does not list (`assertCoreRouteClassified`), so a new handler cannot be
 * added without deciding where it runs. The campaign and agent-stats handlers
 * (`/api/v1/agency-campaigns`, `/api/v1/agency-agents`) read Postgres and Redis only and are
 * `none` by prefix.
 */

export const CORE_OWNER_KINDS = [
  /** `:id` in the path is the agent session. */
  'session_param',
  /** `:id` is an attempt; the owner is its `reserved_agent_id`'s session. */
  'attempt_param',
  /** `:id` is a soft-phone call; the owner is its `session_id`. */
  'manual_call_param',
  /** The JSON body's `session_id`. */
  'body_session',
  /** The calling agent's live session (resolved from the tenant, account and actor). */
  'actor_session',
  /** No per-session state: runs where it is called. */
  'none',
] as const;
export type CoreOwnerKind = (typeof CORE_OWNER_KINDS)[number];

export const AGENCY_CORE_PREFIX = '/api/v1/agency';

/**
 * Every internal agency route, `METHOD path` relative to {@link AGENCY_CORE_PREFIX}.
 * `none` here is a claim that the handler touches no per-session runtime state; the
 * source guard (`test/unit/api/core-route-owners.test.ts`) holds each such claim to a
 * written reason.
 */
export const AGENCY_CORE_ROUTE_OWNERS: Readonly<Record<string, CoreOwnerKind>> = {
  'POST /sessions': 'none',
  'POST /sessions/:id/station-token': 'session_param',
  'POST /sessions/:id/available': 'session_param',
  'POST /sessions/:id/force-available': 'session_param',
  'POST /sessions/:id/break': 'session_param',
  'POST /sessions/:id/break/cancel': 'session_param',
  'POST /sessions/:id/leave': 'session_param',
  'POST /sessions/:id/softphone': 'session_param',
  'POST /sessions/:id/softphone/return': 'session_param',
  'POST /sessions/:id/redial': 'session_param',
  // The agent's dial of one of their own contacts (`agency/my-contact-call.ts`): placed where
  // the agent's station is, as the redial.
  'POST /sessions/:id/my-contact-call': 'session_param',
  'POST /attempts/:id/hangup': 'attempt_param',
  'POST /attempts/:id/disposition': 'attempt_param',
  'POST /attempts/:id/dnc': 'attempt_param',
  'POST /attempts/:id/notes': 'attempt_param',
  'POST /softphone/sessions': 'none',
  'GET /softphone/bootstrap': 'actor_session',
  'POST /softphone/calls': 'body_session',
  'GET /softphone/calls': 'none',
  'GET /softphone/calls/:id': 'manual_call_param',
  'GET /softphone/calls/:id/recording': 'none',
  'PATCH /softphone/calls/:id': 'manual_call_param',
  'POST /softphone/calls/:id/hangup': 'manual_call_param',
  'POST /softphone/calls/:id/disposition': 'manual_call_param',
  'POST /softphone/calls/:id/dnc': 'manual_call_param',
  'GET /softphone/settings': 'none',
  'PUT /softphone/settings': 'none',
  // Inbound calls (`agency/inbound.ts`): the account's routes and Missed rows, Postgres only.
  'GET /inbound/routes': 'none',
  'GET /inbound/routes/:id': 'none',
  'POST /inbound/routes': 'none',
  'PATCH /inbound/routes/:id': 'none',
  'DELETE /inbound/routes/:id': 'none',
  'GET /inbound/numbers': 'none',
  'GET /inbound/clips': 'none',
  'GET /inbound/missed': 'none',
  'POST /inbound/missed/:id/handled': 'none',
  // The answered inbound call (`agency/inbound-calls.ts`): inbound callers are connected only in
  // one process (IB8), so the connector and the agents it took are this process's.
  'GET /inbound/calls/:id': 'none',
  'PATCH /inbound/calls/:id': 'none',
  'POST /inbound/calls/:id/hangup': 'none',
  'POST /inbound/calls/:id/disposition': 'none',
  'POST /inbound/calls/:id/dnc': 'none',
  'GET /inbound/queue': 'none',
};

/** A matched internal route: its owner kind and the path's `:id`, if it has one. */
export interface CoreRouteMatch {
  owner: CoreOwnerKind;
  id: string | null;
}

interface CompiledRoute { method: string; pattern: RegExp; owner: CoreOwnerKind }

const compiled: CompiledRoute[] = Object.entries(AGENCY_CORE_ROUTE_OWNERS).map(([key, owner]) => {
  const [method, path] = key.split(' ') as [string, string];
  const source = path.split('/').map((seg) => (seg === ':id' ? '([^/]+)' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return { method, pattern: new RegExp(`^${source}$`), owner };
});

/**
 * The owner of an internal request, from its method and URL (`/api/v1/agency/...`, query
 * allowed). A URL outside `/api/v1/agency` is `none`; an agency URL the table does not
 * list is null (Fastify would answer it 404 wherever it ran).
 */
export function resolveCoreRoute(method: string, url: string): CoreRouteMatch | null {
  const path = url.split('?')[0] ?? '';
  if (path !== AGENCY_CORE_PREFIX && !path.startsWith(`${AGENCY_CORE_PREFIX}/`)) return { owner: 'none', id: null };
  const rel = path.slice(AGENCY_CORE_PREFIX.length);
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const route of compiled) {
    if (route.method !== m) continue;
    const hit = route.pattern.exec(rel);
    if (hit) return { owner: route.owner, id: hit[1] !== undefined ? decodeURIComponent(hit[1]) : null };
  }
  return null;
}

/**
 * Throws when an agency route registered on the internal instance is not in the table.
 * Called from `buildCoreHandlers`' `onRoute`, so the omission fails at boot and in every
 * test that builds the instance.
 */
export function assertCoreRouteClassified(method: string | string[], url: string): void {
  if (url !== AGENCY_CORE_PREFIX && !url.startsWith(`${AGENCY_CORE_PREFIX}/`)) return;
  const rel = url.slice(AGENCY_CORE_PREFIX.length);
  for (const m of Array.isArray(method) ? method : [method]) {
    const verb = m.toUpperCase() === 'HEAD' ? 'GET' : m.toUpperCase();
    if (!(`${verb} ${rel}` in AGENCY_CORE_ROUTE_OWNERS)) {
      throw new Error(`internal route ${verb} ${url} has no owner in AGENCY_CORE_ROUTE_OWNERS (src/api/core-owners.ts): decide which process it runs in`);
    }
  }
}
