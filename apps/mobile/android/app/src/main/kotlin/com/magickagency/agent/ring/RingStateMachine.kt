package com.magickagency.agent.ring

// Pure Kotlin (no android.* imports): JVM unit-tested (src/test/.../RingStateMachineTest.kt).
// RingCoordinator feeds it events on the main thread and carries out the effects it returns.

/** The call a ring is for. A test ring has no token or session and never reaches the server. */
data class RingCall(
    val callId: String,
    val offerToken: String,
    val sessionId: String,
    val test: Boolean,
) {
    override fun toString(): String = "RingCall(callId=$callId, sessionId=$sessionId, test=$test)"

    companion object {
        fun of(ring: RingPush.Ring) = RingCall(ring.callId, ring.offerToken, ring.sessionId, test = false)
    }
}

/**
 * The ring the agent answered, for Dart (`ringAnswered`, or `pendingAnswer` after a cold start).
 * [answeredAtMs] is the phone's wall clock; it is not sent to Dart.
 */
data class PendingAnswer(
    val callId: String,
    val offerToken: String,
    val sessionId: String,
    val answeredAtMs: Long,
) {
    /** Still worth accepting: the server's grace has not lapsed (with the phone's margin). */
    fun isFresh(nowMs: Long): Boolean =
        nowMs >= answeredAtMs && nowMs < answeredAtMs + RingWire.ACCEPT_GRACE_MS + RingWire.GRACE_MARGIN_MS

    /** The channel's `{call_id, offer_token, session_id}`. */
    fun toChannelMap(): Map<String, String> =
        mapOf("call_id" to callId, "offer_token" to offerToken, "session_id" to sessionId)

    override fun toString(): String = "PendingAnswer(callId=$callId, sessionId=$sessionId, answeredAtMs=$answeredAtMs)"
}

sealed class RingState {
    /** Nothing ringing. */
    data object Idle : RingState()

    /** The phone rings until [deadlineMs] (wall clock). */
    data class Ringing(val call: RingCall, val deadlineMs: Long) : RingState()

    /** The agent answered; Flutter has until [graceDeadlineMs] to accept and bind (`reportBound`). */
    data class Answering(val call: RingCall, val answeredAtMs: Long, val graceDeadlineMs: Long) : RingState()

    /** The station bound the call's audio; Flutter owns the call until `reportEnded`. */
    data class Answered(val call: RingCall) : RingState()

    /** The last ring ended ([reason]: a ring result, an app reason, or `test`). Rings again like [Idle]. */
    data class Ended(val callId: String, val reason: String) : RingState()
}

/** Where an Answer came from. Only Telecom's (a headset or car button) has no activity launching with it. */
enum class AnswerSource { NOTIFICATION, LOCK_SCREEN, TELECOM }

sealed class RingEvent {
    /** A push arrived. [busyOnPhone]: a cellular call is on (Telecom does not permit an incoming call, or the audio mode is a telephony one; IQ70). */
    data class Push(val push: RingPush, val nowMs: Long, val busyOnPhone: Boolean = false) : RingEvent()

    data class AnswerTapped(val callId: String, val nowMs: Long, val source: AnswerSource) : RingEvent()

    /** Decline on the notification or the lock-screen ring, or Telecom's `onReject`. */
    data class DeclineTapped(val callId: String) : RingEvent()

    /** Telecom's `onDisconnect`/`onAbort` (a hang-up from the system, a headset or a car). */
    data class TelecomDisconnected(val callId: String) : RingEvent()

    /** Telecom would not create the incoming call (`onCreateIncomingConnectionFailed`): another call holds the phone. */
    data class IncomingRefused(val callId: String) : RingEvent()

    data class RingTimedOut(val callId: String) : RingEvent()

    data class GraceLapsed(val callId: String) : RingEvent()

    /** `reportBound(call_id)` from Dart. */
    data class Bound(val callId: String) : RingEvent()

    /** `reportEnded(call_id, reason)` from Dart: `ended`, `accept_failed` or `cancelled`. */
    data class EndedByApp(val callId: String, val reason: String) : RingEvent()
}

