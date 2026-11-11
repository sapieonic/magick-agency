package com.magickagency.agent_audio

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Process
import android.util.Log
import java.nio.ByteBuffer

/** A start failure with the error code the Dart side maps (`AgentAudioErrorCode.wireName`). */
internal class EngineException(val code: String, message: String) : Exception(message)

/**
 * A pre-flight loopback test, run by the capture thread: record [frames] wire frames (through
 * the real encoder), then feed them back into the downlink path one per capture tick so they
 * play through the jitter buffer exactly as call audio would.
 */
internal class Loopback(format: WireFormat, durationMs: Int, val playBack: Boolean) {
    val frames = (durationMs / 20).coerceIn(10, 250)
    val recording = ByteArray(frames * format.frameBytes)
    val levels = DoubleArray(frames)
    var recorded = 0
    var fed = 0
    var tail = 0
    var finished = false
}

/**
 * Capture and playback for one call (or one loopback test). Created and stopped on the main
 * thread; it owns two dedicated threads at THREAD_PRIORITY_URGENT_AUDIO:
 *
 * * **capture**: blocking `AudioRecord.read` of 20 ms at 16 kHz (VOICE_COMMUNICATION source,
 *   so the platform's echo canceller runs), level metering, encoding, and handing each
 *   uplink frame to [Listener.onUplinkFrame], which re-posts it to the main thread.
 * * **playback**: pops 20 ms from the jitter buffer, mixes in the ringback tone while
 *   [ringback] is set, and does a blocking `AudioTrack.write` at the wire rate (8 or 16 kHz;
 *   AudioFlinger resamples to the device rate). The blocking write paces the loop on the
 *   output clock.
 *
 * Downlink bytes arrive on the plugin's background task queue ([pushDownlink]). The jitter
 * buffer is the only state shared between threads and is guarded by one lock held for a
 * frame copy at most. Nothing allocates per frame.
 */
internal class VoiceEngine(private val format: WireFormat, private val listener: Listener) : CallEngine {
    interface Listener {
        /** Capture thread. Returns false when the frame could not be queued (dropped). */
        fun onUplinkFrame(frame: ByteArray, length: Int): Boolean

        /** Capture thread, about 10 per second while metering. */
        fun onLevel(dbfs: Double)

        /** Playback thread, once per second. */
        fun onStats(snapshot: JitterSnapshot, uplinkDrops: Int)

        /** Capture or playback thread, at most once per engine. */
        fun onEngineError(engine: VoiceEngine, code: String, message: String)

        /** Capture thread, once, when a loopback test completes. */
        fun onLoopbackFinished(engine: VoiceEngine, levels: DoubleArray, playedBack: Boolean)
    }

    @Volatile var uplinkOpen = false
    @Volatile var muted = false
    @Volatile var metering = false

    @Volatile override var ringback = false

    /** Chimes asked for ([playChime]); the playback loop starts the chime when this moves. */
    private val chimeRequests = java.util.concurrent.atomic.AtomicInteger(0)

    override fun playChime() {
        chimeRequests.incrementAndGet()
    }

    private val jitter = JitterBuffer(JitterBufferConfig(frameSamples = format.frameSamples))
    private val jitterLock = Any()
    private val downlinkLock = Any()
    private val downlink = DownlinkAssembler(format) { pcm -> synchronized(jitterLock) { jitter.push(pcm) } }
    private val downlinkScratch = ByteArray(2048)

    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private val effects = ArrayList<AudioEffect>(3)
    private var captureThread: Thread? = null
    private var playbackThread: Thread? = null
    @Volatile private var loopback: Loopback? = null

    @Volatile private var running = false
    @Volatile private var errorReported = false
    @Volatile private var uplinkDrops = 0

    /** The capture session id, for matching recording-configuration callbacks. 0 if stopped. */
    val audioSessionId: Int get() = record?.audioSessionId ?: 0

    val isRunning: Boolean get() = running

