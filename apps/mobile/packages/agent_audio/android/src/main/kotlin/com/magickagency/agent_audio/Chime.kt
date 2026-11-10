package com.magickagency.agent_audio

import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.sin

/**
 * The inbound chime, played once when an inbound caller is offered to the agent: the console's
 * `inbound_ring` cue, 784 / 587 / 784 / 587 Hz, each 8 ms attack, 120 ms hold, 25 ms release,
 * gaps 30 / 160 / 30 / 0 ms after a 5 ms lead, peak 0.12 of full scale. A line-for-line port of
 * the Dart reference `lib/src/tone/chime.dart`, which documents the formula; `ChimeTest.kt`
 * asserts the same golden vectors as the Dart test.
 *
 * Owned by the playback thread: [VoiceEngine.playbackLoop] calls [process] on every frame it
 * pops from the jitter buffer, after the ringback, at the wire rate. No allocation. Started from
 * another thread through [VoiceEngine.playChime], which only bumps a counter the loop reads.
 */
internal class Chime(private val sampleRate: Int) {
    val length = length(sampleRate)

    /** The index of the next sample to mix, or -1 when idle. */
    var position = -1
        private set

    val active: Boolean get() = position >= 0

    fun start() {
        position = 0
    }

    fun stop() {
        position = -1
    }

    /** While [active]: adds the next [count] samples to [frame], saturating, and advances; past
     * the end it goes idle. Idle: leaves [frame] alone. */
    fun process(frame: ShortArray, count: Int = frame.size) {
        if (position < 0) return
        for (i in 0 until count) {
            val s = frame[i] + sample(position + i, sampleRate)
            frame[i] = (if (s > 32767) 32767 else if (s < -32768) -32768 else s).toShort()
        }
        position += count
        if (position >= length) position = -1
    }

    companion object {
        /** (Hz, hold ms, gap ms after the release), in order. */
        val TONES = arrayOf(intArrayOf(784, 120, 30), intArrayOf(587, 120, 160), intArrayOf(784, 120, 30), intArrayOf(587, 120, 0))
        const val ATTACK_MS = 8
        const val RELEASE_MS = 25
        const val LEAD_MS = 5
        const val PEAK = 0.12
        const val AMPLITUDE = PEAK * 32767

        /** How many samples the chime lasts, lead and gaps included. */
        fun length(sampleRate: Int): Int {
            val attack = ATTACK_MS * sampleRate / 1000
            val release = RELEASE_MS * sampleRate / 1000
            var total = LEAD_MS * sampleRate / 1000
            for (t in TONES) total += attack + t[1] * sampleRate / 1000 + release + t[2] * sampleRate / 1000
            return total
        }

        /** Sample [index] of the chime (counted from its start); 0 outside it. */
        fun sample(index: Int, sampleRate: Int): Int {
            val lead = LEAD_MS * sampleRate / 1000
            if (index < lead) return 0
            val attack = ATTACK_MS * sampleRate / 1000
            val release = RELEASE_MS * sampleRate / 1000
            var m = index - lead
            for (t in TONES) {
                val hz = t[0]
                val hold = t[1] * sampleRate / 1000
                val span = attack + hold + release
                if (m < span) {
                    val num: Int
                    val den: Int
                    if (m < attack) {
                        num = m
                        den = attack
                    } else if (m < attack + hold) {
                        num = 1
                        den = 1
                    } else {
                        num = span - m
                        den = release
                    }
                    if (num == 0) return 0
                    val theta = 2 * PI * ((hz.toLong() * m) % sampleRate) / sampleRate
                    val amp = AMPLITUDE * num / den
                    val v = amp * sin(theta)
                    return floor(v + 0.5).toInt()
                }
                m -= span
                val gap = t[2] * sampleRate / 1000
                if (m < gap) return 0
                m -= gap
            }
            return 0
        }
    }
}
