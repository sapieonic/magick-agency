package com.magickagency.agent_audio

import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sin

/**
 * The ringback tone the agent hears while the customer's phone rings on a soft-phone call:
 * 400 + 450 Hz, 0.4 s on, 0.2 s off, 0.4 s on, 2.0 s off, 12 ms linear edges, peak 0.12 of
 * full scale. A line-for-line port of the Dart reference `lib/src/tone/ringback.dart`, which
 * documents the formula; `RingbackTest.kt` asserts the same golden vectors as the Dart test.
 *
 * Owned by the playback thread: [VoiceEngine.playbackLoop] calls [process] on every frame it
 * pops from the jitter buffer, at the wire rate. No allocation.
 */
internal class Ringback(private val sampleRate: Int) {
    /** The index of the next sample to mix. */
    var position = 0L
        private set

    fun reset() {
        position = 0L
    }

    /** Adds the next [count] samples of the tone to [frame], saturating, and advances. */
    fun mix(frame: ShortArray, count: Int = frame.size) {
        for (i in 0 until count) {
            val s = frame[i] + sample(position + i, sampleRate)
            frame[i] = (if (s > 32767) 32767 else if (s < -32768) -32768 else s).toShort()
        }
        position += count
    }

    /** One popped playout frame: mixes while [on]; otherwise rewinds, so the next ring starts
     * at the top of the cadence. */
    fun process(frame: ShortArray, on: Boolean) {
        if (on) mix(frame) else reset()
    }

    companion object {
        const val LOW_HZ = 400
        const val HIGH_HZ = 450
        const val ON1_MS = 400
        const val OFF1_MS = 200
        const val ON2_MS = 400
        const val OFF2_MS = 2000
        const val CYCLE_MS = ON1_MS + OFF1_MS + ON2_MS + OFF2_MS
        const val EDGE_MS = 12
        const val PEAK = 0.12
        const val AMPLITUDE = PEAK * 32767

        /** Sample [index] of the tone (counted from the start of the first ring). */
        fun sample(index: Long, sampleRate: Int): Int {
            val on1 = ON1_MS * sampleRate / 1000
            val gap = OFF1_MS * sampleRate / 1000
            val on2 = ON2_MS * sampleRate / 1000
            val cycle = CYCLE_MS * sampleRate / 1000
            val edge = EDGE_MS * sampleRate / 1000

            val p = (index % cycle).toInt()
            val k: Int
            val length: Int
            if (p < on1) {
                k = p
                length = on1
            } else if (p >= on1 + gap && p < on1 + gap + on2) {
                k = p - on1 - gap
                length = on2
            } else {
                return 0
            }
            val envelope = min(k, min(length - k, edge))
            if (envelope == 0) return 0

            val a = 2 * PI * ((LOW_HZ * index) % sampleRate) / sampleRate
            val b = 2 * PI * ((HIGH_HZ * index) % sampleRate) / sampleRate
            val amp = AMPLITUDE * envelope / edge
            val v = amp * (sin(a) + sin(b)) * 0.5
            return floor(v + 0.5).toInt()
        }
    }
}

/**
 * The plugin's ringback request. Dart may ask before the engine runs (it starts with the
 * engine), the request outlives an engine restart after a device error, and `stop` clears it.
 * A loopback test never rings. Main thread only.
 */
internal class RingbackRequest {
    var on = false
        private set

    fun set(on: Boolean) {
        this.on = on
    }

    fun clear() {
        on = false
    }

    /** What a starting engine is told. */
    fun forEngine(loopback: Boolean): Boolean = on && !loopback
}
