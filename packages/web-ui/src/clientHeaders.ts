/** Names the app behind a request (decision B17); the header name is wire, not branding. */
export const ORIGINATOR_HEADER = 'x-mgkvc-originator';

/**
 * The headers every request from a web UI carries: its originator, and `X-Client:
 * <originator>/<version>`, which the server logs as `clientApp` / `clientVersion` on every line
 * the request produces (apps/server/src/utils/client-header.ts). Logging only.
 */
export function clientHeaders(originator: string, version: string): Record<string, string> {
  return { [ORIGINATOR_HEADER]: originator, 'X-Client': `${originator}/${version}` };
}
