package com.magickagency.agent.ring

import android.content.Context
import android.content.SharedPreferences

/**
 * What the ring keeps across a process start: the FCM token, the ring the agent answered before
 * Flutter was running (`pendingAnswer`, for a cold start from the full-screen intent; cleared on
 * read, on bind and on any end, and dropped once the grace has lapsed), and a "Stop ringing" tap
 * Dart has not heard yet. App-private preferences; the app allows no backup.
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

    private companion object {
        const val FILE = "magick_agency_ring"
        const val KEY_TOKEN = "fcm_token"
        const val KEY_STOP_RINGING = "stop_ringing_unheard"
        const val KEY_PA_CALL = "pending_answer_call_id"
        const val KEY_PA_TOKEN = "pending_answer_offer_token"
        const val KEY_PA_SESSION = "pending_answer_session_id"
        const val KEY_PA_AT = "pending_answer_at"
    }
}