/** How a Telecom connection ends; the coordinator maps it to `android.telecom.DisconnectCause`. */
enum class EndCause { LOCAL, REMOTE, REJECTED, MISSED, CANCELED, ANSWERED_ELSEWHERE, BUSY, ERROR }

enum class TimerKind { RING, GRACE }

/** Why an event changed nothing (for the log and the tests). */
enum class DropReason { DUPLICATE, LATE, EXPIRED, STALE, OTHER_CALL, BUSY_WITH_CALL, BUSY_ON_PHONE, ALREADY_ANSWERED, BOUND }

sealed class RingEffect {
    /** Ring through Telecom (falling back to the notification alone), with the incoming CallStyle notification. */
    data class StartRinging(val call: RingCall, val deadlineMs: Long) : RingEffect()

    data class PostAnswering(val callId: String, val offerToken: String) : RingEffect() {
        override fun toString(): String = "PostAnswering(callId=$callId)"
    }

    data class PostDecline(val callId: String, val offerToken: String, val reason: DeclineReason) : RingEffect() {
        override fun toString(): String = "PostDecline(callId=$callId, reason=$reason)"
    }

    /**
     * Mark the Telecom connection active and show the answered notification. [surfaceApp]: no
     * activity is launching with the answer (a headset or car button), so the notification's
     * full-screen intent has to bring the app up.
     */
    data class SetActive(val callId: String, val surfaceApp: Boolean) : RingEffect()

    /** The station bound: drop the call notification (the on-duty service's takes over), keep the connection. */
    data class CallBound(val callId: String) : RingEffect()

    /** End the Telecom connection and drop the call's notification. */
    data class Disconnect(val callId: String, val cause: EndCause) : RingEffect()

    data class ScheduleTimer(val kind: TimerKind, val callId: String, val atMs: Long) : RingEffect()

    data class CancelTimer(val kind: TimerKind, val callId: String) : RingEffect()

    data class SavePendingAnswer(val answer: PendingAnswer) : RingEffect()

    data object ClearPendingAnswer : RingEffect()

    /** `ringAnswered` to Dart; once Dart's handler took it, the saved pending answer is cleared. */
    data class DeliverAnswered(val answer: PendingAnswer) : RingEffect()

    /** `ringEnded {call_id, reason}` to Dart; [missedIfUnheard]: post "Missed inbound call" when no Dart handler took it. */
    data class EmitEnded(val callId: String, val reason: String, val missedIfUnheard: Boolean) : RingEffect()

    /** `testRingReceived` to Dart. */
    data object EmitTestRing : RingEffect()

    /** A `ring_off`: drop the away notification and say why ([reason] null when unknown). */
    data class RingOff(val reason: String?) : RingEffect()

    data class Dropped(val reason: DropReason) : RingEffect()
}

/**
 * The phone's side of one ring at a time (IQ60): `Idle → Ringing → Answering → Answered`, or
 * `→ Ended(reason)`. Late, duplicate and expired rings, and cancels for another call, change
 * nothing. Not thread-safe: one thread (Android's main thread) drives it.
 */
class RingStateMachine(private val rememberEnded: Int = 32) {
    var state: RingState = RingState.Idle
        private set

    /** Calls that have ended here, newest last: a ring for one of them arriving late is dropped. */
    private val ended = LinkedHashSet<String>()
    private var testSeq = 0

    fun handle(event: RingEvent): List<RingEffect> = when (event) {
        is RingEvent.Push -> onPush(event)
        is RingEvent.AnswerTapped -> onAnswer(event)
        is RingEvent.DeclineTapped -> onDecline(event.callId)
        is RingEvent.TelecomDisconnected -> onDecline(event.callId)
        is RingEvent.IncomingRefused -> onRefused(event.callId)
        is RingEvent.RingTimedOut -> onRingTimeout(event.callId)
        is RingEvent.GraceLapsed -> onGraceLapsed(event.callId)
        is RingEvent.Bound -> onBound(event.callId)
        is RingEvent.EndedByApp -> onEndedByApp(event.callId, event.reason)
    }

    /** The call a ring is live for (ringing, answering or answered), if any. */
    val activeCall: RingCall?
        get() = when (val s = state) {
            is RingState.Ringing -> s.call
            is RingState.Answering -> s.call
            is RingState.Answered -> s.call
            else -> null
        }

