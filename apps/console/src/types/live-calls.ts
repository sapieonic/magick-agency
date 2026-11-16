/**
 * Live calls and listening's wire types live in `@magick-agency/contracts`
 * (`api/agency/live-calls.ts`, re-exporting the socket's vocabulary from `agency/listen.ts`), the
 * one contract the server and the console compile against. This module re-exports it so the
 * console imports them from one place, like every other area under `types/`.
 */
export * from '@magick-agency/contracts/api/agency/live-calls';

import type { AgencyCallListenSession } from '@magick-agency/contracts/api/agency/live-calls';

/**
 * A call detail answer with who listened to the call (LS13). Optional: the call detail routes
 * gain `listen_sessions` with the server side of listening, and a server without it answers the
 * detail alone, which the page shows without the section.
 */
export type WithListenSessions<T> = T & { listen_sessions?: AgencyCallListenSession[] };
