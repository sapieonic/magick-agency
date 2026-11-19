import { brand } from './brand';

/**
 * Where the API lives. Empty by default: the server serves `/super-admin/*` on
 * the same origin in production, and Vite proxies it in dev.
 */
export const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

/**
 * The `x-mgkvc-originator` value: `magick-agency-super-admin`. The header NAME is
 * wire, not branding, and is unchanged (decision B17).
 */
export const ORIGINATOR_HEADER = 'x-mgkvc-originator';
export const ORIGINATOR = `${brand.id}-super-admin`;

/**
 * `X-Client: <originator>/<version>` (`magick-agency-super-admin/<version>`): which build of this UI
 * sent a request. The server reads it into `clientApp` / `clientVersion` on every log line
 * the request produces (`apps/server/src/utils/client-header.ts`), as it does for the mobile
 * app. Logging only: never an auth input or a rate-limit key.
 */
export const CLIENT_HEADER = 'X-Client';
export const CLIENT = `${ORIGINATOR}/${__APP_VERSION__}`;

/** The headers every request to the API carries: who sent it, and which build. */
export const CLIENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [ORIGINATOR_HEADER]: ORIGINATOR,
  [CLIENT_HEADER]: CLIENT,
});
