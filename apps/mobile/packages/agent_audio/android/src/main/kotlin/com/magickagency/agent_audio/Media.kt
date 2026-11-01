package com.magickagency.agent_audio

import kotlin.math.log10
import kotlin.math.sqrt

/** The station socket's media format. Names match `AgentAudioFormat.wireName` in Dart. */
internal enum class WireFormat(val wireName: String, val sampleRate: Int, val frameBytes: Int) {
    ALAW8("alaw8", 8000, 160),
    PCM16("pcm16", 16000, 640);

    val frameSamples: Int get() = sampleRate / 50

    companion object {
        fun fromWire(name: Any?): WireFormat? = entries.firstOrNull { it.wireName == name }
    }
}

/** Capture runs at 16 kHz for both formats: 320 samples per 20 ms. */
internal const val CAPTURE_RATE = 16000
internal const val CAPTURE_FRAME = 320

/**
 * Turns one 20 ms capture frame (16 kHz PCM16) into one wire frame: A-law at 8 kHz through
 * the half-band decimator, or PCM16LE as-is. Muted frames are encoded silence, so the far
 * end keeps receiving 50 frames per second. Owned by the capture thread.
 */
internal class UplinkEncoder(private val format: WireFormat) {
    private val decimator = HalfBandDecimator()
    private val pcm8k = ShortArray(160)

    /** Writes [WireFormat.frameBytes] bytes into [out] and returns that count. */
    fun encode(capture: ShortArray, muted: Boolean, out: ByteArray): Int {
        when (format) {
            WireFormat.ALAW8 -> {
                // Keep the filter running while muted so unmuting does not start from a stale state.
                decimator.process(capture, 0, CAPTURE_FRAME, pcm8k, 0)
                if (muted) out.fill(ALaw.SILENCE, 0, 160) else ALaw.encode(pcm8k, 0, out, 0, 160)
            }
            WireFormat.PCM16 -> {
                if (muted) {
                    out.fill(0, 0, 640)
                } else {
                    for (i in 0 until CAPTURE_FRAME) {
                        val s = capture[i].toInt()
                        out[2 * i] = s.toByte()
                        out[2 * i + 1] = (s shr 8).toByte()
                    }
                }
            }
        }
        return format.frameBytes
    }

    fun reset() = decimator.reset()
}

/**
 * Re-frames downlink bytes (any chunking) into whole 20 ms frames, decodes them to PCM at
 * the wire rate and hands each to [onFrame]. A partial frame is carried to the next call.
 * Owned by one thread at a time (the plugin's downlink task queue, or the capture thread
 * during a loopback test).
 */
internal class DownlinkAssembler(private val format: WireFormat, private val onFrame: (ShortArray) -> Unit) {
    private val partial = ByteArray(format.frameBytes)
    private var filled = 0
    private val pcm = ShortArray(format.frameSamples)

    fun reset() {
        filled = 0
    }

    fun feed(src: ByteArray, offset: Int, length: Int) {
        var pos = offset
        val end = offset + length
        while (pos < end) {
            val take = minOf(format.frameBytes - filled, end - pos)
            System.arraycopy(src, pos, partial, filled, take)
            filled += take
            pos += take
            if (filled == format.frameBytes) {
                decode()
                onFrame(pcm)
                filled = 0
            }
        }
    }

    private fun decode() {
        when (format) {
            WireFormat.ALAW8 -> ALaw.decode(partial, 0, pcm, 0, 160)
            WireFormat.PCM16 -> for (i in 0 until 320) {
                pcm[i] = ((partial[2 * i + 1].toInt() shl 8) or (partial[2 * i].toInt() and 0xFF)).toShort()
            }
        }
    }
}

/** RMS level helpers. */
internal object Level {
    const val FLOOR_DBFS = -100.0

    fun sumSquares(pcm: ShortArray, count: Int): Double {
        var s = 0.0
        for (i in 0 until count) {
            val v = pcm[i].toDouble()
            s += v * v
        }
        return s
    }

    fun dbfs(sumSquares: Double, samples: Int): Double {
        if (samples <= 0 || sumSquares <= 0.0) return FLOOR_DBFS
        val rms = sqrt(sumSquares / samples) / 32768.0
        return maxOf(FLOOR_DBFS, 20 * log10(rms))
    }
}

/** Accumulates capture frames and reports one level per [framesPerReport] frames (100 ms). */
internal class LevelMeter(private val framesPerReport: Int = 5) {
    private var sum = 0.0
    private var samples = 0
    private var frames = 0

    /** Returns the level in dBFS every [framesPerReport] frames, otherwise null. */
    fun add(pcm: ShortArray, count: Int): Double? {
        sum += Level.sumSquares(pcm, count)
        samples += count
        frames++
        if (frames < framesPerReport) return null
        val db = Level.dbfs(sum, samples)
        sum = 0.0
        samples = 0
        frames = 0
        return db
    }
}

/**
 * When to ask for audio focus again while a call's engine runs without it. Android sends no
 * GAIN after a permanent `AUDIOFOCUS_LOSS` (another app took focus; some phones do this for a
 * cellular call too), so without asking again the interruption would last the rest of the
 * call while audio actually flows. The session asks at once when a cellular call ends (the
 * mode leaves telephony) and otherwise after a backoff (1, 2, 5, then every 10 s), so it does
 * not fight another app every second. A request during a cellular call is simply refused.
 * The backoff restarts with the next call's engine. Main thread only.
 */
internal class FocusRecovery(private val delaysMs: LongArray = DELAYS_MS) {
    private var attempts = 0

    /** Focus is not held (lost for good, or a request was refused). Returns the delay before
     * asking again, or null when no call's engine runs (the next engine start asks). */
    fun notHeld(engineRunning: Boolean): Long? {
        if (!engineRunning) return null
        return delaysMs[minOf(attempts, delaysMs.lastIndex)].also { attempts++ }
    }

    /** The audio mode changed: true when focus should be asked for now (a cellular call just
     * ended while a call's engine runs without focus). */
    fun askOnModeChange(telephony: Boolean, engineRunning: Boolean, focusHeld: Boolean): Boolean =
        !telephony && engineRunning && !focusHeld

    /** The engine stopped or the session was released. */
    fun reset() {
        attempts = 0
    }

    companion object {
        val DELAYS_MS = longArrayOf(1_000, 2_000, 5_000, 10_000)
    }
}

/**
 * Folds the three Android interruption signals (audio focus, a cellular call seen through the
 * audio mode, the capture policy silencing our mic) into one began/ended pair, so the app sees
 * one interruption however many signals fire. Main thread only.
 */
internal class InterruptionTracker {
    sealed class Transition {
        data class Began(val reason: String) : Transition()
        data class Ended(val reason: String) : Transition()
    }

    private var focusLost = false
    private var telephony = false
    private var silenced = false
    private var active: String? = null

    val interrupted: Boolean get() = active != null

    fun update(focusLost: Boolean = this.focusLost, telephony: Boolean = this.telephony, silenced: Boolean = this.silenced): Transition? {
        this.focusLost = focusLost
        this.telephony = telephony
        this.silenced = silenced
        val reason = when {
            telephony -> "phoneCall"
            silenced -> "microphoneSilenced"
            focusLost -> "focusLoss"
            else -> null
        }
        val current = active
        return when {
            reason != null && current == null -> Transition.Began(reason).also { active = reason }
            reason == null && current != null -> Transition.Ended(current).also { active = null }
            else -> null
        }
    }

    fun clear() {
        focusLost = false; telephony = false; silenced = false; active = null
    }
}
