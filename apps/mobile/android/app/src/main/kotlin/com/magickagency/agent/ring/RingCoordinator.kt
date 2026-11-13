package com.magickagency.agent.ring

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.magickagency.agent_audio.OwnRing

/**
 * The Android side of Mode B's ring: feeds [RingStateMachine] (pure, JVM-tested) from FCM, Telecom,
 * the notification and lock-screen taps, its own timers and Dart's reports, and carries out the
 * effects it returns. Thin on purpose: every decision is the state machine's.
 *
 * Every entry point may be called from any thread; the work runs on the main thread, in order.
 */
@SuppressLint("StaticFieldLeak") // Holds the application context only.
internal object RingCoordinator {
    private const val TAG = "MagickRing"

    /** When Telecom has not asked for the ring's UI by then, the notification goes up anyway. */
    private const val SHOW_UI_FALLBACK_MS = 2_000L
    private const val TOKEN_TIMEOUT_MS = 10_000L

    private val main = Handler(Looper.getMainLooper())
    private val machine = RingStateMachine()
    private var app: Context? = null
    private var store: RingStore? = null
    private var api: RingApi? = null

    private val connections = HashMap<String, RingConnection>()
    private val timers = HashMap<Pair<TimerKind, String>, Runnable>()
    private val uiFallbacks = HashMap<String, Runnable>()
    private val silenced = HashSet<String>()
    private val listeners = LinkedHashSet<(RingState) -> Unit>()

    /** The saved answer, in memory first (the process usually lives from the ring to Flutter's read). */
    private var pending: PendingAnswer? = null

    private fun init(context: Context): Context {
        app?.let { return it }
        val a = context.applicationContext
        app = a
        store = RingStore(a).also { machine.restoreAway(it.away) }
        api = RingApi(a)
        return a
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }

    val state: RingState get() = machine.state

    /**
     * Dart holds the app over the lock screen (`holdOverLockScreen`): a call answered from a ring is
     * on its station until its outcome is saved or it leaves, past the ring's Answered state (which
     * ends when the call does). Main thread; listeners hear the change.
     */
    var lockScreenHeld: Boolean = false
        private set

    fun holdOverLockScreen(on: Boolean) = onMain {
        if (lockScreenHeld == on) return@onMain
        lockScreenHeld = on
        val s = machine.state
        for (l in listeners.toList()) l(s)
    }

    /** Main thread. [RingActivity] and [com.magickagency.agent.MainActivity] follow the ring with this. */
    fun addListener(listener: (RingState) -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: (RingState) -> Unit) {
        listeners -= listener
    }

    // ─── Entry points ────────────────────────────────────────────────────────

    /** An FCM data message ([RingMessagingService], a worker thread); [sentAtMs]: FCM's send time, null when unknown. */
    fun onPush(context: Context, data: Map<String, String>, sentAtMs: Long?) {
        val push = RingPushParser.parse(data)
        if (push == null) {
            Log.w(TAG, "Ignored a push that is not a ring push (type=${data["type"]})")
            return
        }
        onMain {
            val a = init(context)
            // What the phone says about calls; whether our own ring explains it is the state machine's call.
            val phone = if (push is RingPush.Ring || push is RingPush.Test) RingTelecom.phoneSignals(a) else PhoneSignals.IDLE
            dispatch(RingEvent.Push(push, System.currentTimeMillis(), phone, sentAtMs))
        }
    }

    /** FCM's `onNewToken` and `onRegistered` both report the token: the same one again is not news (one PUT, not two). */
    fun onNewToken(context: Context, token: String) {
        onMain {
            init(context)
            if (store?.token == token) return@onMain
            store?.token = token
            RingChannel.invoke("token", mapOf("token" to token))
        }
    }

    fun answer(context: Context, callId: String, source: AnswerSource) = onMain {
        init(context)
        dispatch(RingEvent.AnswerTapped(callId, System.currentTimeMillis(), source))
    }

