package com.magickagency.agent_audio

/** What [JitterBuffer.pop] produced. Names match the Dart model's `PlayoutKind`. */
internal enum class PlayoutKind { REAL, CONCEALED, SILENCE }

/** Tuning in 20 ms frames; defaults match `JitterBufferConfig` in the Dart model. */
internal data class JitterBufferConfig(
    val frameSamples: Int,
    val minTargetFrames: Int = 4,
    val maxTargetFrames: Int = 12,
    val initialTargetFrames: Int = 5,
    val capacityFrames: Int = 16,
    val growStepFrames: Int = 2,
    val shrinkAfterFrames: Int = 500,
    val trimSlackFrames: Int = 2,
    val trimAfterFrames: Int = 25,
    val concealFrames: Int = 3,
) {
    val fadeInSamples: Int get() = frameSamples / 4
}

internal data class JitterSnapshot(
    val depthFrames: Int,
    val targetFrames: Int,
    val underruns: Int,
    val concealedFrames: Int,
    val silentFrames: Int,
    val overflowDrops: Int,
    val latencyDrops: Int,
    val receivedFrames: Int,
    val playedFrames: Int,
)

/**
 * Adaptive playout buffer for downlink audio: a line-for-line port of
 * `lib/src/jitter/jitter_buffer.dart`, which documents the algorithm and is the
 * specification. `JitterBufferTraceTest` replays the Dart-generated trace against this class.
 *
 * Not thread-safe: the engine guards it with one lock shared by the downlink thread (push)
 * and the playback thread (pop). No allocation after construction (except [snapshot]).
 */
internal class JitterBuffer(val config: JitterBufferConfig) {
    private val slots = ShortArray(config.capacityFrames * config.frameSamples)
    private val last = ShortArray(config.frameSamples)

    private var head = 0
    private var count = 0
    private var target = config.initialTargetFrames
    private var buffering = true
    private var hasLast = false
    private var prevReal = false
    private var concealRun = 0
    private var stable = 0
    private var excess = 0

    private var underruns = 0
    private var concealed = 0
    private var silent = 0
    private var overflowDrops = 0
    private var latencyDrops = 0
    private var received = 0
    private var played = 0

    val depthFrames: Int get() = count
    val targetFrames: Int get() = target

    fun snapshot() = JitterSnapshot(
        count, target, underruns, concealed, silent, overflowDrops, latencyDrops, received, played,
    )

    fun reset() {
        head = 0; count = 0; target = config.initialTargetFrames
        buffering = true; hasLast = false; prevReal = false
        concealRun = 0; stable = 0; excess = 0
        underruns = 0; concealed = 0; silent = 0; overflowDrops = 0; latencyDrops = 0
        received = 0; played = 0
    }

    fun push(frame: ShortArray, offset: Int = 0) {
        val n = config.frameSamples
        val cap = config.capacityFrames
        received++
        if (count == cap) {
            head = (head + 1) % cap
            count--
            overflowDrops++
        }
        val tail = (head + count) % cap
        System.arraycopy(frame, offset, slots, tail * n, n)
        count++
    }

    fun pop(out: ShortArray): PlayoutKind {
        val n = config.frameSamples
        val cap = config.capacityFrames

        if (!buffering && count == 0) {
            underruns++
            target = minOf(target + config.growStepFrames, config.maxTargetFrames)
            stable = 0
            excess = 0
            buffering = true
        }
        if (buffering) {
            if (count >= target) {
                buffering = false
            } else {
                return fill(out)
            }
        }

        if (count > target + config.trimSlackFrames) {
            excess++
            if (excess >= config.trimAfterFrames) {
                head = (head + 1) % cap
                count--
                latencyDrops++
                excess = 0
            }
        } else {
            excess = 0
        }

        val start = head * n
        System.arraycopy(slots, start, last, 0, n)
        System.arraycopy(slots, start, out, 0, n)
        head = (head + 1) % cap
        count--

        if (!prevReal) {
            val f = config.fadeInSamples
            for (j in 0 until f) out[j] = ((out[j] * j) / f).toShort()
        }
        hasLast = true
        prevReal = true
        concealRun = 0
        played++
        stable++
        if (stable >= config.shrinkAfterFrames) {
            stable = 0
            if (target > config.minTargetFrames) target--
        }
        return PlayoutKind.REAL
    }

    private fun fill(out: ShortArray): PlayoutKind {
        val n = config.frameSamples
        prevReal = false
        if (hasLast && concealRun < config.concealFrames) {
            val total = config.concealFrames * n
            val base = concealRun * n
            for (j in 0 until n) out[j] = ((last[j] * (total - (base + j))) / total).toShort()
            concealRun++
            concealed++
            return PlayoutKind.CONCEALED
        }
        out.fill(0, 0, n)
        silent++
        return PlayoutKind.SILENCE
    }
}
