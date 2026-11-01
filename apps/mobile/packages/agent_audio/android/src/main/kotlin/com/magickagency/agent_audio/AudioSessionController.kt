package com.magickagency.agent_audio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Build
import android.os.Handler
import android.os.PowerManager

/** One place audio can go; serialised as `AudioRoute.toMap()` in Dart. */
internal data class Route(val kind: String, val id: String, val name: String) {
    fun toMap(): Map<String, Any?> = mapOf("kind" to kind, "id" to id, "name" to name)
}

/**
 * The call's audio session on Android: communication mode, audio focus, the route
 * (earpiece / speaker / wired / Bluetooth), interruptions, becoming-noisy and the proximity
 * screen lock. Main thread only; events go out through [emit].
 *
 * Interruption sources, all permission-free (no READ_PHONE_STATE):
 * * audio focus loss (a ringing or active cellular call, another VoIP app, an alarm);
 * * on API 31+, the audio mode switching to RINGTONE / IN_CALL / CALL_SCREENING, which is how
 *   a cellular call shows up without telephony permissions, and which also classifies the
 *   focus loss as `phoneCall`;
 * * on API 29+, the capture policy silencing our recorder (the cellular call took the mic).
 * When the cellular call ends Android resets the mode to NORMAL, so the end of an
 * interruption re-asserts MODE_IN_COMMUNICATION and the chosen route.
 *
 * Routing never moves audio to the loudspeaker on its own: when the device in use goes away,
 * audio falls back to a wired headset, then the earpiece (speaker only if there is none).
 */
