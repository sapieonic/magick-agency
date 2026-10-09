import { ENDPOINTS } from '../config';
import { apiFetch } from './client';
import type {
  NotificationPreferenceUpdate,
  NotificationPreferencesResponse,
} from '../types/notifications';

/**
 * Per-user notification subscriptions.
 *
 * Every call is about the SIGNED-IN user and takes no subject — master reads
 * the caller from the session, and there is no `user_id` to pass. The tenant is
 * threaded through because a person can belong to several and wants a different
 * answer in each; the account is deliberately NOT, since master scopes a digest
 * from the caller's own membership rather than from `X-Account-Id` (an
 * account-scoped member could otherwise preview a sibling account's spend by
 * omitting the header).
 */

export function getNotificationPreferences(
  tenantId: string,
): Promise<NotificationPreferencesResponse> {
  return apiFetch(ENDPOINTS.notifications.preferences, {}, tenantId);
}

/**
 * Save a subscription change.
 *
 * The body is a PATCH, not a replacement: events left out keep whatever they
 * had. Sending only what changed means a client built against an older catalog
 * cannot silently reset an event it has never heard of back to its default.
 */
export function updateNotificationPreferences(
  tenantId: string,
  preferences: NotificationPreferenceUpdate[],
): Promise<{ preferences: Array<{ event_key: string; enabled: boolean }> }> {
  return apiFetch(
    ENDPOINTS.notifications.preferences,
    { method: 'PUT', body: JSON.stringify({ preferences }) },
    tenantId,
  );
}

// PORT NOTE (magick-agency): cusui's `previewDigest` (`POST
// /notifications/digests/preview`, master's credits usage digest) is removed —
// see `pages/settings/NotificationSettingsPage.tsx`.
