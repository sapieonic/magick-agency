package com.magickagency.agent_audio

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Replays `test/fixtures/jitter_trace.txt`, generated from the Dart model
 * (`lib/src/jitter/jitter_buffer.dart`), against the Kotlin port: every pop's kind and sample
 * checksum, and every counter snapshot, must match.
 */
class JitterBufferTraceTest {
    private fun traceFile(): File {
        val candidates = listOf("../test/fixtures/jitter_trace.txt", "test/fixtures/jitter_trace.txt", "../../test/fixtures/jitter_trace.txt")
        return candidates.map(::File).firstOrNull { it.isFile }
            ?: error("jitter_trace.txt not found from ${File(".").absolutePath}")
    }

    @Test
    fun replaysTheDartTrace() {
        var jb: JitterBuffer? = null
        var frame = ShortArray(0)
        var out = ShortArray(0)
        var pops = 0
        var stats = 0
        traceFile().readLines().forEachIndexed { index, line ->
            if (line.isBlank() || line.startsWith("#")) return@forEachIndexed
            val parts = line.split(' ')
            val where = "line ${index + 1}: $line"
            when (parts[0]) {
                "config" -> {
                    val v = parts.drop(1).map { it.toInt() }
                    val config = JitterBufferConfig(
                        frameSamples = v[0], minTargetFrames = v[1], maxTargetFrames = v[2],
                        initialTargetFrames = v[3], capacityFrames = v[4], growStepFrames = v[5],
                        shrinkAfterFrames = v[6], trimSlackFrames = v[7], trimAfterFrames = v[8], concealFrames = v[9],
                    )
                    jb = JitterBuffer(config)
                    frame = ShortArray(v[0])
                    out = ShortArray(v[0])
                }
                "push" -> {
                    val seed = parts[1].toInt()
                    for (j in frame.indices) frame[j] = (((seed * 7919 + j * 104729) % 65536) - 32768).toShort()
                    jb!!.push(frame)
                }
                "pop" -> {
                    val kind = jb!!.pop(out)
                    var sum = 0L
                    for (j in out.indices) sum += out[j].toLong() * (j + 1)
                    assertEquals(parts[1], kind.name.lowercase(), where)
                    assertEquals(parts[2].toLong(), sum, where)
                    pops++
                }
                "stats" -> {
                    val s = jb!!.snapshot()
                    val actual = listOf(
                        s.depthFrames, s.targetFrames, s.underruns, s.concealedFrames, s.silentFrames,
                        s.overflowDrops, s.latencyDrops, s.receivedFrames, s.playedFrames,
                    )
                    assertEquals(parts.drop(1).map { it.toInt() }, actual, where)
                    stats++
                }
                else -> error("unknown op $where")
            }
        }
        assertTrue(pops > 3000, "trace has $pops pops")
        assertTrue(stats > 50, "trace has $stats stats lines")
    }
}
