import { createChildLogger } from '@magick-agency/observability';
import { announcementRepository } from '@magick-agency/db/repositories/announcement.repository';
import { audioFileRepository } from '@magick-agency/db/repositories/audio-file.repository';
import { ensurePcmClip } from '../audio/ensure-pcm-clip.js';

const log = createChildLogger({ component: 'agency-abandon-clip' });

/**
 * ─── THE APOLOGY CLIP AN ABANDONED CALL PLAYS ───────────────────────────────
 *
 * Resolves a campaign's `abandon_announcement_id` to a hash in the
 * content-addressed clip cache (`ensurePcmClip`), which is the form the bridge
 * plays it in.
 *
 * **The announcement lookup is tenant/account scoped.** This is the only reader of
 * `abandon_announcement_id`, and it runs while a real customer is on the line, so
 * it is the last place a cross-tenant reference could be caught — and the only
 * place where being wrong is audible to the wrong person.
 *
 * **Every failure returns null rather than throwing, and that is the design.**
 * This runs at the moment a real customer has just answered a call with no agent
 * on it. The honest outcomes are "they hear an apology then a hangup" or "they
 * hear a hangup" — never "the dialer throws and the customer sits on an open
 * line while the attempt is left non-terminal". Not configured, deleted, no
 * audio, a failed read or decode: all the same answer, all logged, and the
 * abandoned attempt is recorded either way.
 */

/** Resolution result, kept separate from the hash so the reason is loggable. */
export type AbandonClipOutcome =
  | { hash: string }
  | { hash: null; reason: 'not_configured' | 'not_found' | 'no_content' | 'failed' };

/** Whose announcement this is allowed to be. Never optional — see below. */
export interface AbandonClipScope {
  tenantId: string;
  accountId: string;
}

/**
 * The clip hash for this campaign's apology, or null with a reason.
 *
 * **The scope is mandatory, and a route-level check is not a substitute for it.**
 * The failure mode is another tenant's recorded announcement played into a
 * stranger's ear — a confidentiality breach that is inaudible to us, produces no
 * log line that looks wrong, and cannot be repaired after the fact. The write path
 * validates ownership too, but that is a check at a *different time* from the use:
 * the column is written once and read on every abandoned call thereafter, so an
 * admin tool, a support SQL fix, a bulk import, or an announcement that changes
 * hands all walk straight past it. Same discipline as the agent leases — do not
 * let a check at one moment stand in for a property at another.
 *
 * Deliberately **not** cached in-process. It is read once per abandoned call, and
 * abandonment is rare by construction (strict power dialing: an agent is reserved
 * before every dial) — an operator who fixes a wrong apology mid-campaign should
 * see the fix on the next abandoned call, not after a TTL. The clip *bytes* are
 * already cached by content hash, which is where the
 * cost actually is.
 */
export async function resolveAbandonClip(
  announcementId: string | null | undefined,
  scope: AbandonClipScope,
): Promise<AbandonClipOutcome> {
  if (!announcementId) return { hash: null, reason: 'not_configured' };

  try {
    // Scoped, and `Active` — a soft-deleted announcement is an operator saying
    // "stop using this", which is the same operational fact as never setting one.
    const announcement = await announcementRepository.findActiveByIdScoped(
      announcementId, scope.tenantId, scope.accountId,
    );
    // "Deleted", "never existed" and "belongs to someone else" are deliberately
    // indistinguishable here. There is no apology to play in any of the three, and
    // a scoped lookup cannot tell them apart anyway — which is the right posture:
    // this must never confirm that another tenant's announcement exists.
    if (!announcement) {
      log.warn(
        { announcementId, tenantId: scope.tenantId, accountId: scope.accountId },
        'Abandon announcement not found for this account — hanging up without a clip',
      );
      return { hash: null, reason: 'not_found' };
    }

    if (announcement.type === 'audio') {
      if (!announcement.audio_file_id) return { hash: null, reason: 'no_content' };
      const audioFile = await audioFileRepository.findById(announcement.audio_file_id);
      if (!audioFile) return { hash: null, reason: 'no_content' };
      // `ensurePcmClip` re-decodes from S3 on a cache miss, so this is correct on
      // a replica that has never held the clip — the cache is not authoritative.
      const clip = await ensurePcmClip(audioFile);
      return { hash: clip.hash };
    }

    // The abandon clip is an uploaded file only, never TTS (docs/decisions.md, "Abandon
    // clip"): the schema narrows `announcements.type` to `'audio'`
    // (`packages/db/BASELINE.md`, `announcements`), so an announcement that is not
    // `'audio'` cannot exist. A row that somehow is not audio still answers
    // `no_content` and hangs up cleanly rather than throwing.
    return { hash: null, reason: 'no_content' };
  } catch (err) {
    // An announcement read or audio materialisation failure. The customer gets a
    // clean hangup instead of an open line.
    log.error({ err, announcementId }, 'Could not resolve abandon clip — hanging up without one');
    return { hash: null, reason: 'failed' };
  }
}