    // ─── Pushes ──────────────────────────────────────────────────────────────

    private fun onPush(e: RingEvent.Push): List<RingEffect> = when (val p = e.push) {
        is RingPush.Ring -> onRing(p, e.nowMs, e.busyOnPhone)
        is RingPush.Test -> onTestRing(e.nowMs, e.busyOnPhone)
        is RingPush.Cancel -> onCancel(p)
        is RingPush.Off -> onOff(p)
    }

    private fun onRing(ring: RingPush.Ring, now: Long, busy: Boolean): List<RingEffect> {
        if (ring.callId in ended) return listOf(RingEffect.Dropped(DropReason.LATE))
        val current = activeCall
        if (current?.callId == ring.callId) return listOf(RingEffect.Dropped(DropReason.DUPLICATE))
        if (ring.expiresAtMs <= now) {
            remember(ring.callId)
            return listOf(RingEffect.Dropped(DropReason.EXPIRED))
        }
        val call = RingCall.of(ring)
        val out = mutableListOf<RingEffect>()
        when (val s = state) {
            // On another call of ours: the server should not ring now, so the ring is stale or
            // crossed. Decline at once (not a miss) rather than let it ring out as a miss.
            is RingState.Answering, is RingState.Answered -> {
                remember(call.callId)
                return listOf(
                    RingEffect.PostDecline(call.callId, call.offerToken, DeclineReason.BUSY_ON_PHONE),
                    RingEffect.Dropped(DropReason.BUSY_WITH_CALL),
                )
            }
            // One ring at a time (IQ60): a new ring means the server is done with the old one (its
            // ring_cancel lost or late). A test ring gives way quietly.
            is RingState.Ringing -> {
                out += RingEffect.CancelTimer(TimerKind.RING, s.call.callId)
                out += RingEffect.Disconnect(s.call.callId, EndCause.CANCELED)
                if (!s.call.test) out += RingEffect.EmitEnded(s.call.callId, "cancelled", missedIfUnheard = false)
                remember(s.call.callId)
            }
            else -> Unit
        }
        if (busy) {
            remember(call.callId)
            state = RingState.Ended(call.callId, DeclineReason.BUSY_ON_PHONE.wire)
            out += RingEffect.PostDecline(call.callId, call.offerToken, DeclineReason.BUSY_ON_PHONE)
            out += RingEffect.EmitEnded(call.callId, DeclineReason.BUSY_ON_PHONE.wire, missedIfUnheard = false)
            return out
        }
        val deadline = minOf(ring.expiresAtMs, now + RingWire.RING_MS + RingWire.CLOCK_SLACK_MS)
        state = RingState.Ringing(call, deadline)
        out += RingEffect.StartRinging(call, deadline)
        out += RingEffect.ScheduleTimer(TimerKind.RING, call.callId, deadline)
        return out
    }

    private fun onTestRing(now: Long, busy: Boolean): List<RingEffect> {
        val current = activeCall
        if (current != null) {
            return listOf(RingEffect.Dropped(if (current.test) DropReason.DUPLICATE else DropReason.BUSY_WITH_CALL))
        }
        if (busy) return listOf(RingEffect.Dropped(DropReason.BUSY_ON_PHONE))
        testSeq += 1
        val call = RingCall(callId = "$TEST_CALL_PREFIX$testSeq", offerToken = "", sessionId = "", test = true)
        val deadline = now + RingWire.RING_MS
        state = RingState.Ringing(call, deadline)
        return listOf(
            RingEffect.StartRinging(call, deadline),
            RingEffect.ScheduleTimer(TimerKind.RING, call.callId, deadline),
            RingEffect.EmitTestRing,
        )
    }

