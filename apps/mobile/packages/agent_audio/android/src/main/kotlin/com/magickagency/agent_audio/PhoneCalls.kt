package com.magickagency.agent_audio

/**
 * What the app is told about phone calls that are not its own (a cellular call, ringing or
 * active) while monitoring is on: the state once when it turns on, then each change, never the
 * same state twice in a row. Pure, so it is unit-tested without Android. Main thread only.
 */
internal class PhoneCallTracker {
    private var last: Boolean? = null

    /** Monitoring is on. */
    val running: Boolean get() = last != null

    /** Monitoring turned on with [active] the state now: always reported. */
    fun start(active: Boolean): Boolean {
        last = active
        return active
    }

    /** A reading while monitoring: the state to report, or null when unchanged (or not running). */
    fun update(active: Boolean): Boolean? {
        val previous = last ?: return null
        if (previous == active) return null
        last = active
        return active
    }

    fun stop() {
        last = null
    }
}

/**
 * The app's own ring is live: Mode B rings the phone through the app's self-managed calling
 * account (an inbound call, or the settings card's test ring), and that ring may put the phone in
 * the ringtone audio mode. Set by the app module's ring code (it knows when its ring starts and
 * ends); read wherever an audio-mode reading decides "a phone call that is not ours"
 * ([AudioSessionController.isTelephonyMode]), so the app's own ring never reads as a cellular call
 * (the `phone_call` pause, an audio interruption).
 */
object OwnRing {
    @Volatile
    @JvmStatic
    var live: Boolean = false
}

/**
 * An audio mode, as far as "a phone call that is not ours" goes. Public: the app module's ring
 * (Mode B's busy check) reads the phone with the same rule ([callModeKindOf]).
 */
enum class CallModeKind {
    /** The ringtone mode: a cellular call ringing, or our own ring. */
    RINGTONE,

    /** In call, call screening, call redirect: a cellular call, never ours (ours is VoIP). */
    CELLULAR,

    /** Anything else (normal, our VoIP calls' MODE_IN_COMMUNICATION). */
    OTHER,
}

/**
 * [mode] (`AudioManager.getMode()`) on a phone running API [sdk], classified. Pure, so it is
 * unit-tested: the `AudioManager.MODE_*` and `Build.VERSION_CODES` values are the platform's own
 * constants, written out ([AudioModes]).
 */
fun callModeKindOf(mode: Int, sdk: Int): CallModeKind = when {
    mode == AudioModes.RINGTONE -> CallModeKind.RINGTONE
    mode == AudioModes.IN_CALL ||
        (sdk >= AudioModes.SDK_R && mode == AudioModes.CALL_SCREENING) ||
        (sdk >= AudioModes.SDK_TIRAMISU && mode == AudioModes.CALL_REDIRECT) -> CallModeKind.CELLULAR
    else -> CallModeKind.OTHER
}

/** The platform constants [callModeKindOf] reads (`AudioManager.MODE_*`, `Build.VERSION_CODES`). */
object AudioModes {
    const val RINGTONE = 1
    const val IN_CALL = 2
    const val CALL_SCREENING = 4
    const val CALL_REDIRECT = 5
    const val SDK_R = 30
    const val SDK_TIRAMISU = 33
}

/** Whether a reading of [kind] is a phone call that is not ours; pure, so it is unit-tested. */
fun isOthersPhoneCall(kind: CallModeKind, ownRingLive: Boolean): Boolean = when (kind) {
    CallModeKind.CELLULAR -> true
    CallModeKind.RINGTONE -> !ownRingLive
    CallModeKind.OTHER -> false
}
