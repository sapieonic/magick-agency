/**
 * The primary's `DialDispatcher` with media workers (`docs/scaling.md` §3.1): sends each
 * cleared dial to the worker holding the agent's station, as `dial.execute`, with the
 * leadership grant it was issued under.
 *
 * What each outcome means to the pacing tick that awaits it, and why:
 *  - **the worker answered ok**: resolves.
 *  - **the worker answered an error** (`executeDial` threw, or the owner check refused):
 *    throws, and pacing ends the attempt `failed` and returns the pair, as it does for a
 *    local dispatch that throws.
 *  - **not sent** (the owner is not a live replica, the slot is not ready, the channel is
 *    closed or full): throws {@link DispatchRefusedError}, the same.
 *  - **timeout, or the worker died after it was sent**: resolves and logs. The outcome is
 *    the worker's (it may be bridging the call) or the slot reap's (it died): throwing
 *    would make pacing a second writer of a row someone else owns.
 *
 * The pre-dial clearance is checked here, before anything is sent, exactly as
 * `LocalDialDispatcher` checks it: the brand cannot cross a process boundary, so this is
 * the last place it can be read.
 */
import { createChildLogger } from '@magick-agency/observability';
import { rejectClearance } from '../agency/pre-dial-gates.js';
import type { ClearedDialCommand, DialCommand, DialDispatcher, DialOptions } from '../agency/dial-dispatcher.js';
import { IpcRequestError, type IpcChannel } from './ipc-channel.js';

const log = createChildLogger({ component: 'ipc-dial-dispatcher' });

/**
 * Deadline for a dial: VoiceLink login 10 s + `add_lead` 15 s + the database around them.
 * A 401 retry (a second login and `add_lead`) can run to ~50 s, past it; that is safe, because
 * a timeout is not a failure here: the primary logs and resolves, and the worker still owns
 * and settles the attempt (below).
 */
export const DIAL_EXECUTE_DEADLINE_MS = 40_000;

export class DispatchRefusedError extends Error {
  constructor(readonly reason: 'owner_down' | 'not_sent', message: string) {
    super(message);
    this.name = 'DispatchRefusedError';
  }
}

export interface IpcDialDispatcherDeps {
  /** The ready channel of the worker running under `replicaId`, or null. */
  channelForReplica: (replicaId: string) => IpcChannel | null;
  /** The grant the campaign is led under (`PacingEngine.leadershipGrant`). */
  grantFor: (campaignId: string) => number | null;
}

export class IpcDialDispatcher implements DialDispatcher {
  constructor(private readonly deps: IpcDialDispatcherDeps) {}

  async dispatch(cmd: ClearedDialCommand, opts?: DialOptions): Promise<void> {
    const rejection = rejectClearance(cmd.clearance, cmd.contactId, new Date());
    if (rejection) {
      log.error({ attemptId: cmd.attemptId, contactId: cmd.contactId, rejection }, 'Dial command without a valid pre-dial clearance — refusing');
      throw new Error(`Dial without pre-dial clearance (${rejection}) for contact ${cmd.contactId}`);
    }
    // The tick asks the engine itself one last time before it sends; the worker asks its
    // pushed grant from then on.
    if (opts?.stillAuthorised && !opts.stillAuthorised()) {
      throw new DispatchRefusedError('not_sent', 'pacing no longer authorises this campaign');
    }
    const grant = this.deps.grantFor(cmd.campaignId);
    if (grant === null) throw new DispatchRefusedError('not_sent', `no leadership grant for campaign ${cmd.campaignId}`);
    const channel = this.deps.channelForReplica(cmd.ownerReplica);
    if (!channel) {
      throw new DispatchRefusedError('owner_down', `no live media worker runs replica ${cmd.ownerReplica}`);
    }
    const { clearance: _clearance, ...plain } = cmd;
    const value: DialCommand = plain;
    try {
      await channel.request('dial.execute', { cmd: value, grant }, { deadlineMs: DIAL_EXECUTE_DEADLINE_MS });
    } catch (err) {
      if (err instanceof IpcRequestError) {
        if (err.code === 'timeout' || err.code === 'gone') {
          log.warn({ attemptId: cmd.attemptId, owner: cmd.ownerReplica, code: err.code },
            'Dial sent to the media worker with no answer; its outcome is the worker\'s (or the slot reap\'s)');
          return;
        }
        if (err.code === 'refused') throw new DispatchRefusedError('not_sent', err.message);
      }
      throw err;
    }
  }
}

/**
 * The worker's side of dial authority: grants withdrawn by the primary's
 * `pacing.revoke` events, read synchronously by `stillAuthorised`. The channel is FIFO,
 * so a withdrawal sent after a dial arrives while that dial's `executeDial` is awaiting,
 * exactly when an in-process flag flip would be seen.
 */
export class DialGrants {
  private stoppedUpTo = -1;
  private readonly revokedUpTo = new Map<string, number>();

  revoke(campaignId: string | null, upTo: number): void {
    if (campaignId === null) {
      this.stoppedUpTo = Math.max(this.stoppedUpTo, upTo);
      return;
    }
    this.revokedUpTo.set(campaignId, Math.max(this.revokedUpTo.get(campaignId) ?? -1, upTo));
  }

  /** `stillAuthorised` for a dial issued under `grant`. */
  checker(campaignId: string, grant: number): () => boolean {
    return () => grant > this.stoppedUpTo && grant > (this.revokedUpTo.get(campaignId) ?? -1);
  }
}
