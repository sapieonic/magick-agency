import { createChildLogger } from '@magick-agency/observability';
import { agencyListenSessionRepository, type ListenSessionRecord } from '../../db/repositories/agency.repository.js';
import type { ListenRegistry, ListenSessionHandle } from './listen-registry.js';

const log = createChildLogger({ component: 'agency-listen-revocation' });

/*
 * How a supervisor's listens are ended from outside the process that holds them (LS10, LS5):
 *
 *  - **Revocation.** The routes that change a role or remove a member (`api/routes/user.routes.ts`,
 *    where the membership cache is cleared) call {@link revokeListens}. In one process the handler
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
 * their open rows, newest first, past `maxPerUser` counting this registry's own, those not held
 * here (another replica's). Empty when there is nothing to end elsewhere.
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
  // Newest first; the cap keeps the newest (this one among them).
  const keep = Math.max(1, registry.limits.maxPerUser);
  const past = open.filter((r) => r.id !== session.listenId).slice(keep - 1);
  return past.filter((r) => r.replica_id !== replicaId && registry.get(r.id) === undefined).map((r) => r.id);
}
