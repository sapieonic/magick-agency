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
