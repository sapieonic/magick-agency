/**
 * Which part a process plays when the server runs as several processes on one host
 * (`docs/scaling.md`), and the one rule that assigns work to a media worker.
 *
 * The process the operator starts is the MAIN process: with no workers configured it is
 * the whole server, as it always was; with workers it is the primary, which forks
 * children and tells each its role and slot through the environment. A child never
 * forks.
 */

/** The roles a forked child can be given. */
export const CHILD_ROLES = ['analysis', 'media'] as const;
export type ChildRole = (typeof CHILD_ROLES)[number];

/** Set by the primary on each child it forks; absent on the process the operator started. */
export const PROCESS_ROLE_ENV = 'MA_PROCESS_ROLE';
/** The child's slot within its role, 0-based. Stable across that slot's restarts. */
export const WORKER_SLOT_ENV = 'MA_WORKER_SLOT';

export type ProcessIdentity =
  | { kind: 'main' }
  | { kind: 'child'; role: ChildRole; slot: number };

/**
 * Read this process's identity. Throws on a role or slot it does not know, because a
 * child that guessed would run the wrong work against the shared database.
 */
export function processIdentityFromEnv(env: Readonly<Record<string, string | undefined>>): ProcessIdentity {
  const role = env[PROCESS_ROLE_ENV];
  if (role === undefined || role === '') return { kind: 'main' };
  if (!(CHILD_ROLES as readonly string[]).includes(role)) {
    throw new Error(`${PROCESS_ROLE_ENV} must be one of ${CHILD_ROLES.join(', ')}, got "${role}"`);
  }
  const rawSlot = env[WORKER_SLOT_ENV];
  const slot = rawSlot !== undefined && /^\d{1,4}$/.test(rawSlot) ? Number(rawSlot) : NaN;
  if (!Number.isInteger(slot)) {
    throw new Error(`${WORKER_SLOT_ENV} must be a non-negative integer for a ${role} child, got "${rawSlot ?? ''}"`);
  }
  return { kind: 'child', role: role as ChildRole, slot };
}

/**
 * The slot that owns `key` among `n` (FNV-1a, 32-bit). Deterministic, so a session's
 * station socket, its agent-control requests and its dials all reach the same media
 * worker, and a reconnect lands where its live call is (`docs/scaling.md` §1.4).
 */
export function slotFor(key: string, n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`slot count must be a positive integer, got ${n}`);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % n;
}
