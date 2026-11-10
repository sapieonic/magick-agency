import type { AgencyInboundClipSlot } from '@magick-agency/contracts/agency';
import type { AgencyInboundStandardRecording } from '@magick-agency/contracts/api/agency/inbound';
import { createChildLogger } from '@magick-agency/observability';
import { audioFileRepository } from '@magick-agency/db/repositories/audio-file.repository';
import { ensurePcmClip } from '../../audio/ensure-pcm-clip.js';
import type { AgencyInboundRouteRecord } from '../../db/repositories/agency.repository.js';
import { standardClipHash } from './inbound-standard-clips.js';

const log = createChildLogger({ component: 'agency-inbound-clips' });

/**
 * ─── WHAT AN INBOUND CALLER HEARS, AS CLIPS (docs/inbound.md §3.4) ────────────────
 *
 * A route names an uploaded audio file per slot (`greeting_audio_id`, …, the route's `clips`);
 * this resolves each to a hash in the content-addressed clip cache (`ensurePcmClip`), the form
 * the bridge plays (`playClipSequenceThenHangUp`, `playInboundHold`, `recordInboundAudio`),
 * exactly as the abandon clip does (`abandon-clip.ts`).
 *
 * **No caller is put down in silence.** A part asked for with a standard recording
 * (`{ slot, standard }`) plays the route's recording when it has one that plays, else our
 * standard recording (`inbound-standard-clips.ts`: please hold, the recording notice, closed,
 * busy, call-back, the voicemail prompt). A part asked for as a bare slot plays the route's
 * recording or nothing: a greeting before a closed, busy or call-back message is skipped when
 * unset. Which parts stand in is the caller's choice (the router: `AGENCY_INBOUND_SLOT_STANDARD` for what
 * the connector plays, the message slots for the rest); the hold slot never does (an unset hold
 * slot plays the built-in hold tone). The carrier's spoken stand-in (`<Speak>`) is only for a call
 * answered before anything streams, and says the standard recording's words.
 *
 * **The lookup is tenant AND account scoped**, as the abandon clip's (`findByIdScoped`): the
 * route's clip columns are FKs to `audio_files` with no tenant check in SQL (the API checks it at
 * write time), and this runs with a stranger on the line, the last place a cross-account
 * reference can be caught.
 *
 * **Every failure is "nothing to play" for that part, logged, never a throw** (a recording that is
 * set but missing, another account's, or undecodable falls back to the standard recording when the
 * part has one): a caller on an open line hears the rest of the sequence and is put down.
 */

/**
 * One part of what a caller hears: a bare slot (the route's recording, or nothing), or a slot
 * with the standard recording that stands in for it (`slot: null`: the standard recording alone).
 */
export type InboundClipPart =
  | AgencyInboundClipSlot
  | { slot: AgencyInboundClipSlot | null; standard: AgencyInboundStandardRecording | null };

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

/** One uploaded recording's clip hash, or null (unset, not this account's, missing, undecodable). */
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

/** One part's hash: the route's recording, else the standard recording that stands in for it, else null. */
async function resolvePart(
  route: AgencyInboundRouteRecord | null,
  part: InboundClipPart,
  scope: { tenantId: string; accountId: string },
): Promise<string | null> {
  const { slot, standard } = typeof part === 'string' ? { slot: part, standard: null } : part;
  const own = slot ? await resolveInboundClip(routeClipId(route, slot), scope) : null;
  if (own) return own;
  return standard ? standardClipHash(standard) : null;
}

/** The hashes for `parts` in order, the parts with nothing to play left out. Never throws. */
export async function resolveInboundClips(
  route: AgencyInboundRouteRecord | null,
  parts: readonly InboundClipPart[],
  scope: { tenantId: string; accountId: string },
): Promise<string[]> {
  const hashes = await Promise.all(parts.map((part) => resolvePart(route, part, scope)));
  return hashes.filter((h): h is string => h !== null);
}
