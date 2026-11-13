package com.magickagency.agent.ring

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.util.Log
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.lang.ref.WeakReference

/**
 * The frozen `magick_agency/ring` method channel (`docs/mobile.md` "The ring channel (Mode B)"):
 * one MethodChannel, standard codec, both directions. Registered on MainActivity's FlutterEngine;
 * native → Dart calls go through [invoke] and report whether Dart's handler took them, so what Dart
 * has not heard is kept (`pendingAnswer`) or posted natively (a missed ring). What Dart reads when
 * it is ready (`takeRingOff`, `takeStopRinging`) is kept until read.
 * Main thread only.
 */
@SuppressLint("StaticFieldLeak") // Holds the application context only.
internal object RingChannel {
    const val NAME = "magick_agency/ring"
    private const val TAG = "MagickRing"

    private var channel: MethodChannel? = null
    private var messenger: BinaryMessenger? = null

    /** The activity the engine runs in, for `moveTaskToBack`; weak, so the channel never keeps it. */
    private var activity: WeakReference<Activity>? = null

    fun attach(messenger: BinaryMessenger, context: Context) {
        activity = (context as? Activity)?.let(::WeakReference)
        val a = context.applicationContext
        channel?.setMethodCallHandler(null)
        this.messenger = messenger
        channel = MethodChannel(messenger, NAME).also { it.setMethodCallHandler { call, result -> handle(a, call, result) } }
    }

    /** Only the engine that attached last detaches: a new activity's engine may attach before the old one is cleaned up. */
    fun detach(messenger: BinaryMessenger) {
        if (messenger !== this.messenger) return
        channel?.setMethodCallHandler(null)
        channel = null
        this.messenger = null
        activity = null
    }

    /**
     * Calls Dart. [onResult] gets true when Dart's handler answered, false when there is no engine
     * or no handler yet (a cold start before Dart registered it) or it failed.
     */
    fun invoke(method: String, args: Any?, onResult: ((Boolean) -> Unit)? = null) {
        val c = channel
        if (c == null) {
            onResult?.invoke(false)
            return
        }
        c.invokeMethod(method, args, object : MethodChannel.Result {
            override fun success(result: Any?) {
                onResult?.invoke(true)
            }

            override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {
                Log.w(TAG, "Dart failed $method: $errorCode")
                onResult?.invoke(false)
            }

            override fun notImplemented() {
                onResult?.invoke(false)
            }
        })
    }

    private fun handle(context: Context, call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "getToken" -> RingCoordinator.token(context) { result.success(it) }
            "pendingAnswer" -> result.success(RingCoordinator.takePendingAnswer(context)?.toChannelMap())
            "checklist" -> result.success(RingSettings.checklist(context).toChannelMap())
            "openSettings" -> {
                val item = call.argument<String>("item")
                if (item == null || item !in RingChecklist.ITEMS) {
                    result.error("bad_args", "openSettings needs an item, one of ${RingChecklist.ITEMS}", null)
                } else {
                    RingSettings.open(context, item)
                    result.success(null)
                }
            }
            "reportBound" -> withCallId(call, result) { id ->
                RingCoordinator.reportBound(id)
                result.success(null)
            }
            "reportEnded" -> withCallId(call, result) { id ->
                val reason = call.argument<String>("reason")
                if (reason == null) {
                    result.error("bad_args", "reportEnded needs a reason", null)
                } else {
                    RingCoordinator.reportEnded(id, reason)
                    result.success(null)
                }
            }
            "showAwayNotification" -> {
                val on = call.argument<Boolean>("on")
                if (on == null) {
                    result.error("bad_args", "showAwayNotification needs on", null)
                } else {
                    // `since` and `session_id` are optional: the absence the notification is for.
                    val since = call.argument<String>("since")?.let(RingPushParser::parseIsoMillis)
                    RingCoordinator.showAway(context, on, since, call.argument<String>("session_id"))
                    result.success(null)
                }
            }
            "takeRingOff" -> result.success(RingCoordinator.takeRingOff(context)?.toChannelMap())
            "takeStopRinging" -> result.success(
                RingCoordinator.takeStopRinging(context)?.let { stop ->
                    mapOf(
                        "session_id" to stop.sessionId,
                        "since" to stop.sinceMs?.let { java.time.Instant.ofEpochMilli(it).toString() },
                    )
                },
            )
            "moveTaskToBack" -> result.success(activity?.get()?.moveTaskToBack(true) ?: false)
            "showMissedRing" -> {
                RingNotifications.showMissed(context)
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    /** `takeRingOff`'s `{session_id, away_since, reason}`, each null when unknown. */
    private fun RingEffect.RingOff.toChannelMap(): Map<String, String?> = mapOf(
        "session_id" to sessionId,
        "away_since" to awaySinceMs?.let { java.time.Instant.ofEpochMilli(it).toString() },
        "reason" to reason,
    )

    private inline fun withCallId(call: MethodCall, result: MethodChannel.Result, block: (String) -> Unit) {
        val id = call.argument<String>("call_id")
        if (id.isNullOrEmpty()) result.error("bad_args", "${call.method} needs a call_id", null) else block(id)
    }
}