    private fun onCancel(cancel: RingPush.Cancel): List<RingEffect> {
        val s = state
        return when {
            s is RingState.Ringing && s.call.callId == cancel.callId -> end(
                s.call, cancel.reason, causeFor(cancel.reason), TimerKind.RING,
                emit = !s.call.test, missedIfUnheard = cancel.reason == "expired",
            )
            s is RingState.Answering && s.call.callId == cancel.callId ->
                // `answered`: the app accepted and bound before reportBound reached us; wait for it.
                if (cancel.reason == "answered") {
                    listOf(RingEffect.Dropped(DropReason.ALREADY_ANSWERED))
                } else {
                    end(s.call, cancel.reason, causeFor(cancel.reason), TimerKind.GRACE, emit = true, missedIfUnheard = false) +
                        RingEffect.ClearPendingAnswer
                }
            s is RingState.Answered && s.call.callId == cancel.callId -> listOf(RingEffect.Dropped(DropReason.BOUND))
            else -> {
                // Pushes can arrive out of order: remember it so its ring, arriving late, is dropped.
                remember(cancel.callId)
                listOf(RingEffect.Dropped(DropReason.OTHER_CALL))
            }
        }
    }

    private fun onOff(off: RingPush.Off): List<RingEffect> {
        val out = mutableListOf<RingEffect>(RingEffect.RingOff(off.reason))
        val s = state
        if (s is RingState.Ringing) {
            out += end(s.call, "cancelled", EndCause.CANCELED, TimerKind.RING, emit = !s.call.test, missedIfUnheard = false)
        }
        return out
    }

    // ─── Taps and Telecom ────────────────────────────────────────────────────

    private fun onAnswer(e: RingEvent.AnswerTapped): List<RingEffect> {
        val s = state
        if (s is RingState.Ringing && s.call.callId == e.callId) {
            if (s.call.test) return end(s.call, TEST_REASON, EndCause.LOCAL, TimerKind.RING, emit = false, missedIfUnheard = false)
            val answer = PendingAnswer(s.call.callId, s.call.offerToken, s.call.sessionId, e.nowMs)
            val grace = e.nowMs + RingWire.ACCEPT_GRACE_MS + RingWire.GRACE_MARGIN_MS
            state = RingState.Answering(s.call, e.nowMs, grace)
            return listOf(
                RingEffect.CancelTimer(TimerKind.RING, s.call.callId),
                RingEffect.PostAnswering(s.call.callId, s.call.offerToken),
                RingEffect.SetActive(s.call.callId, surfaceApp = e.source == AnswerSource.TELECOM),
                RingEffect.SavePendingAnswer(answer),
                RingEffect.DeliverAnswered(answer),
                RingEffect.ScheduleTimer(TimerKind.GRACE, s.call.callId, grace),
            )
        }
        val current = activeCall
        return listOf(RingEffect.Dropped(if (current?.callId == e.callId) DropReason.DUPLICATE else DropReason.STALE))
    }

    private fun onDecline(callId: String): List<RingEffect> {
        val s = state
        return when {
            s is RingState.Ringing && s.call.callId == callId ->
                if (s.call.test) {
                    end(s.call, TEST_REASON, EndCause.REJECTED, TimerKind.RING, emit = false, missedIfUnheard = false)
                } else {
                    listOf(RingEffect.PostDecline(callId, s.call.offerToken, DeclineReason.DECLINED)) +
                        end(s.call, DeclineReason.DECLINED.wire, EndCause.REJECTED, TimerKind.RING, emit = true, missedIfUnheard = false)
                }
            // N4: the token-only decline holds until accept; after accept the server refuses it
            // and Flutter's station hang-up is the way out.
            s is RingState.Answering && s.call.callId == callId ->
                listOf(RingEffect.PostDecline(callId, s.call.offerToken, DeclineReason.DECLINED)) +
                    end(s.call, DeclineReason.DECLINED.wire, EndCause.LOCAL, TimerKind.GRACE, emit = true, missedIfUnheard = false) +
                    RingEffect.ClearPendingAnswer
            // Bound: the call is Flutter's; the channel has no native hang-up event.
            s is RingState.Answered && s.call.callId == callId -> listOf(RingEffect.Dropped(DropReason.BOUND))
            else -> listOf(RingEffect.Dropped(DropReason.STALE))
        }
    }

    private fun onRefused(callId: String): List<RingEffect> {
        val s = state
        if (s !is RingState.Ringing || s.call.callId != callId) return listOf(RingEffect.Dropped(DropReason.STALE))
        if (s.call.test) return end(s.call, TEST_REASON, EndCause.BUSY, TimerKind.RING, emit = false, missedIfUnheard = false)
        return listOf(RingEffect.PostDecline(callId, s.call.offerToken, DeclineReason.BUSY_ON_PHONE)) +
            end(s.call, DeclineReason.BUSY_ON_PHONE.wire, EndCause.BUSY, TimerKind.RING, emit = true, missedIfUnheard = false)
    }

