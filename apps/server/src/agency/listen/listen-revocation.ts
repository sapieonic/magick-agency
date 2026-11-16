import { createChildLogger } from '@magick-agency/observability';
import { agencyListenSessionRepository, type ListenSessionRecord } from '../../db/repositories/agency.repository.js';
import type { ListenRegistry, ListenSessionHandle } from './listen-registry.js';

const log = createChildLogger({ component: 'agency-listen-revocation' });

/*
 * How a supervisor's listens are ended from outside the process that holds them (LS10, LS5):
 *
 *  - **Revocation.** The routes that change a role or remove a member (`api/routes/user.routes.ts`,
 *    where the membership cache is cleared, and the super-admin's), and those that add a seat which
 *    may shadow a wider one (`POST /users/invite`, the invite claim in `invites.routes.ts`), call
 *    {@link revokeListens}. In one process the handler
 *    is the runtime's registry (`revokeUser`: a re-check of that supervisor against the database);
 *    with media workers the primary also sends `listen.revoke` to every worker, which does the same.
 *    Registered by the bootstraps ({@link onListenRevocation}); with none registered (a process
 *    without the agency runtime) it does nothing.
 *  - **Supersede across processes.** One listen per supervisor (`maxPerUser`): a listen admitted in
 *    one media worker ends the supervisor's older ones in the others. {@link remoteSupersedeTargets}
 *    reads their open rows and names the ones to end; the worker sends them to the primary, which
 *    ends its own and relays them to the other workers.
 * Never throws: a revocation that could not be delivered is caught by the periodic re-check.
 */

type RevocationHandler = (tenantId: string, userId: string) => Promise<unknown> | unknown;

const handlers = new Set<RevocationHandler>();

/** Register a handler for {@link revokeListens}. Returns the unsubscribe. */
export function onListenRevocation(handler: RevocationHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

/** A supervisor's access changed in a tenant: end their listens that may no longer go on. */
export async function revokeListens(tenantId: string, userId: string): Promise<void> {
  await Promise.all([...handlers].map(async (handler) => {
    try {
      await handler(tenantId, userId);
    } catch (err) {
      log.warn({ err, tenantId, userId }, 'A listen revocation handler failed — the periodic re-check will end what it missed');
    }
  }));
}

/**
 * The listens of `session`'s supervisor held by OTHER processes that its admission supersedes:
 * their open rows OLDER than this session's own row (by `started_at`, then id), newest first, past
 * `maxPerUser` counting this one, those not held here (another replica's). Empty when there is
 * nothing to end elsewhere.
 *
 * Only older rows: two listens admitted at once in two workers each read the other's row, and
 * each superseding every other row would end both. Ranked by the rows themselves (the database's
 * `started_at`, one clock), the newer one ends the older and the older ends nothing; a newer row
 * past the cap is that newer listen's own admission to settle.
 */
export async function remoteSupersedeTargets(
  session: ListenSessionHandle,
  registry: Pick<ListenRegistry, 'get' | 'limits'>,
  /** This process: its rows are its registry's to end (already, by the admission). */
  replicaId: string,
  readOpen: (tenantId: string, userId: string) => Promise<ListenSessionRecord[]> =
    (t, u) => agencyListenSessionRepository.listOpenForListener(t, u),
): Promise<string[]> {
  const open = await readOpen(session.tenantId, session.listenerUserId);
  const mine = open.find((r) => r.id === session.listenId);
  // Its own row is written before the admission; without it (closed already: it ended under the
  // read) there is nothing for it to supersede.
  if (!mine) return [];
  const at = (r: ListenSessionRecord) => new Date(r.started_at).getTime();
  const olderThanMine = (r: ListenSessionRecord) => at(r) < at(mine) || (at(r) === at(mine) && r.id < mine.id);
  // Newest first; the cap keeps the newest (this one among them).
  const older = open.filter((r) => r.id !== mine.id && olderThanMine(r)).sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : -1));
  const keep = Math.max(1, registry.limits.maxPerUser);
  const past = older.slice(keep - 1);
  return past.filter((r) => r.replica_id !== replicaId && registry.get(r.id) === undefined).map((r) => r.id);
}
