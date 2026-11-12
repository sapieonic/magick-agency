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

    private fun push(p: RingPush, now: Long = t0, busy: Boolean = false) = RingEvent.Push(p, now, busy)

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
        assertEquals(listOf(RingOff("ring_missed")), m.handle(push(RingPush.Off("sess-1", "ring_missed"))))
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
                RingOff("flag_off"),
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
        assertEquals(RingState.Ringing(callB, ringB.expiresAtMs), m.state)
        assertEquals(listOf(Dropped(DropReason.LATE)), m.handle(push(ringA)), "the old one cannot come back")
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
    fun aTestRingRingsLocallyAndTellsDart() {
        val m = RingStateMachine()
        val fx = m.handle(push(RingPush.Test))
        val s = assertIs<RingState.Ringing>(m.state)
        assertTrue(s.call.test)
        assertEquals("", s.call.offerToken)
        assertEquals(
            listOf(StartRinging(s.call, t0 + RingWire.RING_MS), ScheduleTimer(TimerKind.RING, s.call.callId, t0 + RingWire.RING_MS), EmitTestRing),
            fx,
        )
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
        val m = testRinging()
        val id = m.activeCall!!.callId
        assertEquals(listOf(Disconnect(id, EndCause.MISSED)), m.handle(RingEvent.RingTimedOut(id)))
        val refused = testRinging()
        val id2 = refused.activeCall!!.callId
        assertEquals(listOf(CancelTimer(TimerKind.RING, id2), Disconnect(id2, EndCause.BUSY)), refused.handle(RingEvent.IncomingRefused(id2)))
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
}