    // ─── Timers ──────────────────────────────────────────────────────────────

    private fun onRingTimeout(callId: String): List<RingEffect> {
        val s = state
        if (s !is RingState.Ringing || s.call.callId != callId) return listOf(RingEffect.Dropped(DropReason.STALE))
        return end(s.call, if (s.call.test) TEST_REASON else "expired", EndCause.MISSED, timer = null,
            emit = !s.call.test, missedIfUnheard = true)
    }

    private fun onGraceLapsed(callId: String): List<RingEffect> {
        val s = state
        if (s !is RingState.Answering || s.call.callId != callId) return listOf(RingEffect.Dropped(DropReason.STALE))
        return end(s.call, "accept_lapsed", EndCause.ERROR, timer = null, emit = true, missedIfUnheard = false) +
            RingEffect.ClearPendingAnswer
    }

    // ─── Flutter's reports ───────────────────────────────────────────────────

    private fun onBound(callId: String): List<RingEffect> {
        val s = state
        return when {
            s is RingState.Answering && s.call.callId == callId -> {
                state = RingState.Answered(s.call)
                listOf(
                    RingEffect.CancelTimer(TimerKind.GRACE, callId),
                    RingEffect.ClearPendingAnswer,
                    RingEffect.CallBound(callId),
                )
            }
            // N5: the agent opened the app by its icon while it rang; the attach answered and
            // bound before the server's ring_cancel reached us.
            s is RingState.Ringing && s.call.callId == callId && !s.call.test -> {
                state = RingState.Answered(s.call)
                listOf(
                    RingEffect.CancelTimer(TimerKind.RING, callId),
                    RingEffect.SetActive(callId, surfaceApp = false),
                    RingEffect.CallBound(callId),
                )
            }
            else -> listOf(RingEffect.Dropped(DropReason.STALE))
        }
    }

    private fun onEndedByApp(callId: String, reason: String): List<RingEffect> {
        val s = state
        val (call, timer) = when {
            s is RingState.Ringing && s.call.callId == callId -> s.call to TimerKind.RING
            s is RingState.Answering && s.call.callId == callId -> s.call to TimerKind.GRACE
            s is RingState.Answered && s.call.callId == callId -> s.call to null
            else -> {
                remember(callId)
                return listOf(RingEffect.Dropped(DropReason.STALE))
            }
        }
        val cause = when (reason) {
            "ended" -> EndCause.LOCAL
            "accept_failed" -> EndCause.ERROR
            else -> EndCause.CANCELED
        }
        return end(call, reason, cause, timer, emit = false, missedIfUnheard = false) + RingEffect.ClearPendingAnswer
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private fun end(
        call: RingCall,
        reason: String,
        cause: EndCause,
        timer: TimerKind?,
        emit: Boolean,
        missedIfUnheard: Boolean,
    ): List<RingEffect> {
        remember(call.callId)
        state = RingState.Ended(call.callId, reason)
        val out = mutableListOf<RingEffect>()
        if (timer != null) out += RingEffect.CancelTimer(timer, call.callId)
        out += RingEffect.Disconnect(call.callId, cause)
        if (emit) out += RingEffect.EmitEnded(call.callId, reason, missedIfUnheard)
        return out
    }

    private fun remember(callId: String) {
        ended.remove(callId)
        ended.add(callId)
        while (ended.size > rememberEnded) ended.remove(ended.first())
    }

    companion object {
        const val TEST_CALL_PREFIX = "test_ring:"
        const val TEST_REASON = "test"

        /** A `ring_cancel` reason as a Telecom end. */
        fun causeFor(reason: String): EndCause = when (reason) {
            "answered", "answered_elsewhere" -> EndCause.ANSWERED_ELSEWHERE
            "expired", "accept_lapsed" -> EndCause.MISSED
            "caller_left" -> EndCause.REMOTE
            "declined" -> EndCause.REJECTED
            "busy_on_phone" -> EndCause.BUSY
            else -> EndCause.CANCELED
        }
    }
}
