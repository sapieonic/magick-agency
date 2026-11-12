package com.magickagency.agent.ring

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM without a Flutter plugin: the ring's data pushes (`AgencyRingPush`) reach native code only,
 * and Dart never handles a push itself. High-priority data messages arrive here even with the app
 * in the background or not running.
 */
class RingMessagingService : FirebaseMessagingService() {
    @Deprecated("firebase-messaging 25 deprecates it for onRegistered; both report the token")
    override fun onNewToken(token: String) = RingCoordinator.onNewToken(applicationContext, token)

    override fun onRegistered(token: String) = RingCoordinator.onNewToken(applicationContext, token)

    override fun onMessageReceived(message: RemoteMessage) = RingCoordinator.onPush(applicationContext, message.data)
}

/** The ringing notification's Decline (no activity: declining needs no screen). */
class RingActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != RingIntents.ACTION_DECLINE) return
        val callId = intent.getStringExtra(RingIntents.EXTRA_CALL_ID) ?: return
        // Keep the process until the decline has been sent (or found unneeded).
        val pending = goAsync()
        RingCoordinator.decline(context, callId) { pending.finish() }
    }
}
