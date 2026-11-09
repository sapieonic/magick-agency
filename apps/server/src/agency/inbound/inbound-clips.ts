import type { AgencyInboundClipSlot } from '@magick-agency/contracts/agency';
import { createChildLogger } from '@magick-agency/observability';
import { audioFileRepository } from '@magick-agency/db/repositories/audio-file.repository';
import { ensurePcmClip } from '../../audio/ensure-pcm-clip.js';
import type { AgencyInboundRouteRecord } from '../../db/repositories/agency.repository.js';

const log = createChildLogger({ component: 'agency-inbound-clips' });

/**
 * ─── WHAT AN INBOUND CALLER HEARS, AS CLIPS (docs/inbound.md §3, P1) ─────────────────────
 *
 * A route names an uploaded audio file per slot (`greeting_audio_id`, …, the route's `clips`);
 * this resolves each to a hash in the content-addressed clip cache (`ensurePcmClip`), the form
 * the bridge plays (`playClipSequenceThenHangUp`), exactly as the abandon clip does
 * (`abandon-clip.ts`).
 *
 * **A slot with no clip is never silence.** There is no recorded built-in audio in this product
 * (launch decision 4: uploaded audio files only). The router decides before it streams: a call
 * whose message slot (closed, "we'll call you back", busy) has no clip is answered with the
 * carrier's spoken message instead (`<Speak>`, `plivo-inbound.webhook.ts`) and never streams; a
 * greeting or recording notice with no clip is simply not played (docs/inbound.md §3.4). What is
 * left to this file is a clip that is set but cannot be played (missing, another account's,
 * undecodable): skipped, logged.
 *
 * **The lookup is tenant AND account scoped**, as the abandon clip's (`findByIdScoped`): the
 * route's clip columns are FKs to `audio_files` with no tenant check in SQL (the API checks it at
 * write time), and this runs with a stranger on the line, the last place a cross-account
 * reference can be caught.
 *
 * **Every failure is "nothing to play" for that slot, logged, never a throw**: a caller on an
 * open line hears the rest of the sequence and is put down.
 */

/** The slot's audio file id on a route. */
const SLOT_COLUMN: Record<AgencyInboundClipSlot, keyof AgencyInboundRouteRecord> = {
  greeting: 'greeting_audio_id',
  hold: 'hold_audio_id',
  closed: 'closed_audio_id',
  busy: 'busy_audio_id',
  recording_notice: 'recording_notice_audio_id',
  callback: 'callback_audio_id',
};

/** The route's clip id for `slot`, or null when none is set. */
export function routeClipId(route: AgencyInboundRouteRecord | null, slot: AgencyInboundClipSlot): string | null {
  if (!route) return null;
  const id = route[SLOT_COLUMN[slot]];
  return typeof id === 'string' && id ? id : null;
}

/** One slot's clip hash, or null (unset, not this account's, missing, undecodable). */
export async function resolveInboundClip(
  audioFileId: string | null,
  scope: { tenantId: string; accountId: string },
): Promise<string | null> {
  if (!audioFileId) return null;
  try {
    const file = await audioFileRepository.findByIdScoped(audioFileId, scope.tenantId, scope.accountId);
    if (!file) {
      log.warn({ audioFileId, tenantId: scope.tenantId, accountId: scope.accountId }, 'Inbound clip not found for this account — skipping it');
      return null;
    }
    return (await ensurePcmClip(file)).hash;
  } catch (err) {
    log.error({ err, audioFileId }, 'Could not resolve an inbound clip — skipping it');
    return null;
  }
}

/** The hashes for `slots` in order, the slots with nothing to play left out. */
export async function resolveInboundClips(
  route: AgencyInboundRouteRecord | null,
  slots: readonly AgencyInboundClipSlot[],
  scope: { tenantId: string; accountId: string },
): Promise<string[]> {
  const hashes = await Promise.all(slots.map((slot) => resolveInboundClip(routeClipId(route, slot), scope)));
  return hashes.filter((h): h is string => h !== null);
}
