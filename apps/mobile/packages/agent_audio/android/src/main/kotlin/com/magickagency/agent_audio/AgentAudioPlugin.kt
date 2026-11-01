package com.magickagency.agent_audio

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.ForegroundServiceStartNotAllowedException
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result
import java.nio.ByteBuffer
import java.util.concurrent.ArrayBlockingQueue

/** Channel names; must match `AgentAudioChannels` in `lib/src/types.dart`. */
internal object AgentAudioChannels {
    const val METHODS = "magick_agency/agent_audio/methods"
    const val EVENTS = "magick_agency/agent_audio/events"
    const val UPLINK = "magick_agency/agent_audio/uplink"
    const val DOWNLINK = "magick_agency/agent_audio/downlink"
}

/** Mirrors `AgentAudioPhase` in Dart; the transitions below follow `AgentAudioPhase.after`. */
internal enum class Phase { IDLE, PREPARED, ARMED, STREAMING }

/**
 * Hands encoded uplink frames from the capture thread to Dart. `BinaryMessenger.send` must be
 * called on the main thread with a direct buffer whose position is the length, and the engine
 * copies it synchronously, so a small pool of direct buffers (each with its own Runnable)
 * cycles between the capture thread and the main thread with no allocation. If the main
 * thread falls 8 frames (160 ms) behind, frames are dropped and counted rather than queued.
 */
private class UplinkSender(private val messenger: BinaryMessenger, private val main: Handler, frameBytes: Int) {
    @Volatile var closed = false
    private val free = ArrayBlockingQueue<Slot>(POOL_SIZE)

    private inner class Slot(size: Int) : Runnable {
        val buffer: ByteBuffer = ByteBuffer.allocateDirect(size)

        override fun run() {
            if (!closed) messenger.send(AgentAudioChannels.UPLINK, buffer)
            free.offer(this)
        }
    }

    init {
        repeat(POOL_SIZE) { free.offer(Slot(frameBytes)) }
    }

    fun submit(frame: ByteArray, length: Int): Boolean {
        if (closed) return true
        val slot = free.poll() ?: return false
        slot.buffer.clear()
        slot.buffer.put(frame, 0, length)
        main.post(slot)
        return true
    }

    companion object {
        const val POOL_SIZE = 8
    }
}

/**
 * The plugin: method dispatch on the main thread, events out through one EventChannel, media
 * on two BinaryCodec channels (uplink posted from the capture thread via [UplinkSender];
 * downlink handled on a background task queue straight into the engine's jitter buffer).
 * See README.md for the threading model.
 */
