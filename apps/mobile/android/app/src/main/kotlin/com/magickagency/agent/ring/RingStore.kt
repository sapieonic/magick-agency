package com.magickagency.agent.ring

import android.content.Context
import android.content.SharedPreferences

/**
 * What the ring keeps across a process start: the FCM token, the ring the agent answered before
 * Flutter was running (`pendingAnswer`, for a cold start from the full-screen intent; cleared on
 * read, on bind and on any end, and dropped once the grace has lapsed), a "Stop ringing" tap
 * Dart has not cleared yet and the decline window it opened, the server clock offset Dart
 * measured, the absence the away notification shows, and the `ring_off` that ended it (for
 * Dart's `takeRingOff`). App-private preferences; the app allows no backup.
 */
internal class RingStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    /**
     * The away notification's "Stop ringing" Dart has not cleared yet (`peekStopRinging`, cleared
     * by `clearStopRinging` once `device_away` applied): the session of the absence it was tapped
     * in (null when unknown) and when, or null when there is none. A record from a build that did
     * not keep the tap's time reads as tapped at 0, so it is never fresh.
     */
    val stopRinging: StopRingingRecord?
        get() {
            if (!prefs.getBoolean(KEY_STOP_RINGING, false)) return null
            return StopRingingRecord(
                sessionId = prefs.getString(KEY_STOP_SESSION, null),
                tappedAtMs = prefs.getLong(KEY_STOP_AT, 0L),
            )
        }

    /**
     * Keeps a "Stop ringing" tap and the decline window it opened ([declineUntilMs]) in one write.
     * commit, not apply: the tap's launch may be a cold start that reads the tap in a new process,
     * and a process the system reclaims right after the tap must still decline a ring arriving in
     * the window when it starts again. One commit covers both.
     */
    fun saveStopRinging(record: StopRingingRecord, declineUntilMs: Long) {
        val e = prefs.edit().remove(KEY_STOP_SESSION)
            .putBoolean(KEY_STOP_RINGING, true)
            .putLong(KEY_STOP_AT, record.tappedAtMs)
            .putLong(KEY_DECLINE_UNTIL, declineUntilMs)
        record.sessionId?.let { e.putString(KEY_STOP_SESSION, it) }
        e.commit()
    }

    /**
     * apply, not commit: a clear lost with the process leaves a tap that is dropped unread once it
     * is [RingWire.STOP_RINGING_KEEP_MS] old, and asking `device_away` again meanwhile is harmless.
     */
    fun clearStopRinging() {
        prefs.edit().remove(KEY_STOP_RINGING).remove(KEY_STOP_SESSION).remove(KEY_STOP_AT).apply()
    }

    /** Until then (this phone's clock) a ring is declined at once ("Stop ringing"); 0 when none was kept. */
    val declineUntilMs: Long
        get() = prefs.getLong(KEY_DECLINE_UNTIL, 0L)

    /**
     * The server clock offset Dart measured (`setServerClock`), for a ring's time left. apply, not
     * commit: Dart says it again each time the station parks for `away_ring`, and a ring without it
     * falls back to the push's send time.
     */
    var serverClock: ServerClockOffset?
        get() {
            if (!prefs.contains(KEY_CLOCK_OFFSET) || !prefs.contains(KEY_CLOCK_AT)) return null
            return ServerClockOffset(prefs.getLong(KEY_CLOCK_OFFSET, 0L), prefs.getLong(KEY_CLOCK_AT, 0L))
        }
        set(value) {
            val e = prefs.edit()
            if (value == null) {
                e.remove(KEY_CLOCK_OFFSET).remove(KEY_CLOCK_AT)
            } else {
                e.putLong(KEY_CLOCK_OFFSET, value.offsetMs).putLong(KEY_CLOCK_AT, value.measuredAtMs)
            }
            e.apply()
        }

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
        const val KEY_STOP_RINGING = "stop_ringing_pending"
        const val KEY_STOP_SESSION = "stop_ringing_session_id"
        const val KEY_STOP_AT = "stop_ringing_tapped_at"
        const val KEY_DECLINE_UNTIL = "stop_ringing_decline_until"
        const val KEY_CLOCK_OFFSET = "server_clock_offset_ms"
        const val KEY_CLOCK_AT = "server_clock_measured_at"
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
