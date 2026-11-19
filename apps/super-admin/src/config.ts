import { clientHeaders, ORIGINATOR_HEADER } from '@magick-agency/web-ui/clientHeaders';
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
export { ORIGINATOR_HEADER };
export const ORIGINATOR = `${brand.id}-super-admin`;

/** The headers every request to the API carries: who sent it, and which build. */
export const CLIENT_HEADERS = clientHeaders(ORIGINATOR, __APP_VERSION__);
