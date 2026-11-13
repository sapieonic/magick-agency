package com.magickagency.agent_audio

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.Handler

/**
 * Reports a phone call that is not ours (`{type: phoneCall, active}`), with no runtime
 * permission (never READ_PHONE_STATE): a cellular call shows as the audio mode switching to a
 * telephony mode (RINGTONE, IN_CALL, CALL_SCREENING, CALL_REDIRECT:
 * [AudioSessionController.isTelephonyMode]), and the app's own calls use MODE_IN_COMMUNICATION,
 * which is not one, so our own call never reads as a phone call; nor does the ringtone mode while
 * the app's own ring is live ([OwnRing]). On API 31+
 * `OnModeChangedListener` tells us; below that the mode is read once a second, only while
 * monitoring is on (the app turns it on while the agent waits for calls). Main thread only;
 * the dedupe is [PhoneCallTracker]'s.
 */
internal class PhoneCallMonitor(
    private val context: Context,
    private val main: Handler,
    private val emit: (Map<String, Any?>) -> Unit,
) {
    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val tracker = PhoneCallTracker()

    private val modeListener: Any? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        AudioManager.OnModeChangedListener { mode -> report(tracker.update(AudioSessionController.isTelephonyMode(mode))) }
    } else {
        null
    }

    private val poll = object : Runnable {
        override fun run() {
            if (!tracker.running) return
            report(tracker.update(current()))
            main.postDelayed(this, POLL_MS)
        }
    }

    /** Idempotent. Turning it on reports the state now. */
    fun setEnabled(enabled: Boolean) {
        if (enabled == tracker.running) return
        if (enabled) {
            report(tracker.start(current()))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.addOnModeChangedListener(context.mainExecutor, modeListener as AudioManager.OnModeChangedListener)
            } else {
                main.postDelayed(poll, POLL_MS)
            }
        } else {
            tracker.stop()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.removeOnModeChangedListener(modeListener as AudioManager.OnModeChangedListener)
            } else {
                main.removeCallbacks(poll)
            }
        }
    }

    fun release() = setEnabled(false)

    private fun current(): Boolean = AudioSessionController.isTelephonyMode(am.mode)

    private fun report(active: Boolean?) {
        if (active != null) emit(mapOf("type" to "phoneCall", "active" to active))
    }

    companion object {
        /** Below API 31: how often the mode is read while monitoring is on. */
        const val POLL_MS = 1_000L
    }
}