    /** Main thread. Opens the devices and starts both threads, or throws [EngineException]. */
    override fun start(loopback: Loopback?) {
        check(!running) { "engine already running" }
        this.loopback = loopback
        synchronized(jitterLock) { jitter.reset() }
        synchronized(downlinkLock) { downlink.reset() }
        uplinkDrops = 0
        errorReported = false

        val rec = createRecord()
        val trk = try {
            createTrack()
        } catch (e: EngineException) {
            rec.release()
            throw e
        }
        record = rec
        track = trk
        attachEffects(rec.audioSessionId)
        try {
            rec.startRecording()
        } catch (e: IllegalStateException) {
            releaseDevices()
            throw EngineException("device_busy", "The microphone could not start: ${e.message}")
        }
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            releaseDevices()
            throw EngineException("device_busy", "The microphone is in use by another app")
        }
        try {
            trk.play()
        } catch (e: IllegalStateException) {
            releaseDevices()
            throw EngineException("device_busy", "Playback could not start: ${e.message}")
        }
        running = true
        captureThread = Thread({ captureLoop(rec) }, "agent-audio-capture").also { it.start() }
        playbackThread = Thread({ playbackLoop(trk) }, "agent-audio-playback").also { it.start() }
    }

    /** Main thread. Idempotent. Stops both threads, then releases the devices. */
    override fun stop() {
        running = false
        // Unblock the threads: a paused + flushed track returns from write, a stopped record
        // returns from read. Either may already be dead; that is fine.
        try {
            track?.pause()
            track?.flush()
        } catch (_: IllegalStateException) {
        }
        try {
            record?.stop()
        } catch (_: IllegalStateException) {
        }
        captureThread?.join(JOIN_TIMEOUT_MS)
        playbackThread?.join(JOIN_TIMEOUT_MS)
        captureThread = null
        playbackThread = null
        releaseDevices()
        loopback = null
        uplinkOpen = false
        muted = false
        ringback = false
    }

    /** Downlink task-queue thread. Copies the message out before returning (the buffer is
     * only valid during the platform-message callback). */
    fun pushDownlink(message: ByteBuffer) {
        if (!running || loopback != null) return
        synchronized(downlinkLock) {
            while (message.hasRemaining()) {
                val n = minOf(message.remaining(), downlinkScratch.size)
                message.get(downlinkScratch, 0, n)
                downlink.feed(downlinkScratch, 0, n)
            }
        }
    }

    private fun captureLoop(rec: AudioRecord) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val buf = ShortArray(CAPTURE_FRAME)
        val wire = ByteArray(format.frameBytes)
        val encoder = UplinkEncoder(format)
        val meter = LevelMeter()
        val lb = loopback
        val loopbackDownlink = lb?.let { DownlinkAssembler(format) { pcm -> synchronized(jitterLock) { jitter.push(pcm) } } }
        var wasOpen = false
        var emptyReads = 0
        try {
            while (running) {
                var got = 0
                while (got < CAPTURE_FRAME && running) {
                    val n = rec.read(buf, got, CAPTURE_FRAME - got)
                    if (n < 0) {
                        fail("lost", "Microphone read failed ($n)")
                        return
                    }
                    // A blocking read only returns 0 when the recorder is wedged; don't spin.
                    if (n == 0 && ++emptyReads > MAX_EMPTY_READS) {
                        fail("lost", "Microphone stopped delivering audio")
                        return
                    }
                    if (n == 0) Thread.sleep(2) else emptyReads = 0
                    got += n
                }
                if (!running) return
                if (metering) meter.add(buf, CAPTURE_FRAME)?.let { listener.onLevel(it) }
                if (lb != null && loopbackDownlink != null) {
                    loopbackTick(lb, loopbackDownlink, encoder, buf, wire)
                    continue
                }
                val open = uplinkOpen
                if (open && !wasOpen) encoder.reset()
                wasOpen = open
                if (!open) continue
                val len = encoder.encode(buf, muted, wire)
                if (!listener.onUplinkFrame(wire, len)) uplinkDrops++
            }
        } catch (e: Exception) {
            if (running) fail("lost", "Capture stopped: ${e.message}")
        }
    }

    private fun loopbackTick(lb: Loopback, assembler: DownlinkAssembler, encoder: UplinkEncoder, buf: ShortArray, wire: ByteArray) {
        if (lb.finished) return
        val fb = format.frameBytes
        if (lb.recorded < lb.frames) {
            lb.levels[lb.recorded] = Level.dbfs(Level.sumSquares(buf, CAPTURE_FRAME), CAPTURE_FRAME)
            encoder.encode(buf, false, wire)
            System.arraycopy(wire, 0, lb.recording, lb.recorded * fb, fb)
            lb.recorded++
            if (lb.recorded == lb.frames && !lb.playBack) finishLoopback(lb)
            return
        }
        if (lb.fed < lb.frames) {
            assembler.feed(lb.recording, lb.fed * fb, fb)
            lb.fed++
            return
        }
        // Everything is queued: wait for the jitter buffer to empty, then ~100 ms more for the
        // AudioTrack's own buffer to play out.
        val depth = synchronized(jitterLock) { jitter.depthFrames }
        if (depth == 0 || lb.tail > 0) lb.tail++
        if (lb.tail >= LOOPBACK_TAIL_FRAMES) finishLoopback(lb)
    }

    private fun finishLoopback(lb: Loopback) {
        lb.finished = true
        listener.onLoopbackFinished(this, lb.levels.copyOf(lb.recorded), lb.playBack)
    }

    private fun playbackLoop(trk: AudioTrack) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val out = ShortArray(format.frameSamples)
        val tone = Ringback(format.sampleRate)
        val chime = Chime(format.sampleRate)
        var chimesSeen = 0
        var pops = 0
        try {
            while (running) {
                synchronized(jitterLock) { jitter.pop(out) }
                // At the wire rate, after the jitter buffer: the same frame-level mix as iOS.
                tone.process(out, ringback)
                // The inbound chime, once per request, after the ringback (never both at once).
                val chimes = chimeRequests.get()
                if (chimes != chimesSeen) {
                    chimesSeen = chimes
                    chime.start()
                }
                chime.process(out)
                val w = trk.write(out, 0, out.size)
                if (w < 0) {
                    fail("lost", "Playback write failed ($w)")
                    return
                }
                if (++pops % STATS_EVERY_FRAMES == 0) {
                    val snap = synchronized(jitterLock) { jitter.snapshot() }
                    listener.onStats(snap, uplinkDrops)
                }
            }
        } catch (e: Exception) {
            if (running) fail("lost", "Playback stopped: ${e.message}")
        }
    }

    private fun fail(code: String, message: String) {
        if (!running || errorReported) return
        errorReported = true
        Log.w(TAG, message)
        listener.onEngineError(this, code, message)
    }

    // Callers check RECORD_AUDIO first and map a refusal to permission_denied.
    @SuppressLint("MissingPermission")
    private fun createRecord(): AudioRecord {
        val min = AudioRecord.getMinBufferSize(CAPTURE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) throw EngineException("unsupported", "16 kHz mono capture is not supported ($min)")
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                CAPTURE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(min, CAPTURE_FRAME * 2 * 4),
            )
        } catch (e: SecurityException) {
            throw EngineException("permission_denied", "Microphone permission is not granted")
        } catch (e: IllegalArgumentException) {
            throw EngineException("unsupported", "Capture format rejected: ${e.message}")
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            throw EngineException("device_busy", "The microphone could not be opened")
        }
        return rec
    }

    private fun createTrack(): AudioTrack {
        val rate = format.sampleRate
        val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) throw EngineException("unsupported", "$rate Hz playback is not supported ($min)")
        return try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(rate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                // Two frames at least, so a late wake-up of the playback thread does not glitch.
                .setBufferSizeInBytes(maxOf(min, format.frameSamples * 2 * 2))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (e: UnsupportedOperationException) {
            throw EngineException("device_busy", "Playback could not be opened: ${e.message}")
        } catch (e: IllegalArgumentException) {
            throw EngineException("unsupported", "Playback format rejected: ${e.message}")
        }
    }

    private fun attachEffects(sessionId: Int) {
        // VOICE_COMMUNICATION usually enables these already; asking explicitly covers devices
        // whose HAL leaves them off. Any of them may be missing or fail to create.
        runCatching { if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(sessionId) else null }
            .getOrNull()?.let { enable(it) }
        runCatching { if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(sessionId) else null }
            .getOrNull()?.let { enable(it) }
        runCatching { if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(sessionId) else null }
            .getOrNull()?.let { enable(it) }
    }

    private fun enable(effect: AudioEffect) {
        runCatching { effect.enabled = true }
        effects.add(effect)
    }

    private fun releaseDevices() {
        effects.forEach { runCatching { it.release() } }
        effects.clear()
        record?.let { runCatching { it.release() } }
        track?.let { runCatching { it.release() } }
        record = null
        track = null
    }

    companion object {
        private const val TAG = "AgentAudio"
        private const val JOIN_TIMEOUT_MS = 500L
        private const val STATS_EVERY_FRAMES = 50
        private const val LOOPBACK_TAIL_FRAMES = 5
        private const val MAX_EMPTY_READS = 50
    }
}
