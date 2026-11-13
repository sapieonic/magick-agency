package com.magickagency.agent.ring

import android.content.Context
import android.content.SharedPreferences

/**
 * What the ring keeps across a process start: the FCM token, the ring the agent answered before
 * Flutter was running (`pendingAnswer`, for a cold start from the full-screen intent; cleared on
 * read, on bind and on any end, and dropped once the grace has lapsed), a "Stop ringing" tap
 * Dart has not heard yet, the absence the away notification shows, and the `ring_off` that ended
 * it (for Dart's `takeRingOff`). App-private preferences; the app allows no backup.
 */
internal class RingStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var stopRingingUnheard: Boolean
        get() = prefs.getBoolean(KEY_STOP_RINGING, false)
        set(value) = prefs.edit().putBoolean(KEY_STOP_RINGING, value).apply()

    fun savePendingAnswer(answer: PendingAnswer) {
        // commit, not apply: the only write that must be on disk before this returns. The answer
        // is the one thing a cold start needs from here, and the process may be gone (the system
        // reclaims it while MainActivity starts) before apply's background write would land.
        prefs.edit()
            .putString(KEY_PA_CALL, answer.callId)
            .putString(KEY_PA_TOKEN, answer.offerToken)
            .putString(KEY_PA_SESSION, answer.sessionId)
            .putLong(KEY_PA_AT, answer.answeredAtMs)
            .commit()
    }

    fun readPendingAnswer(): PendingAnswer? {
        val call = prefs.getString(KEY_PA_CALL, null) ?: return null
        val token = prefs.getString(KEY_PA_TOKEN, null) ?: return null
        val session = prefs.getString(KEY_PA_SESSION, null) ?: return null
        return PendingAnswer(call, token, session, prefs.getLong(KEY_PA_AT, 0L))
    }

    /**
     * apply, not commit: a clear that is lost with the process leaves an answer whose grace has
     * lapsed by the next start ([PendingAnswer.isFresh] drops it), so nothing waits on the disk.
     */
    fun clearPendingAnswer() {
        prefs.edit().remove(KEY_PA_CALL).remove(KEY_PA_TOKEN).remove(KEY_PA_SESSION).remove(KEY_PA_AT).apply()
    }

    /** The latest absence the away notification was shown for ([RingStateMachine.away]), across a process start. */
    var away: AwayAbsence?
        get() {
            if (!prefs.contains(KEY_AWAY_SHOWN)) return null
            return AwayAbsence(
                sessionId = prefs.getString(KEY_AWAY_SESSION, null),
                sinceMs = prefs.getLong(KEY_AWAY_SINCE, -1L).takeIf { it >= 0 },
                shown = prefs.getBoolean(KEY_AWAY_SHOWN, false),
            )
        }
        set(value) {
            val e = prefs.edit()
            if (value == null) {
                e.remove(KEY_AWAY_SESSION).remove(KEY_AWAY_SINCE).remove(KEY_AWAY_SHOWN)
            } else {
                e.putBoolean(KEY_AWAY_SHOWN, value.shown)
                if (value.sessionId != null) e.putString(KEY_AWAY_SESSION, value.sessionId) else e.remove(KEY_AWAY_SESSION)
                if (value.sinceMs != null) e.putLong(KEY_AWAY_SINCE, value.sinceMs) else e.remove(KEY_AWAY_SINCE)
            }
            e.apply()
        }

    /** The latest `ring_off` that ended the shown absence, kept for Dart's `takeRingOff` (cleared on read, and when a new absence shows). */
    var ringOff: RingEffect.RingOff?
        get() {
            if (!prefs.getBoolean(KEY_OFF_SET, false)) return null
            return RingEffect.RingOff(
                reason = prefs.getString(KEY_OFF_REASON, null),
                sessionId = prefs.getString(KEY_OFF_SESSION, null),
                awaySinceMs = prefs.getLong(KEY_OFF_SINCE, -1L).takeIf { it >= 0 },
            )
        }
        set(value) {
            val e = prefs.edit().remove(KEY_OFF_REASON).remove(KEY_OFF_SESSION).remove(KEY_OFF_SINCE)
            if (value == null) {
                e.remove(KEY_OFF_SET)
            } else {
                e.putBoolean(KEY_OFF_SET, true)
                value.reason?.let { e.putString(KEY_OFF_REASON, it) }
                value.sessionId?.let { e.putString(KEY_OFF_SESSION, it) }
                value.awaySinceMs?.let { e.putLong(KEY_OFF_SINCE, it) }
            }
            e.apply()
        }

    private companion object {
        const val FILE = "magick_agency_ring"
        const val KEY_TOKEN = "fcm_token"
        const val KEY_STOP_RINGING = "stop_ringing_unheard"
        const val KEY_PA_CALL = "pending_answer_call_id"
        const val KEY_PA_TOKEN = "pending_answer_offer_token"
        const val KEY_PA_SESSION = "pending_answer_session_id"
        const val KEY_PA_AT = "pending_answer_at"
        const val KEY_AWAY_SESSION = "away_session_id"
        const val KEY_AWAY_SINCE = "away_since"
        const val KEY_AWAY_SHOWN = "away_shown"
        const val KEY_OFF_SET = "ring_off_set"
        const val KEY_OFF_REASON = "ring_off_reason"
        const val KEY_OFF_SESSION = "ring_off_session_id"
        const val KEY_OFF_SINCE = "ring_off_away_since"
    }
}
