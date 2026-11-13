package com.magickagency.agent.ring

import com.magickagency.agent.ring.RingEffect.CallBound
import com.magickagency.agent.ring.RingEffect.CancelTimer
import com.magickagency.agent.ring.RingEffect.ClearPendingAnswer
import com.magickagency.agent.ring.RingEffect.DeliverAnswered
import com.magickagency.agent.ring.RingEffect.Disconnect
import com.magickagency.agent.ring.RingEffect.Dropped
import com.magickagency.agent.ring.RingEffect.EmitEnded
import com.magickagency.agent.ring.RingEffect.EmitTestRing
import com.magickagency.agent.ring.RingEffect.PostAnswering
import com.magickagency.agent.ring.RingEffect.PostDecline
import com.magickagency.agent.ring.RingEffect.RingOff
import com.magickagency.agent.ring.RingEffect.SavePendingAnswer
import com.magickagency.agent.ring.RingEffect.ScheduleTimer
import com.magickagency.agent.ring.RingEffect.SetActive
import com.magickagency.agent.ring.RingEffect.StartRinging
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class RingStateMachineTest {
    private val t0 = 1_793_606_530_000L
    private val ringA = RingPush.Ring("call-a", "token-a", "sess-1", t0 + RingWire.RING_MS)
    private val ringB = RingPush.Ring("call-b", "token-b", "sess-1", t0 + 5_000 + RingWire.RING_MS)
    private val callA = RingCall("call-a", "token-a", "sess-1", test = false)
    private val graceA = t0 + 3_000 + RingWire.ACCEPT_GRACE_MS + RingWire.GRACE_MARGIN_MS

    private fun push(p: RingPush, now: Long = t0, busy: Boolean = false, sentAt: Long? = null) =
        RingEvent.Push(p, now, if (busy) PhoneSignals.CELLULAR_CALL else PhoneSignals.IDLE, sentAt)

    private fun ringing(): RingStateMachine = RingStateMachine().also { it.handle(push(ringA)) }

    private fun answering(source: AnswerSource = AnswerSource.NOTIFICATION): RingStateMachine =
        ringing().also { it.handle(RingEvent.AnswerTapped("call-a", t0 + 3_000, source)) }

    private fun answered(): RingStateMachine = answering().also { it.handle(RingEvent.Bound("call-a")) }

    private fun testRinging(): RingStateMachine = RingStateMachine().also { it.handle(push(RingPush.Test)) }

    private fun assertEnded(m: RingStateMachine, callId: String, reason: String) =
        assertEquals(RingState.Ended(callId, reason), m.state)

    // ─── Idle ────────────────────────────────────────────────────────────────

    @Test
    fun aRingStartsRingingUntilItsExpiry() {
        val m = RingStateMachine()
        assertEquals(RingState.Idle, m.state)
        val fx = m.handle(push(ringA))
        assertEquals(RingState.Ringing(callA, t0 + RingWire.RING_MS), m.state)
        assertEquals(
            listOf(StartRinging(callA, t0 + RingWire.RING_MS), ScheduleTimer(TimerKind.RING, "call-a", t0 + RingWire.RING_MS)),
            fx,
        )
    }

    @Test
    fun aRingFurtherAwayThanOneWindowIsCappedToTheWindow() {
        // The phone's clock runs behind the server's: never ring longer than the server offers it.
        val m = RingStateMachine()
        m.handle(push(ringA.copy(expiresAtMs = t0 + 120_000)))
        val cap = t0 + RingWire.RING_MS + RingWire.CLOCK_SLACK_MS
        assertEquals(RingState.Ringing(callA, cap), m.state)
    }

    @Test
    fun anExpiredRingIsDroppedAndRemembered() {
        val m = RingStateMachine()
        assertEquals(listOf(Dropped(DropReason.EXPIRED)), m.handle(push(ringA, now = ringA.expiresAtMs)))
        assertEquals(RingState.Idle, m.state)
        // The same ring again (a duplicate delivery) is late, whatever the clock says.
        assertEquals(listOf(Dropped(DropReason.LATE)), m.handle(push(ringA, now = t0)))
    }

    @Test
    fun onACellularCallTheRingIsDeclinedAtOnceAsBusy() {
        val m = RingStateMachine()
        val fx = m.handle(push(ringA, busy = true))
        assertEquals(
            listOf(
                PostDecline("call-a", "token-a", DeclineReason.BUSY_ON_PHONE),
                EmitEnded("call-a", "busy_on_phone", missedIfUnheard = false),
            ),
            fx,
        )
        assertEnded(m, "call-a", "busy_on_phone")
        assertEquals(listOf(Dropped(DropReason.LATE)), m.handle(push(ringA)), "and it never rings later")
    }

    @Test
    fun aCancelBeforeItsRingMakesTheRingLate() {
        // FCM does not promise order: the cancel can overtake the ring.
        val m = RingStateMachine()
        assertEquals(listOf(Dropped(DropReason.OTHER_CALL)), m.handle(push(RingPush.Cancel("call-a", "caller_left"))))
        assertEquals(RingState.Idle, m.state)
        assertEquals(listOf(Dropped(DropReason.LATE)), m.handle(push(ringA)))
    }

    @Test
    fun aRingOffWhileIdleOnlyDropsTheAwayNotification() {
        val m = RingStateMachine()
        assertEquals(listOf(RingOff("ring_missed", "sess-1")), m.handle(push(RingPush.Off("sess-1", "ring_missed"))))
        assertEquals(RingState.Idle, m.state)
    }

    @Test
    fun tapsTimersAndReportsWhileIdleChangeNothing() {
        val m = RingStateMachine()
        for (e in listOf(
            RingEvent.AnswerTapped("call-a", t0, AnswerSource.NOTIFICATION),
            RingEvent.DeclineTapped("call-a"),
            RingEvent.TelecomDisconnected("call-a"),
            RingEvent.IncomingRefused("call-a"),
            RingEvent.RingTimedOut("call-a"),
            RingEvent.GraceLapsed("call-a"),
            RingEvent.Bound("call-a"),
        )) {
            assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(e), "$e")
            assertEquals(RingState.Idle, m.state)
        }
    }

    @Test
    fun anAppEndWhileIdleRemembersTheCall() {
        val m = RingStateMachine()
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.EndedByApp("call-a", "cancelled")))
        assertEquals(listOf(Dropped(DropReason.LATE)), m.handle(push(ringA)))
    }

    // ─── Ringing ─────────────────────────────────────────────────────────────

    @Test
    fun theSameRingTwiceIsADuplicate() {
        val m = ringing()
        assertEquals(listOf(Dropped(DropReason.DUPLICATE)), m.handle(push(ringA, now = t0 + 1_000)))
        assertIs<RingState.Ringing>(m.state)
    }

    @Test
    fun answeringPostsAnsweringGoesActiveAndHandsTheCallToDart() {
        val m = ringing()
        val fx = m.handle(RingEvent.AnswerTapped("call-a", t0 + 3_000, AnswerSource.NOTIFICATION))
        val answer = PendingAnswer("call-a", "token-a", "sess-1", t0 + 3_000)
        assertEquals(
            listOf(
                CancelTimer(TimerKind.RING, "call-a"),
                PostAnswering("call-a", "token-a"),
                SetActive("call-a", surfaceApp = false),
                SavePendingAnswer(answer),
                DeliverAnswered(answer),
                ScheduleTimer(TimerKind.GRACE, "call-a", graceA),
            ),
            fx,
        )
        assertEquals(RingState.Answering(callA, t0 + 3_000, graceA), m.state)
    }

    @Test
    fun aHeadsetOrCarAnswerAlsoBringsTheAppUp() {
        val m = ringing()
        val fx = m.handle(RingEvent.AnswerTapped("call-a", t0 + 3_000, AnswerSource.TELECOM))
        assertTrue(SetActive("call-a", surfaceApp = true) in fx)
        val lock = ringing().handle(RingEvent.AnswerTapped("call-a", t0 + 3_000, AnswerSource.LOCK_SCREEN))
        assertTrue(SetActive("call-a", surfaceApp = false) in lock, "the lock-screen ring launches the app itself")
    }

    @Test
    fun anAnswerForAnotherCallIsStale() {
        val m = ringing()
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.AnswerTapped("call-z", t0, AnswerSource.NOTIFICATION)))
        assertIs<RingState.Ringing>(m.state)
    }

    @Test
    fun declineIsPostedAndEndsTheRing() {
        for (e in listOf(RingEvent.DeclineTapped("call-a"), RingEvent.TelecomDisconnected("call-a"))) {
            val m = ringing()
            assertEquals(
                listOf(
                    PostDecline("call-a", "token-a", DeclineReason.DECLINED),
                    CancelTimer(TimerKind.RING, "call-a"),
                    Disconnect("call-a", EndCause.REJECTED),
                    EmitEnded("call-a", "declined", missedIfUnheard = false),
                ),
                m.handle(e),
                "$e",
            )
            assertEnded(m, "call-a", "declined")
        }
    }

    @Test
    fun aDeclineForAnotherCallIsStale() {
        val m = ringing()
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.DeclineTapped("call-z")))
        assertIs<RingState.Ringing>(m.state)
    }

    @Test
    fun telecomRefusingTheCallDeclinesAsBusy() {
        val m = ringing()
        assertEquals(
            listOf(
                PostDecline("call-a", "token-a", DeclineReason.BUSY_ON_PHONE),
                CancelTimer(TimerKind.RING, "call-a"),
                Disconnect("call-a", EndCause.BUSY),
                EmitEnded("call-a", "busy_on_phone", missedIfUnheard = false),
            ),
            m.handle(RingEvent.IncomingRefused("call-a")),
        )
        assertEnded(m, "call-a", "busy_on_phone")
    }

    @Test
    fun theRingRunsOutAsExpiredAndIsAMissedCall() {
        val m = ringing()
        assertEquals(
            listOf(Disconnect("call-a", EndCause.MISSED), EmitEnded("call-a", "expired", missedIfUnheard = true)),
            m.handle(RingEvent.RingTimedOut("call-a")),
        )
        assertEnded(m, "call-a", "expired")
        assertEquals(listOf(Dropped(DropReason.LATE)), m.handle(push(ringA)), "a late duplicate does not ring again")
    }

    @Test
    fun aTimerForAnotherCallIsStale() {
        val m = ringing()
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.RingTimedOut("call-z")))
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.GraceLapsed("call-a")), "no grace while ringing")
        assertIs<RingState.Ringing>(m.state)
    }

    @Test
    fun aCancelEndsTheRingWithItsReason() {
        val cases = mapOf(
            "caller_left" to EndCause.REMOTE,
            "answered_elsewhere" to EndCause.ANSWERED_ELSEWHERE,
            "answered" to EndCause.ANSWERED_ELSEWHERE,
            "expired" to EndCause.MISSED,
            "push_failed" to EndCause.CANCELED,
            "cancelled" to EndCause.CANCELED,
        )
        for ((reason, cause) in cases) {
            val m = ringing()
            assertEquals(
                listOf(
                    CancelTimer(TimerKind.RING, "call-a"),
                    Disconnect("call-a", cause),
                    EmitEnded("call-a", reason, missedIfUnheard = reason == "expired"),
                ),
                m.handle(push(RingPush.Cancel("call-a", reason))),
                reason,
            )
            assertEnded(m, "call-a", reason)
        }
    }

    @Test
    fun aCancelForAnotherCallIsDropped() {
        val m = ringing()
        assertEquals(listOf(Dropped(DropReason.OTHER_CALL)), m.handle(push(RingPush.Cancel("call-z", "expired"))))
        assertIs<RingState.Ringing>(m.state)
    }

    @Test
    fun aRingOffStopsTheRing() {
        val m = ringing()
        assertEquals(
            listOf(
                RingOff("flag_off", "sess-1"),
                CancelTimer(TimerKind.RING, "call-a"),
                Disconnect("call-a", EndCause.CANCELED),
                EmitEnded("call-a", "cancelled", missedIfUnheard = false),
            ),
            m.handle(push(RingPush.Off("sess-1", "flag_off"))),
        )
        assertEnded(m, "call-a", "cancelled")
    }

    @Test
    fun aNewRingSupersedesOneWhoseCancelWasLost() {
        val m = ringing()
        val fx = m.handle(push(ringB, now = t0 + 5_000))
        val callB = RingCall("call-b", "token-b", "sess-1", test = false)
        assertEquals(
            listOf(
                CancelTimer(TimerKind.RING, "call-a"),
                Disconnect("call-a", EndCause.CANCELED),
                EmitEnded("call-a", "cancelled", missedIfUnheard = false),
                StartRinging(callB, ringB.expiresAtMs),
                ScheduleTimer(TimerKind.RING, "call-b", ringB.expiresAtMs),
            ),
            fx,
        )
        assertEquals(RingState.Ringing(callB, ringB.expiresAtMs, replacedOwn = true), m.state)
        assertEquals(listOf(Dropped(DropReason.LATE)), m.handle(push(ringA)), "the old one cannot come back")
    }

    // ─── Our own ring is not a busy phone (IQ70) ─────────────────────────────

    @Test
    fun whileOursRingsItsOwnTelecomCallAndRingtoneAreNotBusy() {
        // Telecom permits one ringing self-managed call, and our ring may set the ringtone mode.
        val ours = PhoneSignals(ringtoneMode = true, incomingNotPermitted = true)
        val m = ringing()
        val fx = m.handle(RingEvent.Push(ringB, t0 + 5_000, ours))
        assertTrue(fx.contains(StartRinging(RingCall("call-b", "token-b", "sess-1", test = false), ringB.expiresAtMs)), "$fx")
        assertFalse(fx.any { it is PostDecline }, "$fx")
        assertIs<RingState.Ringing>(m.state)
    }

    @Test
    fun aRealRingDuringATestRingIsNotBusy() {
        val m = testRinging()
        val fx = m.handle(RingEvent.Push(ringA, t0 + 1_000, PhoneSignals(ringtoneMode = true, incomingNotPermitted = true)))
        assertFalse(fx.any { it is PostDecline }, "$fx")
        assertEquals("call-a", (m.state as RingState.Ringing).call.callId)
    }

    @Test
    fun aCellularCallInProgressIsBusyEvenWhileOursRings() {
        val m = ringing()
        val fx = m.handle(RingEvent.Push(ringB, t0 + 5_000, PhoneSignals.CELLULAR_CALL))
        assertTrue(fx.contains(PostDecline("call-b", "token-b", DeclineReason.BUSY_ON_PHONE)), "$fx")
        assertEnded(m, "call-b", "busy_on_phone")
    }

    @Test
    fun withNothingOfOursRingingTheRingtoneOrTelecomsRefusalIsBusy() {
        for (signals in listOf(PhoneSignals(ringtoneMode = true), PhoneSignals(incomingNotPermitted = true))) {
            val m = RingStateMachine()
            val fx = m.handle(RingEvent.Push(ringA, t0, signals))
            assertTrue(fx.contains(PostDecline("call-a", "token-a", DeclineReason.BUSY_ON_PHONE)), "$signals: $fx")
            assertEnded(m, "call-a", "busy_on_phone")
        }
        val test = RingStateMachine()
        assertEquals(listOf(Dropped(DropReason.BUSY_ON_PHONE)), test.handle(RingEvent.Push(RingPush.Test, t0, PhoneSignals(ringtoneMode = true))))
    }

    @Test
    fun telecomRefusingARingThatReplacedOursRingsItByNotification() {
        // Our previous call may still hold Telecom's one ringing self-managed call.
        val m = ringing()
        m.handle(push(ringB, now = t0 + 5_000))
        val callB = RingCall("call-b", "token-b", "sess-1", test = false)
        assertEquals(listOf(RingEffect.RingByNotification(callB, ringB.expiresAtMs)), m.handle(RingEvent.IncomingRefused("call-b")))
        assertIs<RingState.Ringing>(m.state)
    }

    // ─── Expiry on the server's clock (the offset Dart measured, else the send time) ─

    private fun pushAt(p: RingPush, now: Long, sentAt: Long?, offset: Long?) =
        RingEvent.Push(p, now, PhoneSignals.IDLE, sentAt, offset)

    @Test
    fun aFreshOffsetRingsOnlyForWhatTheServerStillOffersAPushDeliveredLate() {
        // The phone reads 7 s behind the server; the push spent 12 s in delivery.
        val offset = 7_000L
        val now = t0 + 12_000 - offset
        assertEquals(8_000L, RingTiming.remainingMs(ringA.expiresAtMs, t0, now, offset))
        val m = RingStateMachine()
        m.handle(pushAt(ringA, now, sentAt = t0, offset = offset))
        assertEquals(RingState.Ringing(callA, now + 8_000), m.state)
        // Delivered after the server's expiry: dropped, not rung, whatever the phone's clock says.
        assertEquals(listOf(Dropped(DropReason.EXPIRED)), RingStateMachine().handle(pushAt(ringA, t0 + 21_000 - offset, t0, offset)))
        // No send time: the offset alone.
        assertEquals(8_000L, RingTiming.remainingMs(ringA.expiresAtMs, null, now, offset))
    }

    @Test
    fun aFreshOffsetIsNeverReadAsBeforeThePushWasSent() {
        // An offset that puts the server's present before the send time (the phone's clock set back
        // since it was measured): the send time is the earliest the present can be.
        assertEquals(RingWire.RING_MS, RingTiming.remainingMs(ringA.expiresAtMs, t0, t0 - 30_000, 0L))
    }

    @Test
    fun aPhoneClockRunningFastWithNoOffsetLosesAtMostTheCapAndIsNeverDropped() {
        // Fast by 19.5 s, 21 s, a minute, an hour: the ring rings for at least the window less the cap.
        for (fast in listOf(500L, 3_000L, 19_500L, 21_000L, 22_001L, 60_000L, 3_600_000L)) {
            val left = RingTiming.remainingMs(ringA.expiresAtMs, t0, t0 + fast)
            assertTrue(left >= RingWire.RING_MS - RingWire.DELIVERY_CAP_MS, "fast by $fast: $left")
            assertTrue(left >= 17_000L, "fast by $fast: $left")
        }
        val m = RingStateMachine()
        val now = t0 + 60_000
        val fx = m.handle(push(ringA, now = now, sentAt = t0))
        val until = now + RingWire.RING_MS - RingWire.DELIVERY_CAP_MS
        assertEquals(RingState.Ringing(callA, until), m.state)
        assertEquals(listOf(StartRinging(callA, until), ScheduleTimer(TimerKind.RING, "call-a", until)), fx)
    }

    @Test
    fun aPhoneClockRunningSlowTakesNothingOff() {
        assertEquals(RingWire.RING_MS, RingTiming.remainingMs(ringA.expiresAtMs, t0, t0 - 5_000))
        val m = RingStateMachine()
        val now = t0 - 60_000
        m.handle(push(ringA, now = now, sentAt = t0 + 5_000))
        assertEquals(RingState.Ringing(callA, now + RingWire.RING_MS - 5_000), m.state, "what the server left at send")
    }

    @Test
    fun theTimeLeftHasNoJumpAcrossWhatWasOnceABoundary() {
        // Without an offset, step the phone's clock 1 ms at a time across 0..30 s after the send:
        // no step moves the time left by more than 1 ms (the old rule jumped at 22 s).
        var previous = RingTiming.remainingMs(ringA.expiresAtMs, t0, t0 - 1)
        for (d in 0L..30_000L) {
            val left = RingTiming.remainingMs(ringA.expiresAtMs, t0, t0 + d)
            assertTrue(kotlin.math.abs(left - previous) <= 1, "at ${d} ms: $previous -> $left")
            previous = left
        }
        // With an offset, the same across the window's end.
        previous = RingTiming.remainingMs(ringA.expiresAtMs, t0, t0, 0L)
        for (d in 0L..30_000L) {
            val left = RingTiming.remainingMs(ringA.expiresAtMs, t0, t0 + d, 0L)
            assertTrue(kotlin.math.abs(left - previous) <= 1, "offset, at ${d} ms: $previous -> $left")
            previous = left
        }
    }

    @Test
    fun aRingSentAfterItsExpiryIsDroppedWhateverThePhoneClockSays() {
        val m = RingStateMachine()
        assertEquals(listOf(Dropped(DropReason.EXPIRED)), m.handle(push(ringA, now = t0 - 60_000, sentAt = ringA.expiresAtMs)))
        assertEquals(RingState.Idle, m.state)
    }

    @Test
    fun theTimeLeftIsCappedToOneWindowWithItsSlack() {
        assertEquals(RingTiming.MAX_MS, RingTiming.remainingMs(t0 + 600_000, t0, t0 + 99_000))
        assertEquals(RingTiming.MAX_MS, RingTiming.remainingMs(t0 + 600_000, t0, t0, 0L))
        assertEquals(7_000L - RingWire.DELIVERY_CAP_MS, RingTiming.remainingMs(t0 + 7_000, t0, t0 + 99_000), "the send time, less the cap")
        assertEquals(7_000L, RingTiming.remainingMs(t0 + 7_000, null, t0), "no send time: the phone's clock")
        assertEquals(7_000L, RingTiming.remainingMs(t0 + 7_000, 0, t0), "FCM's 0 is no send time")
    }

    @Test
    fun withNoOffsetADelayUnderTheCapIsTakenOffInFull() {
        assertEquals(RingWire.RING_MS - 1_200, RingTiming.remainingMs(ringA.expiresAtMs, t0, t0 + 1_200))
        val m = RingStateMachine()
        m.handle(push(ringA, now = t0 + 15_000, sentAt = t0))
        assertEquals(RingState.Ringing(callA, t0 + 15_000 + RingWire.RING_MS - RingWire.DELIVERY_CAP_MS), m.state)
    }

    @Test
    fun aServerClockOffsetIsFreshForADay() {
        val c = ServerClockOffset(offsetMs = 4_000, measuredAtMs = t0)
        assertTrue(c.isFresh(t0))
        assertTrue(c.isFresh(t0 + RingWire.SERVER_CLOCK_MAX_AGE_MS))
        assertFalse(c.isFresh(t0 + RingWire.SERVER_CLOCK_MAX_AGE_MS + 1))
        assertFalse(c.isFresh(t0 - 1), "measured in this phone's future: its clock was set back")
    }

    @Test
    fun aTestRingWhileARealOneRingsIsDropped() {
        val m = ringing()
        assertEquals(listOf(Dropped(DropReason.BUSY_WITH_CALL)), m.handle(push(RingPush.Test)))
        assertIs<RingState.Ringing>(m.state)
    }

    @Test
    fun reportBoundWhileRingingIsTheAppOpenedByItsIcon() {
        // N5: the agent opened the app while it rang; the attach answered and bound.
        val m = ringing()
        assertEquals(
            listOf(CancelTimer(TimerKind.RING, "call-a"), SetActive("call-a", surfaceApp = false), CallBound("call-a")),
            m.handle(RingEvent.Bound("call-a")),
        )
        assertEquals(RingState.Answered(callA), m.state)
        assertEquals(listOf(Dropped(DropReason.BOUND)), m.handle(push(RingPush.Cancel("call-a", "answered"))))
    }

    @Test
    fun reportEndedWhileRingingStopsIt() {
        val m = ringing()
        assertEquals(
            listOf(CancelTimer(TimerKind.RING, "call-a"), Disconnect("call-a", EndCause.CANCELED), ClearPendingAnswer),
            m.handle(RingEvent.EndedByApp("call-a", "cancelled")),
        )
        assertEnded(m, "call-a", "cancelled")
    }

    // ─── Answering ───────────────────────────────────────────────────────────

    @Test
    fun aSecondAnswerIsADuplicate() {
        val m = answering()
        assertEquals(listOf(Dropped(DropReason.DUPLICATE)), m.handle(RingEvent.AnswerTapped("call-a", t0 + 4_000, AnswerSource.TELECOM)))
        assertIs<RingState.Answering>(m.state)
    }

    @Test
    fun reportBoundStopsTheGrace() {
        val m = answering()
        assertEquals(
            listOf(CancelTimer(TimerKind.GRACE, "call-a"), ClearPendingAnswer, CallBound("call-a")),
            m.handle(RingEvent.Bound("call-a")),
        )
        assertEquals(RingState.Answered(callA), m.state)
    }

    @Test
    fun theGraceLapsingEndsTheCallAsAcceptLapsed() {
        val m = answering()
        assertEquals(
            listOf(Disconnect("call-a", EndCause.ERROR), EmitEnded("call-a", "accept_lapsed", missedIfUnheard = false), ClearPendingAnswer),
            m.handle(RingEvent.GraceLapsed("call-a")),
        )
        assertEnded(m, "call-a", "accept_lapsed")
    }

    @Test
    fun theRingTimerAfterAnAnswerIsStale() {
        val m = answering()
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.RingTimedOut("call-a")))
        assertIs<RingState.Answering>(m.state)
    }

    @Test
    fun aDeclineAfterAnswerIsStillPostedUntilAccept() {
        // N4: the token-only decline holds until accept; the server refuses it after.
        for (e in listOf(RingEvent.DeclineTapped("call-a"), RingEvent.TelecomDisconnected("call-a"))) {
            val m = answering()
            assertEquals(
                listOf(
                    PostDecline("call-a", "token-a", DeclineReason.DECLINED),
                    CancelTimer(TimerKind.GRACE, "call-a"),
                    Disconnect("call-a", EndCause.LOCAL),
                    EmitEnded("call-a", "declined", missedIfUnheard = false),
                    ClearPendingAnswer,
                ),
                m.handle(e),
                "$e",
            )
            assertEnded(m, "call-a", "declined")
        }
    }

    @Test
    fun aCancelWhileAnsweringEndsIt() {
        val m = answering()
        assertEquals(
            listOf(
                CancelTimer(TimerKind.GRACE, "call-a"),
                Disconnect("call-a", EndCause.REMOTE),
                EmitEnded("call-a", "caller_left", missedIfUnheard = false),
                ClearPendingAnswer,
            ),
            m.handle(push(RingPush.Cancel("call-a", "caller_left"))),
        )
        assertEnded(m, "call-a", "caller_left")
    }

    @Test
    fun anAnsweredCancelWhileAnsweringWaitsForReportBound() {
        val m = answering()
        assertEquals(listOf(Dropped(DropReason.ALREADY_ANSWERED)), m.handle(push(RingPush.Cancel("call-a", "answered"))))
        assertIs<RingState.Answering>(m.state)
    }

    @Test
    fun aRingOffWhileAnsweringLeavesTheCall() {
        val m = answering()
        assertEquals(listOf(RingOff("ring_missed")), m.handle(push(RingPush.Off(null, "ring_missed"))))
        assertIs<RingState.Answering>(m.state)
    }

    @Test
    fun aNewRingWhileAnsweringIsDeclinedAsBusy() {
        val m = answering()
        assertEquals(
            listOf(PostDecline("call-b", "token-b", DeclineReason.BUSY_ON_PHONE), Dropped(DropReason.BUSY_WITH_CALL)),
            m.handle(push(ringB, now = t0 + 5_000)),
        )
        assertIs<RingState.Answering>(m.state)
        assertEquals(listOf(Dropped(DropReason.LATE)), m.handle(push(ringB, now = t0 + 6_000)))
    }

    @Test
    fun telecomRefusalAfterAnswerIsStale() {
        val m = answering()
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.IncomingRefused("call-a")))
    }

    @Test
    fun acceptFailingEndsTheCall() {
        val m = answering()
        assertEquals(
            listOf(CancelTimer(TimerKind.GRACE, "call-a"), Disconnect("call-a", EndCause.ERROR), ClearPendingAnswer),
            m.handle(RingEvent.EndedByApp("call-a", "accept_failed")),
        )
        assertEnded(m, "call-a", "accept_failed")
    }

    // ─── Answered ────────────────────────────────────────────────────────────

    @Test
    fun onceBoundTheCallIsFlutters() {
        val m = answered()
        for (e in listOf(RingEvent.DeclineTapped("call-a"), RingEvent.TelecomDisconnected("call-a"))) {
            assertEquals(listOf(Dropped(DropReason.BOUND)), m.handle(e), "$e")
        }
        assertEquals(listOf(Dropped(DropReason.BOUND)), m.handle(push(RingPush.Cancel("call-a", "caller_left"))))
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.GraceLapsed("call-a")))
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.Bound("call-a")))
        assertEquals(listOf(Dropped(DropReason.DUPLICATE)), m.handle(RingEvent.AnswerTapped("call-a", t0, AnswerSource.TELECOM)))
        assertEquals(listOf(RingOff(null)), m.handle(push(RingPush.Off(null, null))))
        assertEquals(RingState.Answered(callA), m.state)
    }

    @Test
    fun reportEndedEndsTheBoundCall() {
        val m = answered()
        assertEquals(
            listOf(Disconnect("call-a", EndCause.LOCAL), ClearPendingAnswer),
            m.handle(RingEvent.EndedByApp("call-a", "ended")),
        )
        assertEnded(m, "call-a", "ended")
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.EndedByApp("call-a", "ended")), "twice is harmless")
    }

    @Test
    fun aRingWhileOnACallIsDeclinedAsBusy() {
        val m = answered()
        assertEquals(
            listOf(PostDecline("call-b", "token-b", DeclineReason.BUSY_ON_PHONE), Dropped(DropReason.BUSY_WITH_CALL)),
            m.handle(push(ringB, now = t0 + 5_000)),
        )
        assertEquals(RingState.Answered(callA), m.state)
    }

    @Test
    fun aTestRingWhileOnACallIsDropped() {
        assertEquals(listOf(Dropped(DropReason.BUSY_WITH_CALL)), answered().handle(push(RingPush.Test)))
    }

    // ─── Ended ───────────────────────────────────────────────────────────────

    @Test
    fun afterAnEndTheNextCallRings() {
        val m = ringing()
        m.handle(RingEvent.DeclineTapped("call-a"))
        val fx = m.handle(push(ringB, now = t0 + 5_000))
        assertIs<StartRinging>(fx[0])
        assertEquals("call-b", m.activeCall?.callId)
    }

    @Test
    fun anEndedCallIgnoresItsOwnTimersAndTaps() {
        val m = ringing()
        m.handle(RingEvent.DeclineTapped("call-a"))
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.RingTimedOut("call-a")))
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.AnswerTapped("call-a", t0, AnswerSource.NOTIFICATION)))
        assertEquals(listOf(Dropped(DropReason.OTHER_CALL)), m.handle(push(RingPush.Cancel("call-a", "declined"))))
        assertEnded(m, "call-a", "declined")
    }

    @Test
    fun onlyTheLatestCallsAreRemembered() {
        val m = RingStateMachine(rememberEnded = 2)
        m.handle(push(RingPush.Cancel("old", "cancelled")))
        m.handle(push(RingPush.Cancel("x", "cancelled")))
        m.handle(push(RingPush.Cancel("y", "cancelled")))
        val fx = m.handle(push(ringA.copy(callId = "old")))
        assertIs<StartRinging>(fx[0], "forgotten: it rings")
        assertEquals(listOf(Dropped(DropReason.LATE)), m.handle(push(ringA.copy(callId = "y"))))
    }

    // ─── Test ring ───────────────────────────────────────────────────────────

    @Test
    fun aTestRingRingsLocallyAndTellsDartOnceItsNotificationIsUp() {
        val m = RingStateMachine()
        val fx = m.handle(push(RingPush.Test))
        val s = assertIs<RingState.Ringing>(m.state)
        assertTrue(s.call.test)
        assertEquals("", s.call.offerToken)
        assertEquals(
            listOf(StartRinging(s.call, t0 + RingWire.RING_MS), ScheduleTimer(TimerKind.RING, s.call.callId, t0 + RingWire.RING_MS)),
            fx,
            "not on arrival: only a ring the agent could see is a success",
        )
        assertEquals(listOf(EmitTestRing(shown = true)), m.handle(RingEvent.IncomingShown(s.call.callId, posted = true)))
        assertEquals(emptyList(), m.handle(RingEvent.IncomingShown(s.call.callId, posted = true)), "once")
    }

    @Test
    fun aTestRingWhoseNotificationCouldNotBePostedSaysSo() {
        val m = RingStateMachine()
        m.handle(push(RingPush.Test))
        val id = m.activeCall!!.callId
        assertEquals(listOf(EmitTestRing(shown = false)), m.handle(RingEvent.IncomingShown(id, posted = false)))
        // Never up at all, and rung out: told it could not be shown.
        val m2 = RingStateMachine()
        m2.handle(push(RingPush.Test))
        val id2 = m2.activeCall!!.callId
        assertEquals(EmitTestRing(shown = false), m2.handle(RingEvent.RingTimedOut(id2)).first())
        // A real ring's notification tells Dart nothing.
        val m3 = ringing()
        assertEquals(emptyList(), m3.handle(RingEvent.IncomingShown("call-a", posted = true)))
    }

    @Test
    fun aTestRingOnACellularCallIsDropped() {
        val m = RingStateMachine()
        assertEquals(listOf(Dropped(DropReason.BUSY_ON_PHONE)), m.handle(push(RingPush.Test, busy = true)))
        assertEquals(RingState.Idle, m.state)
    }

    @Test
    fun aSecondTestRingIsADuplicate() {
        val m = testRinging()
        assertEquals(listOf(Dropped(DropReason.DUPLICATE)), m.handle(push(RingPush.Test)))
    }

    @Test
    fun answeringOrDecliningATestRingOnlyDismissesIt() {
        for (answer in listOf(true, false)) {
            val m = testRinging()
            val id = m.activeCall!!.callId
            val e = if (answer) RingEvent.AnswerTapped(id, t0 + 1_000, AnswerSource.NOTIFICATION) else RingEvent.DeclineTapped(id)
            val fx = m.handle(e)
            assertEquals(
                listOf(CancelTimer(TimerKind.RING, id), Disconnect(id, if (answer) EndCause.LOCAL else EndCause.REJECTED)),
                fx,
            )
            assertFalse(fx.any { it is PostAnswering || it is PostDecline || it is EmitEnded || it is DeliverAnswered })
            assertEnded(m, id, RingStateMachine.TEST_REASON)
        }
    }

    @Test
    fun aTestRingRunningOutIsQuiet() {
        // Shown, then rung out: no miss, no second word to Dart.
        val m = testRinging()
        val id = m.activeCall!!.callId
        m.handle(RingEvent.IncomingShown(id, posted = true))
        assertEquals(listOf(Disconnect(id, EndCause.MISSED)), m.handle(RingEvent.RingTimedOut(id)))
        // Refused by Telecom before it was ever shown: Dart hears it could not be shown.
        val refused = testRinging()
        val id2 = refused.activeCall!!.callId
        assertEquals(
            listOf(EmitTestRing(shown = false), CancelTimer(TimerKind.RING, id2), Disconnect(id2, EndCause.BUSY)),
            refused.handle(RingEvent.IncomingRefused(id2)),
        )
    }

    @Test
    fun eachTestRingHasItsOwnIdSoAnOldTimerCannotEndANewOne() {
        val m = testRinging()
        val first = m.activeCall!!.callId
        m.handle(RingEvent.DeclineTapped(first))
        m.handle(push(RingPush.Test, now = t0 + 30_000))
        val second = m.activeCall!!.callId
        assertTrue(first != second)
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.RingTimedOut(first)))
        assertIs<RingState.Ringing>(m.state)
    }

    @Test
    fun aRealRingReplacesATestRingQuietly() {
        val m = testRinging()
        val id = m.activeCall!!.callId
        val fx = m.handle(push(ringA, now = t0 + 1_000))
        assertEquals(listOf(CancelTimer(TimerKind.RING, id), Disconnect(id, EndCause.CANCELED)), fx.take(2))
        assertFalse(fx.any { it is EmitEnded })
        assertEquals("call-a", m.activeCall?.callId)
    }

    @Test
    fun aRingOffEndsATestRingQuietly() {
        val m = testRinging()
        val id = m.activeCall!!.callId
        assertEquals(
            listOf(RingOff("opted_out"), CancelTimer(TimerKind.RING, id), Disconnect(id, EndCause.CANCELED)),
            m.handle(push(RingPush.Off(null, "opted_out"))),
        )
    }

    @Test
    fun aTestRingCannotBeBoundFromDart() {
        val m = testRinging()
        assertEquals(listOf(Dropped(DropReason.STALE)), m.handle(RingEvent.Bound(m.activeCall!!.callId)))
    }

    // ─── Pending answer ──────────────────────────────────────────────────────

    @Test
    fun aPendingAnswerIsFreshOnlyWithinTheGrace() {
        val a = PendingAnswer("call-a", "token-a", "sess-1", t0)
        assertTrue(a.isFresh(t0))
        assertTrue(a.isFresh(t0 + RingWire.ACCEPT_GRACE_MS + RingWire.GRACE_MARGIN_MS - 1))
        assertFalse(a.isFresh(t0 + RingWire.ACCEPT_GRACE_MS + RingWire.GRACE_MARGIN_MS))
        assertFalse(a.isFresh(t0 - 1), "a clock set back is not trusted")
        assertEquals(mapOf("call_id" to "call-a", "offer_token" to "token-a", "session_id" to "sess-1"), a.toChannelMap())
        assertFalse(a.toString().contains("token-a"))
    }

    @Test
    fun effectsNeverPrintTheToken() {
        val fx = ringing().handle(RingEvent.AnswerTapped("call-a", t0, AnswerSource.NOTIFICATION)) +
            ringing().handle(RingEvent.DeclineTapped("call-a"))
        for (e in fx) assertFalse(e.toString().contains("token-a"), "$e")
    }

    // ─── A ring_off for the absence the phone shows, not an earlier one ─────

    private val absenceA = t0 - 3_600_000
    private val absenceB = t0 - 60_000

    private fun awayFor(since: Long, session: String = "sess-1"): RingStateMachine =
        RingStateMachine().also { it.handle(RingEvent.AwayChanged(AwayAbsence(session, since))) }

    @Test
    fun aRingOffDelayedPastItsAbsenceDoesNotEndTheNextOne() {
        val m = awayFor(absenceB)
        m.handle(push(ringA))
        assertEquals(
            listOf(Dropped(DropReason.STALE_RING_OFF)),
            m.handle(push(RingPush.Off("sess-1", "ring_missed", absenceA), sentAt = absenceA + 1_000)),
        )
        assertIs<RingState.Ringing>(m.state, "the ring of the absence shown rings on")
        assertEquals(AwayAbsence("sess-1", absenceB), m.away, "and its notification stays")
    }

    @Test
    fun aRingOffForTheShownAbsenceEndsIt() {
        val m = awayFor(absenceB)
        val fx = m.handle(push(RingPush.Off("sess-1", "ring_missed", absenceB - 1_500)))
        assertEquals(listOf(RingOff("ring_missed", "sess-1", absenceB - 1_500)), fx, "inside the 2 s tolerance")
        assertEquals(false, m.away?.shown)
        // A second (a duplicate delivery): the absence is over.
        assertEquals(listOf(Dropped(DropReason.STALE_RING_OFF)), m.handle(push(RingPush.Off("sess-1", "ring_missed", absenceB))))
    }

    @Test
    fun aRingOffAfterTheAgentCameBackIsDropped() {
        val m = awayFor(absenceB)
        m.handle(RingEvent.AwayChanged(null))
        assertEquals(AwayAbsence("sess-1", absenceB, shown = false), m.away, "kept as the latest absence")
        assertEquals(listOf(Dropped(DropReason.STALE_RING_OFF)), m.handle(push(RingPush.Off("sess-1", "flag_off", absenceB))))
    }

    @Test
    fun anotherSessionsRingOffIsDropped() {
        assertEquals(
            listOf(Dropped(DropReason.STALE_RING_OFF)),
            awayFor(absenceB).handle(push(RingPush.Off("sess-0", "taken_over", absenceB))),
        )
    }

    @Test
    fun withoutAwaySinceTheSendTimeDecides() {
        // An older server: sent during the shown absence, it can only end that one.
        assertEquals(listOf(RingOff("ring_missed", "sess-1", null)), awayFor(absenceB).handle(push(RingPush.Off("sess-1", "ring_missed"), sentAt = absenceB + 30_000)))
        // Sent before the shown absence began: an earlier absence's.
        assertEquals(
            listOf(Dropped(DropReason.STALE_RING_OFF)),
            awayFor(absenceB).handle(push(RingPush.Off("sess-1", "ring_missed"), sentAt = absenceB - 10_000)),
        )
        // No send time either: taken, as before the rule.
        assertEquals(listOf(RingOff("ring_missed", "sess-1", null)), awayFor(absenceB).handle(push(RingPush.Off("sess-1", "ring_missed"))))
    }

    @Test
    fun aPhoneThatKnowsOfNoAbsenceTakesARingOff() {
        assertTrue(RingStateMachine.acceptsRingOff(null, RingPush.Off(null, "ring_missed", absenceA), null))
        val restored = RingStateMachine().also { it.restoreAway(AwayAbsence("sess-1", absenceB)) }
        assertEquals(listOf(Dropped(DropReason.STALE_RING_OFF)), restored.handle(push(RingPush.Off("sess-1", "ring_missed", absenceA))), "a process start keeps the absence")
    }

    // ─── "Stop ringing" (this absence only) ──────────────────────────────────

    @Test
    fun stopRingingDeclinesTheRingRingingNow() {
        val m = ringing()
        assertEquals(
            listOf(
                PostDecline("call-a", "token-a", DeclineReason.DECLINED),
                CancelTimer(TimerKind.RING, "call-a"),
                Disconnect("call-a", EndCause.REJECTED),
                EmitEnded("call-a", "declined", missedIfUnheard = false),
            ),
            m.handle(RingEvent.StopRingingTapped(t0 + 2_000)),
            "the app opening must not answer it by attaching (N5)",
        )
        assertEnded(m, "call-a", "declined")
    }

    @Test
    fun aRingArrivingJustAfterStopRingingIsDeclinedNotRung() {
        val m = RingStateMachine()
        assertEquals(emptyList(), m.handle(RingEvent.StopRingingTapped(t0)))
        assertEquals(
            listOf(PostDecline("call-b", "token-b", DeclineReason.DECLINED), EmitEnded("call-b", "declined", missedIfUnheard = false)),
            m.handle(push(ringB, now = t0 + 3_000)),
        )
        // Past the hold, rings ring again (the agent may be away_ring again by then).
        val later = RingPush.Ring("call-c", "token-c", "sess-1", t0 + RingWire.STOP_RINGING_HOLD_MS + RingWire.RING_MS)
        assertIs<StartRinging>(m.handle(push(later, now = t0 + RingWire.STOP_RINGING_HOLD_MS))[0])
    }

    @Test
    fun theDeclineWindowSurvivesAProcessStart() {
        val before = RingStateMachine()
        before.handle(RingEvent.StopRingingTapped(t0))
        assertEquals(t0 + RingWire.STOP_RINGING_HOLD_MS, before.declineUntilMs)
        // A new process 5 s later restores what the store kept, and still declines.
        val after = RingStateMachine().also { it.restoreDeclineUntil(before.declineUntilMs, t0 + 5_000) }
        assertEquals(
            listOf(PostDecline("call-b", "token-b", DeclineReason.DECLINED), EmitEnded("call-b", "declined", missedIfUnheard = false)),
            after.handle(push(ringB, now = t0 + 6_000)),
        )
    }

    @Test
    fun aRestoredDeclineWindowIsTakenOnlyWhileItHasAtMostOneWindowLeft() {
        val lapsed = RingStateMachine().also { it.restoreDeclineUntil(t0 + 1_000, t0 + 1_000) }
        assertIs<StartRinging>(lapsed.handle(push(ringB, now = t0 + 5_000))[0], "the window is over")
        // The phone's clock set back since: a window reaching further than one ring is not kept.
        val skewed = RingStateMachine().also { it.restoreDeclineUntil(t0 + RingWire.STOP_RINGING_HOLD_MS + 1, t0) }
        assertEquals(0L, skewed.declineUntilMs)
        assertIs<StartRinging>(skewed.handle(push(ringA))[0])
    }

    @Test
    fun aStopRingingTapIsKeptForOneRingWindowPlusTheGrace() {
        val stop = StopRingingRecord("sess-1", tappedAtMs = t0)
        assertEquals(35_000L, RingWire.STOP_RINGING_KEEP_MS)
        assertTrue(stop.isFresh(t0))
        assertTrue(stop.isFresh(t0 + 35_000))
        assertFalse(stop.isFresh(t0 + 35_001), "older: dropped unread, so it never pauses a later absence")
        assertFalse(stop.isFresh(t0 - 1))
        assertFalse(StopRingingRecord(null, tappedAtMs = 0).isFresh(t0), "a record with no tap time")
    }

    @Test
    fun stopRingingNeverDeclinesACallTheAgentAnswered() {
        val m = answering()
        assertEquals(emptyList(), m.handle(RingEvent.StopRingingTapped(t0 + 4_000)))
        assertIs<RingState.Answering>(m.state)
    }
}
