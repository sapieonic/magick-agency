import { agencyListenSessionRepository, type ListenSessionRecord } from '../../db/repositories/agency.repository.js';
import { supersededBy, type ListenRegistry, type ListenSessionHandle } from './listen-registry.js';

/*
 * How a supervisor's listens are ended from outside the process that holds them (LS10, LS5):
 *
 *  - **Revocation.** The platform's member routes (a seat added, a role changed, a member removed)
 *    call `membershipAdded` / `membershipRevoked` (`rbac/membership-changed.ts`), whose subscribers
 *    the bootstraps register: in one process the runtime's registry (`revokeUser`: a re-check of
 *    that supervisor against the database); with media workers the primary's `listen.revoke` to
 *    every worker, which does the same.
 *  - **Supersede across processes.** The per-supervisor cap (`maxPerUser`) across media workers:
 *    a listen admitted in one worker ends the supervisor's older listens past the cap wherever
 *    they are. {@link supersedeTargets} reads their open rows and ranks this process's and the
 *    others' together; the worker ends its own and sends the others' to the primary, which relays
 *    them to the other workers (the primary holds no listen while workers run, LS16 e).
 * A revocation that could not be delivered is caught by the periodic re-check.
 */

/** What a listen's admission supersedes in its supervisor's open rows: here, and in other processes. */
export interface SupersedeTargets {
  /** Listen ids this process holds (sessions, or reservations still in their upgrade). */
  here: string[];
  /** Listen ids other processes hold (`listen.revoke` through the primary). */
  elsewhere: string[];
}

/**
 * The listens of `session`'s supervisor that its admission supersedes, by their open rows in
 * every process: those OLDER than this session's own row (by `started_at`, then id), ranked
 * newest first, this process's and the others' together, that {@link supersededBy} ends: their
 * own on the same call, and those past `maxPerUser` counting this one (LS16 e, p, LS22 v). Split
 * by who holds them. The admission here already ended what it saw (this process's sessions
 * alone): with `maxPerUser` 2 or more it may have kept a local listen that a newer one elsewhere
 * pushes past the cap, and that one is in `here`. Ending a session already ended is a no-op.
 *
 * Only older rows: two listens admitted at once in two workers each read the other's row, and
 * each superseding every other row would end both. Ranked by the rows themselves (the database's
 * `started_at`, one clock), the newer one ends the older and the older ends nothing; a newer row
 * past the cap is that newer listen's own admission to settle. And nothing at all once this
 * session has left the registry under the read: a listen with an older row admitted here after it
 * ended it (the registry ranks by admission), and ranking it now would end that one too.
 */
export async function supersedeTargets(
  session: ListenSessionHandle,
  registry: Pick<ListenRegistry, 'get' | 'limits'>,
  /** This process: the rows of its replica are its registry's to end. */
  replicaId: string,
  readOpen: (tenantId: string, userId: string) => Promise<ListenSessionRecord[]> =
    (t, u) => agencyListenSessionRepository.listOpenForListener(t, u),
): Promise<SupersedeTargets> {
  const none: SupersedeTargets = { here: [], elsewhere: [] };
  const open = await readOpen(session.tenantId, session.listenerUserId);
  if (registry.get(session.listenId) !== session) return none;
  const mine = open.find((r) => r.id === session.listenId);
  // Its own row is written before the admission; without it (closed already: it ended under the
  // read) there is nothing for it to supersede.
  if (!mine) return none;
  const at = (r: ListenSessionRecord) => new Date(r.started_at).getTime();
  const olderThanMine = (r: ListenSessionRecord) => at(r) < at(mine) || (at(r) === at(mine) && r.id < mine.id);
  const older = open.filter((r) => r.id !== mine.id && olderThanMine(r)).sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : -1));
  const past = supersededBy(older, (r) => r.call_id === session.callId, registry.limits.maxPerUser);
  const isHere = (r: ListenSessionRecord) => r.replica_id === replicaId || registry.get(r.id) !== undefined;
  return {
    here: past.filter(isHere).map((r) => r.id),
    elsewhere: past.filter((r) => !isHere(r)).map((r) => r.id),
  };
}
