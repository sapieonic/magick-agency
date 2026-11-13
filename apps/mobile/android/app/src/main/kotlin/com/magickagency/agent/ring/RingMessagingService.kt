package com.magickagency.agent.ring

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicBoolean
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

    // sentTime: when FCM accepted the message (Google's clock), for the ring's time left (0: unknown).
    override fun onMessageReceived(message: RemoteMessage) =
        RingCoordinator.onPush(applicationContext, message.data, message.sentTime.takeIf { it > 0 })
}

/** The ringing notification's Decline (no activity: declining needs no screen). */
class RingActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != RingIntents.ACTION_DECLINE) return
        val callId = intent.getStringExtra(RingIntents.EXTRA_CALL_ID) ?: return
        // Keep the process until the decline has been sent (or found unneeded), and never past
        // FINISH_BOUND_MS: a broadcast held too long is an ANR. The decline itself is bounded
        // inside that ([RingRequests.DECLINE_BUDGET_MS]); this is the backstop.
        val pending = goAsync()
        val finished = AtomicBoolean(false)
        val finish = { if (finished.compareAndSet(false, true)) pending.finish() }
        val main = Handler(Looper.getMainLooper())
        val backstop = Runnable { finish() }
        main.postDelayed(backstop, FINISH_BOUND_MS)
        try {
            RingCoordinator.decline(context, callId) {
                main.removeCallbacks(backstop)
                finish()
            }
        } catch (e: RuntimeException) {
            main.removeCallbacks(backstop)
            finish()
            throw e
        }
    }

    private companion object {
        const val FINISH_BOUND_MS = 9_000L
    }
}