    /** Decline from the notification or the lock-screen ring. [onDone] runs once the decline was sent (or not needed). */
    fun decline(context: Context, callId: String, onDone: (() -> Unit)? = null) = onMain {
        init(context)
        declineDone = onDone
        dispatch(RingEvent.DeclineTapped(callId))
        declineDone?.invoke()
        declineDone = null
    }

    private var declineDone: (() -> Unit)? = null

    fun onConnectionCreated(context: Context, callId: String, connection: RingConnection) = onMain {
        init(context)
        val s = machine.state
        if (s is RingState.Ringing && s.call.callId == callId) {
            connections[callId] = connection
        } else {
            // The ring ended while Telecom was setting up its call.
            connection.setDisconnected(RingTelecom.disconnectCause(EndCause.CANCELED))
            connection.destroy()
        }
    }

    fun onIncomingRefused(context: Context, callId: String) = onMain {
        init(context)
        dispatch(RingEvent.IncomingRefused(callId))
    }

    fun onShowIncomingUi(callId: String) = onMain {
        val a = app ?: return@onMain
        uiFallbacks.remove(callId)?.let(main::removeCallbacks)
        val s = machine.state
        if (s is RingState.Ringing && s.call.callId == callId) {
            showIncoming(a, s.call, s.deadlineMs, silent = callId in silenced)
        }
    }

    fun onTelecomAnswer(callId: String) = onMain {
        dispatch(RingEvent.AnswerTapped(callId, System.currentTimeMillis(), AnswerSource.TELECOM))
    }

    fun onTelecomReject(callId: String) = onMain { dispatch(RingEvent.DeclineTapped(callId)) }

    fun onTelecomDisconnect(callId: String) = onMain {
        val effects = dispatch(RingEvent.TelecomDisconnected(callId))
        if (effects.any { it is RingEffect.Dropped }) {
            // Telecom asked (another call, a car's hang-up) for a call the state machine keeps:
            // after bind it is Flutter's (the channel has no native hang-up), so only Telecom's
            // placeholder goes.
            releaseConnection(callId, EndCause.LOCAL)
        }
    }

    fun onSilence(callId: String) = onMain {
        val a = app ?: return@onMain
        silenced += callId
        val s = machine.state
        if (s is RingState.Ringing && s.call.callId == callId) showIncoming(a, s.call, s.deadlineMs, silent = true)
    }

    fun reportBound(callId: String) = onMain { dispatch(RingEvent.Bound(callId)) }

    fun reportEnded(callId: String, reason: String) = onMain { dispatch(RingEvent.EndedByApp(callId, reason)) }

    /** `pendingAnswer`: the answered ring Dart has not taken yet, once, while the grace runs. Main thread. */
    fun takePendingAnswer(context: Context): PendingAnswer? {
        init(context)
        val answer = pending ?: store?.readPendingAnswer()
        pending = null
        store?.clearPendingAnswer()
        return answer?.takeIf { it.isFresh(System.currentTimeMillis()) }
    }

