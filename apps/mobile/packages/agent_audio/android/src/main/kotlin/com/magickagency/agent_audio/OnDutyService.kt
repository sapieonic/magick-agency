package com.magickagency.agent_audio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder

/** The notification's content, from `OnDutyNotification.toMap()` in Dart. */
internal data class OnDutySpec(
    val title: String,
    val text: String,
    val channelName: String,
    val call: CallSpec?,
) {
    data class CallSpec(
        val muted: Boolean,
        val muteLabel: String,
        val unmuteLabel: String,
        val hangUpLabel: String,
        val connectedAtMs: Long?,
    )

    companion object {
        fun fromArgs(args: Map<*, *>?): OnDutySpec? {
            args ?: return null
            val call = args["call"] as? Map<*, *>
            return OnDutySpec(
                title = args["title"] as? String ?: return null,
                text = args["text"] as? String ?: "",
                channelName = args["channelName"] as? String ?: "On duty",
                call = call?.let {
                    CallSpec(
                        muted = it["muted"] as? Boolean ?: false,
                        muteLabel = it["muteLabel"] as? String ?: "Mute",
                        unmuteLabel = it["unmuteLabel"] as? String ?: "Unmute",
                        hangUpLabel = it["hangUpLabel"] as? String ?: "Hang up",
                        connectedAtMs = (it["connectedAtMs"] as? Number)?.toLong(),
                    )
                },
            )
        }
    }
}

/**
 * Plugin ↔ service hand-off. The service is started by Intent, so it cannot be handed the
 * plugin; both live in one process and meet here. Main thread only (service callbacks and the
 * plugin's method handler both run there).
 */
internal object OnDutyBridge {
    interface Listener {
        fun onServiceStarted()
        fun onServiceStartFailed(error: Exception)
        fun onServiceStopped()

        /** "hangUp", or "mute" with the mute state the agent asked for. */
        fun onNotificationAction(action: String, muted: Boolean?)
    }

    var spec: OnDutySpec? = null
    var running = false
    var listener: Listener? = null
}

/**
 * The on-duty foreground service (type `microphone`). It does no audio work itself: its job is
 * to keep the process at foreground priority, with microphone access, while the agent is on
 * duty, and to show the ongoing notification (with Mute / Hang up during a call).
 */
class OnDutyService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_HANG_UP -> {
                OnDutyBridge.listener?.onNotificationAction("hangUp", null)
                return START_NOT_STICKY
            }
            ACTION_TOGGLE_MUTE -> {
                val muted = OnDutyBridge.spec?.call?.muted ?: false
                OnDutyBridge.listener?.onNotificationAction("mute", !muted)
                return START_NOT_STICKY
            }
        }
        val spec = OnDutyBridge.spec
        if (spec == null) {
            // Started without content (the process was recreated): satisfy the foreground
            // contract, then leave.
            runCatching { startForegroundCompat(OnDutyNotifications.build(this, OnDutySpec("", "", "On duty", null))) }
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            startForegroundCompat(OnDutyNotifications.build(this, spec))
            OnDutyBridge.running = true
            OnDutyBridge.listener?.onServiceStarted()
        } catch (e: Exception) {
            // Android 14+: SecurityException when the microphone type is not allowed right now.
            OnDutyBridge.running = false
            OnDutyBridge.listener?.onServiceStartFailed(e)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        OnDutyBridge.running = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        OnDutyBridge.listener?.onServiceStopped()
        super.onDestroy()
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(OnDutyNotifications.NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(OnDutyNotifications.NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val ACTION_START = "com.magickagency.agent_audio.action.START"
        const val ACTION_HANG_UP = "com.magickagency.agent_audio.action.HANG_UP"
        const val ACTION_TOGGLE_MUTE = "com.magickagency.agent_audio.action.TOGGLE_MUTE"
    }
}

internal object OnDutyNotifications {
    const val CHANNEL_ID = "magick_agency_on_duty"
    const val NOTIFICATION_ID = 0x4D41 // "MA"

    /** Creates or renames the channel. Low importance: visible, never makes a sound. */
    fun ensureChannel(context: Context, name: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    fun build(context: Context, spec: OnDutySpec): Notification {
        val b = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.agent_audio_ic_on_duty)
            .setContentTitle(spec.title)
            .setContentText(spec.text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(if (spec.call != null) Notification.CATEGORY_CALL else Notification.CATEGORY_SERVICE)
        launchIntent(context)?.let { b.setContentIntent(it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        val call = spec.call
        if (call != null) {
            val connectedAt = call.connectedAtMs
            if (connectedAt != null) {
                b.setWhen(connectedAt).setShowWhen(true).setUsesChronometer(true)
            } else {
                b.setShowWhen(false)
            }
            b.addAction(
                action(
                    context,
                    OnDutyService.ACTION_TOGGLE_MUTE,
                    if (call.muted) R.drawable.agent_audio_ic_mic else R.drawable.agent_audio_ic_mic_off,
                    if (call.muted) call.unmuteLabel else call.muteLabel,
                    REQUEST_MUTE,
                ),
            )
            b.addAction(action(context, OnDutyService.ACTION_HANG_UP, R.drawable.agent_audio_ic_call_end, call.hangUpLabel, REQUEST_HANG_UP))
        } else {
            b.setShowWhen(false)
        }
        return b.build()
    }

    private fun action(context: Context, action: String, icon: Int, label: String, requestCode: Int): Notification.Action {
        val intent = Intent(context, OnDutyService::class.java).setAction(action)
        val pi = PendingIntent.getService(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Action.Builder(Icon.createWithResource(context, icon), label, pi).build()
    }

    private fun launchIntent(context: Context): PendingIntent? {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, REQUEST_OPEN, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private const val REQUEST_OPEN = 1
    private const val REQUEST_MUTE = 2
    private const val REQUEST_HANG_UP = 3
}
