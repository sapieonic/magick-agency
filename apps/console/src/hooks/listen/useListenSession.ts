import { useEffect, useState, useSyncExternalStore } from 'react';
import { grantListen } from '../../api/liveCalls';
import { toAbsoluteWsUrl } from '../../utils/agencyStationWsUrl';
import {
  ListenSessionController,
  type ListenSessionDeps,
  type ListenSocket,
} from '../../utils/listen/listenSessionController';
import type { ListenSessionState } from '../../utils/listen/listenSessionReducer';
import type { AgencyListenLeg } from '../../types/live-calls';

/**
 * One supervisor's listen in this console (`docs/listening.md` §4): grant → socket → `ready` →
 * audio, `ping` every 10 s, reconnect with a fresh grant for up to 15 s after a drop, and every
 * way it ends. The states are `listenSessionReducer`'s and the side effects
 * `ListenSessionController`'s; this hook binds them to React and to the tenant's headers.
 *
 * One per listening bar (`ListenProvider`). Unmounting stops the listen: leaving the console
 * shell or the account ends it.
 */
export interface UseListenSessionOptions {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  onAudio: (leg: AgencyListenLeg, frame: Uint8Array) => void;
  onAttach?: () => void;
  /** Tests inject a socket; the default resolves `ws_url` onto the API host (`toAbsoluteWsUrl`). */
  openSocket?: (url: string) => ListenSocket;
}

export interface ListenSession {
  state: ListenSessionState;
  controller: ListenSessionController;
}

function defaultOpenSocket(url: string): ListenSocket {
  return new WebSocket(toAbsoluteWsUrl(url)) as unknown as ListenSocket;
}

export function useListenSession(options: UseListenSessionOptions): ListenSession {
  const deps: ListenSessionDeps = {
    grant: (callId) => grantListen(callId, options.tenantId ?? undefined, options.accountId ?? undefined),
    openSocket: options.openSocket ?? defaultOpenSocket,
    onAudio: options.onAudio,
    onAttach: options.onAttach,
  };
  const [controller] = useState(() => new ListenSessionController(deps));
  controller.setDeps(deps);

  // `destroy` leaves the controller usable, so StrictMode's mount, unmount, mount is harmless.
  useEffect(() => () => controller.destroy(), [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return { state, controller };
}
