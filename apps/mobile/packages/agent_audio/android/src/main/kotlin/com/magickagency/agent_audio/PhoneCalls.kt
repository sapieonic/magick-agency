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
