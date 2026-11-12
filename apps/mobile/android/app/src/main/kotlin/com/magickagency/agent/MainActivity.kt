package com.magickagency.agent

import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import com.magickagency.agent.ring.AnswerSource
import com.magickagency.agent.ring.RingChannel
import com.magickagency.agent.ring.RingCoordinator
import com.magickagency.agent.ring.RingIntents
import com.magickagency.agent.ring.RingState
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    /** The window shows over the lock screen only while a ring the agent answered is live. */
    private val followRing: (RingState) -> Unit = { s ->
        if (s !is RingState.Answering && s !is RingState.Answered) showOverLockScreen(false)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        RingCoordinator.addListener(followRing)
        // A recreated activity (or one relaunched from recents) must not answer again.
        val fresh = savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
        if (fresh) handleRingIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleRingIntent(intent)
    }

    override fun onDestroy() {
        RingCoordinator.removeListener(followRing)
        super.onDestroy()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        RingChannel.attach(flutterEngine.dartExecutor.binaryMessenger, this)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        RingChannel.detach(flutterEngine.dartExecutor.binaryMessenger)
        super.cleanUpFlutterEngine(flutterEngine)
    }

    private fun handleRingIntent(intent: Intent) {
        if (intent.getBooleanExtra(RingIntents.EXTRA_STOP_RINGING, false)) {
            intent.removeExtra(RingIntents.EXTRA_STOP_RINGING)
            RingCoordinator.stopRingingTapped(this)
        }
        if (!intent.getBooleanExtra(RingIntents.EXTRA_RING, false)) {
            followRing(RingCoordinator.state)
            return
        }
        showOverLockScreen(true)
        val callId = intent.getStringExtra(RingIntents.EXTRA_CALL_ID)
        if (intent.action == RingIntents.ACTION_ANSWER && callId != null) {
            // The notification's Answer: native posts `…/ring/answering` and hands the call to
            // Dart (ringAnswered, or pendingAnswer once Dart is up).
            RingCoordinator.answer(this, callId, AnswerSource.NOTIFICATION)
        }
        intent.removeExtra(RingIntents.EXTRA_RING)
        intent.action = Intent.ACTION_MAIN
    }

    private fun showOverLockScreen(on: Boolean) {
        setShowWhenLocked(on)
        setTurnScreenOn(on)
        if (on) getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
    }
}
