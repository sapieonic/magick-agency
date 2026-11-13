package com.magickagency.agent.ring

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Payloads as `packages/contracts/fixtures/agent/push.json` carries them (FCM data: strings only). */
class RingPushParserTest {
    private val ring = mapOf(
        "type" to "ring",
        "call_id" to "7d2b9e4f-6a1c-4e3d-8b5a-2f9c0e1d7a64",
        "offer_token" to "q0Vx3b9KcT1mN7zR2aW5yE",
        "ring_expires_at" to "2026-11-02T08:02:30.000Z",
        "session_id" to "6c1f0d3e-8a4b-4f7e-9d21-3b5a7c9e0f12",
    )

    @Test
    fun readsARing() {
        val p = RingPushParser.parse(ring)
        assertEquals(
            RingPush.Ring(
                callId = "7d2b9e4f-6a1c-4e3d-8b5a-2f9c0e1d7a64",
                offerToken = "q0Vx3b9KcT1mN7zR2aW5yE",
                sessionId = "6c1f0d3e-8a4b-4f7e-9d21-3b5a7c9e0f12",
                expiresAtMs = 1_793_606_550_000L,
            ),
            p,
        )
    }

    @Test
    fun aRingMissingAnyFieldIsNotOne() {
        for (key in listOf("call_id", "offer_token", "ring_expires_at", "session_id")) {
            assertNull(RingPushParser.parse(ring - key), "without $key")
            assertNull(RingPushParser.parse(ring + (key to "  ")), "with a blank $key")
        }
    }

    @Test
    fun aRingWithAnUnreadableExpiryIsNotOne() {
        assertNull(RingPushParser.parse(ring + ("ring_expires_at" to "in twenty seconds")))
    }

    @Test
    fun theOfferTokenNeverReachesToString() {
        val p = RingPushParser.parse(ring)!!
        assertFalse(p.toString().contains("q0Vx3b9KcT1mN7zR2aW5yE"))
    }

    @Test
    fun readsExpiriesWithAnOffsetOrWithoutMillis() {
        assertEquals(1_793_606_550_000L, RingPushParser.parseIsoMillis("2026-11-02T08:02:30Z"))
        assertEquals(1_793_606_550_000L, RingPushParser.parseIsoMillis("2026-11-02T13:32:30+05:30"))
        assertEquals(1_793_606_550_123L, RingPushParser.parseIsoMillis("2026-11-02T08:02:30.123Z"))
        assertNull(RingPushParser.parseIsoMillis("2026-11-02"))
    }

    @Test
    fun readsACancelWithItsReason() {
        assertEquals(
            RingPush.Cancel("7d2b9e4f-6a1c-4e3d-8b5a-2f9c0e1d7a64", "caller_left"),
            RingPushParser.parse(mapOf("type" to "ring_cancel", "call_id" to "7d2b9e4f-6a1c-4e3d-8b5a-2f9c0e1d7a64", "reason" to "caller_left")),
        )
    }

    @Test
    fun everyRingResultIsKeptOnACancel() {
        for (r in RingWire.RING_RESULTS) {
            assertEquals(RingPush.Cancel("c", r), RingPushParser.parse(mapOf("type" to "ring_cancel", "call_id" to "c", "reason" to r)))
        }
    }

    @Test
    fun aCancelWithNoOrAnUnknownReasonIsCancelled() {
        assertEquals(RingPush.Cancel("c", "cancelled"), RingPushParser.parse(mapOf("type" to "ring_cancel", "call_id" to "c")))
        assertEquals(
            RingPush.Cancel("c", "cancelled"),
            RingPushParser.parse(mapOf("type" to "ring_cancel", "call_id" to "c", "reason" to "ring_missed")),
        )
    }

    @Test
    fun aCancelNeedsItsCall() {
        assertNull(RingPushParser.parse(mapOf("type" to "ring_cancel", "reason" to "expired")))
    }

    @Test
    fun readsARingOff() {
        assertEquals(
            RingPush.Off("6c1f0d3e-8a4b-4f7e-9d21-3b5a7c9e0f12", "ring_missed"),
            RingPushParser.parse(mapOf("type" to "ring_off", "session_id" to "6c1f0d3e-8a4b-4f7e-9d21-3b5a7c9e0f12", "reason" to "ring_missed")),
        )
        for (r in RingWire.RING_OFF_REASONS) {
            assertEquals(RingPush.Off(null, r), RingPushParser.parse(mapOf("type" to "ring_off", "reason" to r)))
        }
        assertEquals(RingPush.Off(null, "left"), RingPushParser.parse(mapOf("type" to "ring_off", "reason" to "left")))
    }

    @Test
    fun aRingOffNamesTheAbsenceItEnds() {
        // The contract's fixture (`push.json` push_ring_off).
        assertEquals(
            RingPush.Off("6c1f0d3e-8a4b-4f7e-9d21-3b5a7c9e0f12", "ring_missed", java.time.Instant.parse("2026-11-02T07:58:41.120Z").toEpochMilli()),
            RingPushParser.parse(
                mapOf(
                    "type" to "ring_off", "session_id" to "6c1f0d3e-8a4b-4f7e-9d21-3b5a7c9e0f12", "reason" to "ring_missed",
                    "away_since" to "2026-11-02T07:58:41.120Z",
                ),
            ),
        )
        assertEquals(RingPush.Off(null, "max_age", null), RingPushParser.parse(mapOf("type" to "ring_off", "reason" to "max_age", "away_since" to "soon")))
    }

    @Test
    fun aRingOffWithAnUnknownReasonStillCounts() {
        assertEquals(RingPush.Off(null, null), RingPushParser.parse(mapOf("type" to "ring_off", "reason" to "something_new")))
    }

    @Test
    fun readsATestRing() {
        assertEquals(RingPush.Test, RingPushParser.parse(mapOf("type" to "test_ring")))
    }

    @Test
    fun anythingElseIsNotARingPush() {
        assertNull(RingPushParser.parse(emptyMap()))
        assertNull(RingPushParser.parse(mapOf("type" to "RING")))
        assertNull(RingPushParser.parse(mapOf("type" to "inbound_call", "call_id" to "c")))
    }

    @Test
    fun theWireListsMatchTheContract() {
        assertEquals(listOf("ring", "ring_cancel", "ring_off", "test_ring"), RingWire.PUSH_TYPES)
        assertEquals(9, RingWire.RING_RESULTS.size)
        assertTrue("answered_elsewhere" in RingWire.RING_RESULTS)
        assertEquals(20_000L, RingWire.RING_MS)
        assertEquals(15_000L, RingWire.ACCEPT_GRACE_MS)
        assertEquals(listOf("declined", "busy_on_phone"), DeclineReason.entries.map { it.wire })
    }
}