internal class AudioSessionController(
    private val context: Context,
    private val main: Handler,
    private val emit: (Map<String, Any?>) -> Unit,
) {
    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager

    var prepared = false
        private set

    /** Supplies the running recorder's session id (0 when none) for the silencing callback. */
    var recordSessionId: () -> Int = { 0 }

    private val interruptions = InterruptionTracker()
    private var focusRequest: AudioFocusRequest? = null
    private var focusHeld = false
    private var engineRunning = false
    private var proximity: PowerManager.WakeLock? = null
    private var lastRoute: Pair<Route?, List<Route>>? = null
    private var knownHeadsets = emptySet<Int>()

    /** Below API 31 the selected route is a flag combination; this is what was asked for. */
    private var legacyKind: String? = null

    /** The route id last chosen (by default selection, a new headset, or the app). When it
     * disappears, audio falls back; when it is still there (even the speaker), it stays. */
    private var selectedId: String? = null

    private val voiceAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                if (change == AudioManager.AUDIOFOCUS_LOSS) focusHeld = false
                apply(interruptions.update(focusLost = true, telephony = isTelephonyMode(am.mode)))
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                focusHeld = true
                apply(interruptions.update(focusLost = false, telephony = isTelephonyMode(am.mode)))
            }
            // Ducking requests are ignored: a call should not get quieter for a notification.
        }
    }

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) emit(mapOf("type" to "noisy"))
        }
    }

    @Suppress("DEPRECATION")
    private val scoReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            // The SCO state broadcast is sticky: the replay on registration is not news.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S || isInitialStickyBroadcast) return
            when (intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_ERROR)) {
                AudioManager.SCO_AUDIO_STATE_CONNECTED -> emitRoute("requested")
                AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> {
                    if (legacyKind == "bluetooth") {
                        val kind = fallbackKind()
                        applyLegacy(kind)
                        selectedId = availableRoutes().firstOrNull { it.kind == kind }?.id
                        emitRoute("deviceRemoved")
                    }
                }
            }
        }
    }

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            val fresh = addedDevices.filter { isHeadset(it) && it.id !in knownHeadsets }
            knownHeadsets = currentHeadsetIds()
            if (!prepared || fresh.isEmpty()) return
            // A headset that just connected takes the call, as on a phone call.
            val pick = fresh.firstOrNull { kindOf(it) == "bluetooth" } ?: fresh.first()
            selectDevice(pick)
            emitRoute("newDevice")
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            knownHeadsets = currentHeadsetIds()
            if (!prepared || removedDevices.none { isHeadset(it) }) return
            val selected = selectedId
            if (selected == null || availableRoutes().none { it.id == selected }) selectDefault()
            emitRoute("deviceRemoved")
        }
    }

    private val modeListener: Any? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        AudioManager.OnModeChangedListener { mode -> apply(interruptions.update(telephony = isTelephonyMode(mode))) }
    } else {
        null
    }

    private val commDeviceListener: Any? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        AudioManager.OnCommunicationDeviceChangedListener { emitRoute("other") }
    } else {
        null
    }

    private val recordingCallback: Any? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: List<AudioRecordingConfiguration>) {
                val id = recordSessionId()
                if (id == 0) return
                val mine = configs.firstOrNull { it.clientAudioSessionId == id } ?: return
                apply(interruptions.update(silenced = mine.isClientSilenced))
            }
        }
    } else {
        null
    }

    /** Communication mode, focus, listeners, default route. Idempotent. */
    fun prepare() {
        if (prepared) return
        prepared = true
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        requestFocus()
        register()
        knownHeadsets = currentHeadsetIds()
        selectDefault()
        lastRoute = null
        emitRoute("other")
    }

    /** Undoes [prepare]. Idempotent. */
    fun release() {
        if (!prepared) return
        prepared = false
        engineRunning = false
        updateProximity()
        unregister()
        focusRequest?.let { am.abandonAudioFocusRequest(it) }
        focusRequest = null
        focusHeld = false
        clearRoute()
        am.mode = AudioManager.MODE_NORMAL
        interruptions.clear()
        lastRoute = null
    }

    /** The engine started or stopped: re-take focus if it was lost for good, and update the
     * proximity lock. */
    fun onEngineRunning(running: Boolean) {
        engineRunning = running
        if (running && prepared) {
            if (!focusHeld) requestFocus()
            if (am.mode != AudioManager.MODE_IN_COMMUNICATION && !isTelephonyMode(am.mode)) {
                am.mode = AudioManager.MODE_IN_COMMUNICATION
            }
        }
        if (!running) apply(interruptions.update(silenced = false))
        updateProximity()
    }

    fun availableRoutes(): List<Route> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return am.availableCommunicationDevices.mapNotNull { routeOf(it) }.distinctBy { it.id }.sortedBy { order(it.kind) }
        }
        val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val routes = ArrayList<Route>(4)
        if (outs.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }) routes += EARPIECE
        if (outs.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }) routes += SPEAKER
        outs.firstOrNull { kindOf(it) == "wired" }?.let { routes += routeOf(it)!! }
        outs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }?.let { routes += routeOf(it)!! }
        return routes
    }

    fun currentRoute(): Route? {
        if (!prepared) return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return am.communicationDevice?.let { routeOf(it) }
        }
        val available = availableRoutes()
        @Suppress("DEPRECATION")
        val kind = when {
            am.isBluetoothScoOn -> "bluetooth"
            am.isSpeakerphoneOn -> "speaker"
            available.any { it.kind == "wired" } -> "wired"
            available.any { it.kind == "earpiece" } -> "earpiece"
            else -> "speaker"
        }
        return available.firstOrNull { it.kind == kind }
    }

    /** Selects [id] (from [availableRoutes]). Returns false if it is not available. */
    fun setRoute(id: String): Boolean {
        if (!prepared) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val device = am.availableCommunicationDevices.firstOrNull { routeOf(it)?.id == id } ?: return false
            if (!am.setCommunicationDevice(device)) return false
        } else {
            val route = availableRoutes().firstOrNull { it.id == id } ?: return false
            applyLegacy(route.kind)
        }
        selectedId = id
        emitRoute("requested", force = true)
        updateProximity()
        return true
    }

    private fun requestFocus() {
        val req = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(voiceAttributes)
            .setAcceptsDelayedFocusGain(false)
            .setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener(focusListener, main)
            .build()
            .also { focusRequest = it }
        focusHeld = am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        // Refused focus means something else (usually a cellular call) owns audio right now.
        apply(interruptions.update(focusLost = !focusHeld, telephony = isTelephonyMode(am.mode)))
    }

    private fun apply(transition: InterruptionTracker.Transition?) {
        when (transition) {
            is InterruptionTracker.Transition.Began -> emit(
                mapOf("type" to "interruption", "phase" to "began", "reason" to transition.reason),
            )
            is InterruptionTracker.Transition.Ended -> {
                if (prepared) {
                    // The cellular call reset the mode and may have moved the route.
                    if (am.mode != AudioManager.MODE_IN_COMMUNICATION) am.mode = AudioManager.MODE_IN_COMMUNICATION
                    reapplyRoute()
                }
                emit(
                    mapOf(
                        "type" to "interruption",
                        "phase" to "ended",
                        "reason" to transition.reason,
                        "shouldResume" to prepared,
                    ),
                )
            }
            null -> Unit
        }
    }

    private fun register() {
        // System-only protected broadcasts: no other app can send them, so exporting the
        // receiver is safe, and it is the flag that is guaranteed to receive them.
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Context.RECEIVER_EXPORTED else 0
        registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), flags)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            registerReceiver(scoReceiver, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED), flags)
        }
        am.registerAudioDeviceCallback(deviceCallback, main)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.addOnModeChangedListener(context.mainExecutor, modeListener as AudioManager.OnModeChangedListener)
            am.addOnCommunicationDeviceChangedListener(
                context.mainExecutor,
                commDeviceListener as AudioManager.OnCommunicationDeviceChangedListener,
            )
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            am.registerAudioRecordingCallback(recordingCallback as AudioManager.AudioRecordingCallback, main)
        }
    }

    private fun registerReceiver(receiver: BroadcastReceiver, filter: IntentFilter, flags: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, flags)
        } else {
            context.registerReceiver(receiver, filter)
        }
    }

    private fun unregister() {
        runCatching { context.unregisterReceiver(noisyReceiver) }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) runCatching { context.unregisterReceiver(scoReceiver) }
        am.unregisterAudioDeviceCallback(deviceCallback)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.removeOnModeChangedListener(modeListener as AudioManager.OnModeChangedListener)
            am.removeOnCommunicationDeviceChangedListener(
                commDeviceListener as AudioManager.OnCommunicationDeviceChangedListener,
            )
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            am.unregisterAudioRecordingCallback(recordingCallback as AudioManager.AudioRecordingCallback)
        }
    }

    /** Headset first (Bluetooth, then wired), then earpiece; speaker only without an earpiece. */
    private fun selectDefault() {
        val routes = availableRoutes()
        val pick = routes.firstOrNull { it.kind == "bluetooth" }
            ?: routes.firstOrNull { it.kind == "wired" }
            ?: routes.firstOrNull { it.kind == "earpiece" }
            ?: routes.firstOrNull { it.kind == "speaker" }
            ?: return
        selectedId = pick.id
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.availableCommunicationDevices.firstOrNull { routeOf(it)?.id == pick.id }?.let { am.setCommunicationDevice(it) }
        } else {
            applyLegacy(pick.kind)
        }
        updateProximity()
    }

    private fun selectDevice(device: AudioDeviceInfo) {
        selectedId = routeOf(device)?.id
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val target = am.availableCommunicationDevices.firstOrNull { it.id == device.id }
                ?: am.availableCommunicationDevices.firstOrNull { kindOf(it) == kindOf(device) }
            target?.let { am.setCommunicationDevice(it) }
        } else {
            applyLegacy(kindOf(device) ?: return)
        }
        updateProximity()
    }

    private fun reapplyRoute() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val selected = selectedId
            val device = am.availableCommunicationDevices.firstOrNull { routeOf(it)?.id == selected }
            if (device == null) selectDefault() else am.setCommunicationDevice(device)
        } else {
            legacyKind?.let { applyLegacy(it) }
        }
    }

    @Suppress("DEPRECATION")
    private fun applyLegacy(kind: String) {
        legacyKind = kind
        when (kind) {
            "bluetooth" -> {
                am.isSpeakerphoneOn = false
                am.startBluetoothSco()
                am.isBluetoothScoOn = true
            }
            "speaker" -> {
                stopSco()
                am.isSpeakerphoneOn = true
            }
            else -> {
                stopSco()
                am.isSpeakerphoneOn = false
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun stopSco() {
        if (am.isBluetoothScoOn) {
            am.isBluetoothScoOn = false
            am.stopBluetoothSco()
        }
    }

    private fun clearRoute() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.clearCommunicationDevice()
        } else {
            stopSco()
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
        }
        legacyKind = null
        selectedId = null
    }

    private fun fallbackKind(): String {
        val routes = availableRoutes()
        return when {
            routes.any { it.kind == "wired" } -> "wired"
            routes.any { it.kind == "earpiece" } -> "earpiece"
            else -> "speaker"
        }
    }

    private fun emitRoute(reason: String, force: Boolean = false) {
        if (!prepared) return
        val current = currentRoute()
        val available = availableRoutes()
        val key = current to available
        if (!force && key == lastRoute) return
        lastRoute = key
        emit(
            mapOf(
                "type" to "route",
                "current" to current?.toMap(),
                "available" to available.map { it.toMap() },
                "reason" to reason,
            ),
        )
        updateProximity()
    }

    /** Screen off when the phone is at the ear: engine running and audio on the earpiece. */
    private fun updateProximity() {
        val want = engineRunning && prepared && currentRoute()?.kind == "earpiece"
        val lock = proximity ?: run {
            if (!want || !pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
            pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "agent_audio:proximity")
                .apply { setReferenceCounted(false) }
                .also { proximity = it }
        }
        if (want && !lock.isHeld) {
            lock.acquire(PROXIMITY_MAX_MS)
        } else if (!want && lock.isHeld) {
            lock.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
        }
    }

    private fun currentHeadsetIds(): Set<Int> =
        am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { isHeadset(it) }.map { it.id }.toSet()

    companion object {
        private val EARPIECE = Route("earpiece", "earpiece", "")
        private val SPEAKER = Route("speaker", "speaker", "")

        /** Upper bound on one proximity hold (a shift's longest call, with margin). */
        private const val PROXIMITY_MAX_MS = 4L * 60 * 60 * 1000

        fun isTelephonyMode(mode: Int): Boolean =
            mode == AudioManager.MODE_RINGTONE ||
                mode == AudioManager.MODE_IN_CALL ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && mode == AudioManager.MODE_CALL_SCREENING) ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && mode == AudioManager.MODE_CALL_REDIRECT)

        fun kindOf(d: AudioDeviceInfo): String? = when (d.type) {
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            -> "wired"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_HEARING_AID,
            -> "bluetooth"
            else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && d.type == AudioDeviceInfo.TYPE_BLE_HEADSET) "bluetooth" else null
        }

        fun isHeadset(d: AudioDeviceInfo): Boolean = kindOf(d).let { it == "wired" || it == "bluetooth" }

        fun routeOf(d: AudioDeviceInfo): Route? = when (val kind = kindOf(d)) {
            "earpiece" -> EARPIECE
            "speaker" -> SPEAKER
            null -> null
            else -> Route(kind, "dev:${d.id}", d.productName?.toString().orEmpty())
        }

        private fun order(kind: String) = when (kind) {
            "earpiece" -> 0
            "speaker" -> 1
            "wired" -> 2
            else -> 3
        }
    }
}