    /** `getToken`: the FCM token, or null when this build has no Firebase (no defines) or no Play services. Main thread. */
    fun token(context: Context, reply: (String?) -> Unit) {
        val a = init(context)
        // The default app comes from the resValues Gradle wrote from the Firebase dart-defines
        // (FirebaseInitProvider, at process start); without them push is unavailable.
        if (FirebaseApp.getApps(a).none { it.name == FirebaseApp.DEFAULT_APP_NAME }) {
            reply(null)
            return
        }
        var replied = false
        val finish = { t: String? ->
            if (!replied) {
                replied = true
                reply(t)
            }
        }
        val timeout = Runnable { finish(store?.token) }
        main.postDelayed(timeout, TOKEN_TIMEOUT_MS)
        try {
            // getToken is deprecated in firebase-messaging 25 in favour of register() and
            // onRegistered; it still issues the token, and RingMessagingService handles both.
            @Suppress("DEPRECATION")
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                main.removeCallbacks(timeout)
                val t = if (task.isSuccessful) task.result else null
                if (t != null) store?.token = t else Log.w(TAG, "No FCM token: ${task.exception?.javaClass?.simpleName}")
                finish(t)
            }
        } catch (e: RuntimeException) {
            main.removeCallbacks(timeout)
            Log.w(TAG, "FCM unavailable: ${e.javaClass.simpleName}")
            finish(null)
        }
    }

    /**
     * `showAwayNotification`: the away notification up for the absence that began at [sinceMs]
     * (server clock) in [sessionId], or down. A new absence drops a `ring_off` Dart never took (it
     * was for an earlier one). Main thread.
     */
    fun showAway(context: Context, on: Boolean, sinceMs: Long?, sessionId: String?) {
        val a = init(context)
        RingNotifications.showAway(a, on)
        // A new absence: a ring_off or a "Stop ringing" Dart never took was for an earlier one.
        if (on) {
            store?.ringOff = null
            store?.stopRinging = null
        }
        dispatch(RingEvent.AwayChanged(if (on) AwayAbsence(sessionId, sinceMs) else null))
        store?.away = machine.away
    }

    /** `takeRingOff`: the `ring_off` that ended the shown absence, once (cleared on read). Main thread. */
    fun takeRingOff(context: Context): RingEffect.RingOff? {
        init(context)
        val off = store?.ringOff
        store?.ringOff = null
        return off
    }

    /**
     * The away notification's "Stop ringing" ([com.magickagency.agent.MainActivity], before Flutter
     * hears of the launch): for this absence only. A ring ringing now is declined, and one arriving
     * in the next ring window too, so the app opening to leave `away_ring` never answers one by
     * attaching (N5). Kept for Dart (`takeStopRinging`), which asks `device_away` before its
     * station attaches. Main thread.
     */
    fun stopRingingTapped(context: Context) {
        init(context)
        store?.stopRinging = machine.away?.takeIf { it.shown } ?: AwayAbsence(null, null)
        dispatch(RingEvent.StopRingingTapped(System.currentTimeMillis()))
    }

    /** `takeStopRinging`: the "Stop ringing" tap Dart has not taken, once (cleared on read). Main thread. */
    fun takeStopRinging(context: Context): AwayAbsence? {
        init(context)
        val stop = store?.stopRinging
        if (stop != null) store?.stopRinging = null
        return stop
    }

    // ─── The state machine and its effects ───────────────────────────────────

    private fun dispatch(event: RingEvent): List<RingEffect> {
        val effects = machine.handle(event)
        for (e in effects) apply(e)
        val s = machine.state
        // agent_audio reads this: our own ring's ringtone mode is not a cellular call.
        OwnRing.live = s is RingState.Ringing || s is RingState.Answering
        for (l in listeners.toList()) l(s)
        return effects
    }

    private fun apply(effect: RingEffect) {
        val a = app ?: return
        when (effect) {
            is RingEffect.StartRinging -> startRinging(a, effect.call, effect.deadlineMs)
            is RingEffect.RingByNotification -> {
                Log.i(TAG, "Telecom refused a ring that replaced ours; ringing by the notification")
                showIncoming(a, effect.call, effect.deadlineMs, silent = effect.call.callId in silenced)
            }
            is RingEffect.PostAnswering -> api?.answering(effect.callId, effect.offerToken)
            is RingEffect.PostDecline -> {
                val done = declineDone
                declineDone = null
                api?.decline(effect.callId, effect.offerToken, effect.reason) { done?.invoke() }
            }
            is RingEffect.SetActive -> {
                connections[effect.callId]?.setActive()
                val call = machine.activeCall
                if (call != null && call.callId == effect.callId && machine.state is RingState.Answering) {
                    RingNotifications.showAnswering(a, call, surfaceApp = effect.surfaceApp)
                }
                if (effect.surfaceApp) {
                    // Allowed only where the system lets a bound service start an activity; the
                    // answered notification's full-screen intent covers the rest (field test).
                    try {
                        a.startActivity(
                            RingIntents.mainActivity(a, RingIntents.ACTION_SHOW)
                                .putExtra(RingIntents.EXTRA_RING, true)
                                .putExtra(RingIntents.EXTRA_CALL_ID, effect.callId),
                        )
                    } catch (e: RuntimeException) {
                        Log.i(TAG, "Could not bring the app up after a headset answer: ${e.javaClass.simpleName}")
                    }
                }
            }
            is RingEffect.CallBound -> RingNotifications.cancelCall(a, effect.callId)
            is RingEffect.Disconnect -> {
                uiFallbacks.remove(effect.callId)?.let(main::removeCallbacks)
                silenced -= effect.callId
                releaseConnection(effect.callId, effect.cause)
                RingNotifications.cancelCall(a, effect.callId)
            }
            is RingEffect.ScheduleTimer -> {
                val key = effect.kind to effect.callId
                timers.remove(key)?.let(main::removeCallbacks)
                val r = Runnable {
                    timers.remove(key)
                    dispatch(
                        when (effect.kind) {
                            TimerKind.RING -> RingEvent.RingTimedOut(effect.callId)
                            TimerKind.GRACE -> RingEvent.GraceLapsed(effect.callId)
                        },
                    )
                }
                timers[key] = r
                main.postDelayed(r, maxOf(0L, effect.atMs - System.currentTimeMillis()))
            }
            is RingEffect.CancelTimer -> timers.remove(effect.kind to effect.callId)?.let(main::removeCallbacks)
            is RingEffect.SavePendingAnswer -> {
                pending = effect.answer
                store?.savePendingAnswer(effect.answer)
            }
            RingEffect.ClearPendingAnswer -> {
                pending = null
                store?.clearPendingAnswer()
            }
            is RingEffect.DeliverAnswered -> RingChannel.invoke("ringAnswered", effect.answer.toChannelMap()) { heard ->
                // Dart took it: it must not read it again from pendingAnswer.
                if (heard && pending?.callId == effect.answer.callId) {
                    pending = null
                    store?.clearPendingAnswer()
                }
            }
            is RingEffect.EmitEnded -> RingChannel.invoke(
                "ringEnded", mapOf("call_id" to effect.callId, "reason" to effect.reason),
            ) { heard -> if (!heard && effect.missedIfUnheard) RingNotifications.showMissed(a) }
            is RingEffect.EmitTestRing -> RingChannel.invoke("testRingReceived", mapOf("shown" to effect.shown))
            is RingEffect.RingOff -> {
                store?.away = machine.away
                store?.ringOff = effect
                RingNotifications.showRingOff(a, effect.reason)
            }
            is RingEffect.Dropped -> Log.i(TAG, "Ring event dropped: ${effect.reason}")
        }
    }

    private fun startRinging(a: Context, call: RingCall, deadlineMs: Long) {
        RingNotifications.ensureChannels(a)
        if (RingTelecom.addIncoming(a, call.callId)) {
            // Telecom calls onShowIncomingCallUi; if it does not, ring by the notification anyway.
            val fallback = Runnable {
                uiFallbacks.remove(call.callId)
                val s = machine.state
                if (s is RingState.Ringing && s.call.callId == call.callId) {
                    Log.w(TAG, "Telecom did not ask for the ring's UI; showing it anyway")
                    showIncoming(a, s.call, s.deadlineMs, silent = call.callId in silenced)
                }
            }
            uiFallbacks[call.callId] = fallback
            main.postDelayed(fallback, SHOW_UI_FALLBACK_MS)
        } else {
            showIncoming(a, call, deadlineMs, silent = false)
        }
    }

    /** Posts the ringing notification and tells the state machine whether it went up (a test ring's result). */
    private fun showIncoming(a: Context, call: RingCall, deadlineMs: Long, silent: Boolean) {
        val posted = RingNotifications.showIncoming(a, call, deadlineMs, silent)
        dispatch(RingEvent.IncomingShown(call.callId, posted))
    }

    private fun releaseConnection(callId: String, cause: EndCause) {
        val c = connections.remove(callId) ?: return
        c.setDisconnected(RingTelecom.disconnectCause(cause))
        c.destroy()
    }
}