class AgentAudioPlugin :
    FlutterPlugin,
    MethodCallHandler,
    EventChannel.StreamHandler,
    ActivityAware {
    private lateinit var context: Context
    private lateinit var messenger: BinaryMessenger
    private lateinit var methods: MethodChannel
    private lateinit var events: EventChannel
    private val main = Handler(Looper.getMainLooper())

    private var sink: EventChannel.EventSink? = null
    private var session: AudioSessionController? = null
    private var activity: Activity? = null

    /** The running engine and the ringback request; engines start and stop only through it. */
    private val engines = EngineSlot<VoiceEngine>()
    private val engine: VoiceEngine? get() = engines.engine

    @Volatile private var uplink: UplinkSender? = null
    private var phase = Phase.IDLE
    private var format: WireFormat? = null
    private var muted = false
    private var metering = false
    private var pendingLoopback: Result? = null
    private var pendingServiceStart: Result? = null

    /** The app asked for the on-duty service to stop, so its end is not news to Dart. */
    private var serviceStopRequested = false
    private val restarts = ArrayDeque<Long>()

    private val loopbackTimeout = Runnable {
        pendingLoopback?.let {
            pendingLoopback = null
            stopEngine(keepRingback = true)
            it.error("lost", "Loopback test timed out", null)
        }
    }

    private val serviceStartTimeout = Runnable {
        pendingServiceStart?.let {
            pendingServiceStart = null
            it.error("unknown", "The on-duty service did not start", null)
        }
    }

    // region FlutterPlugin

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        messenger = binding.binaryMessenger
        methods = MethodChannel(messenger, AgentAudioChannels.METHODS).also { it.setMethodCallHandler(this) }
        events = EventChannel(messenger, AgentAudioChannels.EVENTS).also { it.setStreamHandler(this) }
        // Downlink frames (~50/s) are handled off the main thread, straight into the jitter
        // buffer. The message buffer is only valid during the callback; pushDownlink copies.
        val queue = messenger.makeBackgroundTaskQueue()
        messenger.setMessageHandler(
            AgentAudioChannels.DOWNLINK,
            { message, reply ->
                val e = engine
                if (message != null && e != null) e.pushDownlink(message)
                reply.reply(null)
            },
            queue,
        )
        // The bridge is process-wide: a second Flutter engine (a background isolate) must not
        // take it from the one that runs the station. The instance that starts the service
        // claims it (startService).
        if (OnDutyBridge.listener == null) OnDutyBridge.listener = serviceListener
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        cancelLoopback("The app is closing")
        stopEngine(keepRingback = false)
        session?.release()
        session = null
        phase = Phase.IDLE
        format = null
        pendingServiceStart = null
        main.removeCallbacks(serviceStartTimeout)
        // Only the instance driving the service stops it, and only it lets go of the bridge.
        if (OnDutyBridge.listener === serviceListener) {
            if (OnDutyBridge.running) {
                serviceStopRequested = true
                context.stopService(Intent(context, OnDutyService::class.java))
            }
            OnDutyBridge.listener = null
        }
        methods.setMethodCallHandler(null)
        events.setStreamHandler(null)
        messenger.setMessageHandler(AgentAudioChannels.DOWNLINK, null)
        sink = null
    }

    // endregion

    // region ActivityAware (only used to open the battery-optimisation prompt in-task)

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivityForConfigChanges() {
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivity() {
        activity = null
    }

    // endregion

    // region EventChannel

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        sink = events
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    /** Main thread only. */
    private fun emit(event: Map<String, Any?>) {
        sink?.success(event)
    }

    // endregion

    // region Methods

    override fun onMethodCall(call: MethodCall, result: Result) {
        try {
            dispatch(call, result)
        } catch (e: EngineException) {
            result.error(e.code, e.message, null)
        } catch (e: Exception) {
            result.error("unknown", e.message ?: e.javaClass.simpleName, null)
        }
    }

    private fun dispatch(call: MethodCall, result: Result) {
        when (call.method) {
            "prepare" -> {
                val f = WireFormat.fromWire(call.argument<String>("format"))
                    ?: throw EngineException("unsupported", "Unknown format ${call.argument<String>("format")}")
                if (phase == Phase.ARMED || phase == Phase.STREAMING) {
                    throw EngineException("invalid_state", "Cannot prepare during a call")
                }
                ensureSession().prepare()
                format = f
                phase = Phase.PREPARED
                result.success(null)
            }
            "armMicrophone" -> {
                if (pendingLoopback != null) throw EngineException("invalid_state", "A loopback test is running")
                when (phase) {
                    Phase.IDLE -> throw EngineException("not_prepared", "Cannot arm while idle")
                    Phase.PREPARED -> {
                        startEngine(null)
                        phase = Phase.ARMED
                    }
                    // Already armed; if the engine died and could not recover, try again.
                    Phase.ARMED, Phase.STREAMING -> if (engine == null) {
                        startEngine(null)
                        engine?.uplinkOpen = phase == Phase.STREAMING
                    }
                }
                result.success(null)
            }
            "startUplink" -> {
                when (phase) {
                    Phase.ARMED, Phase.STREAMING -> {
                        engine?.uplinkOpen = true
                        phase = Phase.STREAMING
                    }
                    Phase.IDLE -> throw EngineException("not_prepared", "Cannot start the uplink while idle")
                    Phase.PREPARED -> throw EngineException("invalid_state", "Arm the microphone first")
                }
                result.success(null)
            }
            "stop" -> {
                val keepWarm = call.argument<Boolean>("keepWarm") ?: true
                val endsCall = phase == Phase.ARMED || phase == Phase.STREAMING
                cancelLoopback("Stopped")
                stopEngine(keepRingback = false)
                muted = false
                if (!keepWarm) {
                    session?.release()
                    format = null
                    phase = Phase.IDLE
                } else if (phase != Phase.IDLE) {
                    phase = Phase.PREPARED
                    // A route chosen for this call (the speaker above all) is not the next one's.
                    if (endsCall) session?.callEnded()
                }
                result.success(null)
            }
            "setMuted" -> {
                muted = call.argument<Boolean>("muted") ?: false
                engine?.muted = muted
                result.success(null)
            }
            "routes" -> result.success(ensureSession().availableRoutes().map { it.toMap() })
            "currentRoute" -> result.success(session?.currentRoute()?.toMap())
            "setRoute" -> {
                val s = session?.takeIf { it.prepared } ?: throw EngineException("not_prepared", "Prepare first")
                val id = call.argument<String>("id") ?: ""
                if (!s.setRoute(id)) throw EngineException("unsupported", "Route $id is not available")
                result.success(null)
            }
            // Kept until stop, so it also applies to an engine started (or restarted) later.
            "setRingback" -> {
                engines.setRingback(call.argument<Boolean>("on") ?: false)
                result.success(null)
            }
            "setInputLevelMetering" -> {
                metering = call.argument<Boolean>("enabled") ?: false
                engine?.metering = metering
                result.success(null)
            }
            "loopbackTest" -> {
                if (phase != Phase.PREPARED || engine != null || pendingLoopback != null) {
                    throw EngineException(if (phase == Phase.IDLE) "not_prepared" else "invalid_state", "Loopback needs a prepared, idle engine")
                }
                val durationMs = call.argument<Int>("durationMs") ?: 1500
                val playBack = call.argument<Boolean>("playBack") ?: true
                startEngine(Loopback(format!!, durationMs, playBack))
                pendingLoopback = result
                main.postDelayed(loopbackTimeout, durationMs * 2L + LOOPBACK_SLACK_MS)
            }
            // iOS CallKit only. Android v1 has no ConnectionService: the on-duty notification
            // shows the call instead.
            "configureCallSystem", "startCall", "reportConnected", "endCall" -> result.success(null)
            "startOnDutyService" -> startService(call, result)
            "updateOnDutyService" -> {
                val spec = OnDutySpec.fromArgs(call.arguments as? Map<*, *>)
                    ?: throw EngineException("unknown", "Missing notification content")
                OnDutyBridge.spec = spec
                if (OnDutyBridge.running) {
                    OnDutyNotifications.ensureChannel(context, spec.channelName)
                    context.getSystemService(NotificationManager::class.java)
                        .notify(OnDutyNotifications.NOTIFICATION_ID, OnDutyNotifications.build(context, spec))
                }
                result.success(null)
            }
            "stopOnDutyService" -> {
                serviceStopRequested = true
                context.stopService(Intent(context, OnDutyService::class.java))
                result.success(null)
            }
            "isIgnoringBatteryOptimizations" -> {
                val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                result.success(pm.isIgnoringBatteryOptimizations(context.packageName))
            }
            "requestIgnoreBatteryOptimizations" -> result.success(requestBatteryExemption())
            else -> result.notImplemented()
        }
    }

    private fun ensureSession(): AudioSessionController =
        session ?: AudioSessionController(context, main, ::emit).also {
            it.recordSessionId = { engine?.audioSessionId ?: 0 }
            session = it
        }

    private fun hasRecordPermission() =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun startEngine(loopback: Loopback?) {
        val fmt = format ?: throw EngineException("not_prepared", "No format")
        if (!hasRecordPermission()) throw EngineException("permission_denied", "Microphone permission is not granted")
        val sender = UplinkSender(messenger, main, fmt.frameBytes)
        val e = VoiceEngine(fmt, engineListener)
        e.muted = muted
        e.metering = metering
        uplink = sender
        try {
            engines.start(e, loopback)
        } catch (ex: EngineException) {
            sender.closed = true
            uplink = null
            throw ex
        }
        session?.onEngineRunning(true, call = loopback == null)
    }

    /** [keepRingback]: true for a restart or the end of a loopback test, false when the call ends. */
    private fun stopEngine(keepRingback: Boolean) {
        val running = engine != null
        uplink?.closed = true
        uplink = null
        engines.stop(keepRingback)
        if (running) session?.onEngineRunning(false)
    }

    private fun cancelLoopback(reason: String) {
        val pending = pendingLoopback ?: return
        pendingLoopback = null
        main.removeCallbacks(loopbackTimeout)
        pending.error("invalid_state", reason, null)
    }

    // endregion

    // region VoiceEngine.Listener (engine threads → main)

    private val engineListener = object : VoiceEngine.Listener {
        override fun onUplinkFrame(frame: ByteArray, length: Int): Boolean = uplink?.submit(frame, length) ?: true

        override fun onLevel(dbfs: Double) {
            main.post { emit(mapOf("type" to "level", "dbfs" to dbfs)) }
        }

        override fun onStats(snapshot: JitterSnapshot, uplinkDrops: Int) {
            main.post {
                emit(
                    mapOf(
                        "type" to "jitter",
                        "depth" to snapshot.depthFrames,
                        "target" to snapshot.targetFrames,
                        "underruns" to snapshot.underruns,
                        "concealed" to snapshot.concealedFrames,
                        "silent" to snapshot.silentFrames,
                        "overflowDrops" to snapshot.overflowDrops,
                        "latencyDrops" to snapshot.latencyDrops,
                        "received" to snapshot.receivedFrames,
                        "played" to snapshot.playedFrames,
                        "uplinkDrops" to uplinkDrops,
                    ),
                )
            }
        }

        override fun onEngineError(engine: VoiceEngine, code: String, message: String) {
            main.post { handleEngineError(engine, code, message) }
        }

        override fun onLoopbackFinished(engine: VoiceEngine, levels: DoubleArray, playedBack: Boolean) {
            main.post {
                if (engine !== this@AgentAudioPlugin.engine) return@post
                val pending = pendingLoopback ?: return@post
                pendingLoopback = null
                main.removeCallbacks(loopbackTimeout)
                stopEngine(keepRingback = true)
                pending.success(mapOf("levels" to levels, "playedBack" to playedBack))
            }
        }
    }

    /**
     * The capture or playback device died mid-call (audio server restart, device lost).
     * Rebuild the engine up to 3 times a minute, keeping the uplink state, and tell the app
     * whether that worked.
     */
    private fun handleEngineError(failed: VoiceEngine, code: String, message: String) {
        if (failed !== engine) return
        if (pendingLoopback != null) {
            val pending = pendingLoopback!!
            pendingLoopback = null
            main.removeCallbacks(loopbackTimeout)
            stopEngine(keepRingback = true)
            pending.error(code, message, null)
            return
        }
        val wasOpen = failed.uplinkOpen
        stopEngine(keepRingback = true)
        val now = SystemClock.elapsedRealtime()
        while (restarts.isNotEmpty() && now - restarts.first() > RESTART_WINDOW_MS) restarts.removeFirst()
        var recovered = false
        if (restarts.size < MAX_RESTARTS && (phase == Phase.ARMED || phase == Phase.STREAMING)) {
            restarts.addLast(now)
            recovered = try {
                startEngine(null)
                engine?.uplinkOpen = wasOpen
                true
            } catch (_: EngineException) {
                false
            }
        }
        emit(mapOf("type" to "error", "code" to code, "message" to message, "recovered" to recovered))
    }

    // endregion

    // region On-duty service

    private fun startService(call: MethodCall, result: Result) {
        val spec = OnDutySpec.fromArgs(call.arguments as? Map<*, *>)
            ?: throw EngineException("unknown", "Missing notification content")
        // Check what Android 14 would otherwise reject inside the service, where a refusal
        // after startForegroundService() cannot be undone cleanly.
        if (!hasRecordPermission()) throw EngineException("permission_denied", "Microphone permission is not granted")
        if (!isInForeground()) throw EngineException("not_in_foreground", "Start the on-duty service while the app is on screen")
        OnDutyNotifications.ensureChannel(context, spec.channelName)
        OnDutyBridge.spec = spec
        OnDutyBridge.listener = serviceListener
        serviceStopRequested = false
        if (OnDutyBridge.running) {
            context.getSystemService(NotificationManager::class.java)
                .notify(OnDutyNotifications.NOTIFICATION_ID, OnDutyNotifications.build(context, spec))
            result.success(null)
            return
        }
        pendingServiceStart?.error("invalid_state", "Superseded by a newer start", null)
        pendingServiceStart = result
        try {
            context.startForegroundService(Intent(context, OnDutyService::class.java).setAction(OnDutyService.ACTION_START))
        } catch (e: Exception) {
            pendingServiceStart = null
            val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && e is ForegroundServiceStartNotAllowedException) {
                "not_in_foreground"
            } else {
                "unknown"
            }
            result.error(code, e.message, null)
            return
        }
        main.removeCallbacks(serviceStartTimeout)
        main.postDelayed(serviceStartTimeout, SERVICE_START_TIMEOUT_MS)
    }

    private fun isInForeground(): Boolean {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }

    private val serviceListener = object : OnDutyBridge.Listener {
        override fun onServiceStarted() {
            main.removeCallbacks(serviceStartTimeout)
            pendingServiceStart?.success(null)
            pendingServiceStart = null
        }

        override fun onServiceStartFailed(error: Exception) {
            main.removeCallbacks(serviceStartTimeout)
            // On Android 14+ a SecurityException here means the microphone type was refused for
            // the app's current state (not in the foreground, or the permission was revoked).
            val code = if (error is SecurityException) "not_in_foreground" else "unknown"
            pendingServiceStart?.error(code, error.message, null)
            pendingServiceStart = null
        }

        /** The service ended. Unless the app asked for that, Android stopped it (or it could not
         * start): tell Dart, which shows the "keep the app on screen" problem and starts it
         * again when the app comes back on screen. */
        override fun onServiceStopped() {
            val requested = serviceStopRequested
            serviceStopRequested = false
            if (!requested) emit(mapOf("type" to "service", "running" to false))
        }

        override fun onNotificationAction(action: String, muted: Boolean?) {
            when (action) {
                "hangUp" -> emit(mapOf("type" to "callAction", "action" to "end", "source" to "notification"))
                "mute" -> {
                    val m = muted ?: !this@AgentAudioPlugin.muted
                    this@AgentAudioPlugin.muted = m
                    engine?.muted = m
                    emit(mapOf("type" to "callAction", "action" to "mute", "muted" to m, "source" to "notification"))
                }
            }
        }
    }

    private fun requestBatteryExemption(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(context.packageName)) return true
        val host = activity
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        for (intent in listOf(direct, list)) {
            try {
                if (host != null) host.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (_: ActivityNotFoundException) {
                // Some OEM builds remove the direct prompt; fall through to the list screen.
            } catch (_: SecurityException) {
            }
        }
        return false
    }

    // endregion

    private companion object {
        const val LOOPBACK_SLACK_MS = 3000L
        const val SERVICE_START_TIMEOUT_MS = 5000L
        const val RESTART_WINDOW_MS = 60_000L
        const val MAX_RESTARTS = 3
    }
}
