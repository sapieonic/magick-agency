package com.magickagency.agent.ring

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RingCopyTest {
    @Test
    fun everyRingOffReasonButOptingOutIsExplained() {
        for (r in RingWire.RING_OFF_REASONS) {
            if (r == "opted_out") assertNull(RingCopy.ringOffText(r)) else assertNotNull(RingCopy.ringOffText(r), r)
        }
        assertNotNull(RingCopy.ringOffText(null), "an unknown reason still says something")
        assertEquals("You missed two inbound calls. Open the app to turn it back on.", RingCopy.ringOffText("ring_missed"))
        assertTrue(RingCopy.ringOffText("max_age")!!.contains("4 hours"), "the limit is stated")
    }

    @Test
    fun theCopyIsBritishAndNamesNoCaller() {
        val all = listOf(
            RingCopy.INCOMING_TITLE, RingCopy.TEST_TITLE, RingCopy.TEST_TEXT, RingCopy.ANSWERING_TEXT, RingCopy.AWAY_TITLE,
            RingCopy.AWAY_TEXT, RingCopy.MISSED_TITLE, RingCopy.MISSED_TEXT, RingCopy.RING_OFF_TITLE, RingCopy.CHANNEL_RING_DESCRIPTION,
            RingCopy.CHANNEL_RING_QUIET, RingCopy.CHANNEL_RING_QUIET_DESCRIPTION, RingCopy.HANG_UP,
        ) + RingWire.RING_OFF_REASONS.mapNotNull(RingCopy::ringOffText)
        for (s in all) {
            for (us in listOf("canceled", "dialed", "color", "optimiz")) assertFalse(s.contains(us), "\"$s\" has \"$us\"")
        }
        assertEquals("Inbound call · Magick Agency", RingCopy.INCOMING_TITLE)
        assertEquals("Away · this phone rings for inbound calls", RingCopy.AWAY_TITLE)
        assertEquals("You didn’t answer an inbound call. It went back to the queue.", RingCopy.MISSED_TEXT)
        assertEquals("Missed inbound call", RingCopy.MISSED_TITLE)
    }

    @Test
    fun theChecklistHasTheChannelsKeys() {
        val c = RingChecklist(true, false, true, false, true, false)
        assertEquals(RingChecklist.ITEMS, c.toChannelMap().keys.toList())
        assertEquals(
            mapOf(
                "notifications" to true, "full_screen" to false, "battery_exempt" to true,
                "microphone" to false, "phone_account" to true, "dnd_allows_calls" to false,
            ),
            c.toChannelMap(),
        )
    }

    @Test
    fun doNotDisturbLetsACallThroughOnlyWhenCallsFromAnyoneMay() {
        assertTrue(RingRules.dndAllowsCalls(DndFilter.ALL, priorityCallsFromAnyone = false, channelBypassesDnd = false))
        assertTrue(RingRules.dndAllowsCalls(DndFilter.UNKNOWN, priorityCallsFromAnyone = false, channelBypassesDnd = false))
        assertTrue(RingRules.dndAllowsCalls(DndFilter.PRIORITY, priorityCallsFromAnyone = true, channelBypassesDnd = false))
        assertTrue(RingRules.dndAllowsCalls(DndFilter.PRIORITY, priorityCallsFromAnyone = false, channelBypassesDnd = true))
        assertFalse(RingRules.dndAllowsCalls(DndFilter.PRIORITY, priorityCallsFromAnyone = false, channelBypassesDnd = false))
        for (f in listOf(DndFilter.ALARMS, DndFilter.NONE)) {
            assertFalse(RingRules.dndAllowsCalls(f, priorityCallsFromAnyone = true, channelBypassesDnd = true), "$f")
        }
    }

    @Test
    fun theLockScreenRingsButtonsMeetWcagAa() {
        val white = RingScreenColours.TEXT
        assertTrue(RingContrast.ratio(white, RingScreenColours.ANSWER) >= 4.5, "Answer ${RingContrast.ratio(white, RingScreenColours.ANSWER)}")
        assertTrue(RingContrast.ratio(white, RingScreenColours.DECLINE) >= 4.5, "Decline ${RingContrast.ratio(white, RingScreenColours.DECLINE)}")
        assertTrue(RingContrast.ratio(white, RingScreenColours.BACKGROUND) >= 4.5)
        // The old green, for the record: below AA.
        assertTrue(RingContrast.ratio(white, 0x16A34A) < 4.5)
        assertEquals(21.0, RingContrast.ratio(0x000000, 0xFFFFFF), 0.001)
    }

    @Test
    fun theLockScreenRingSaysWhatToDo() {
        assertEquals("Inbound call. Double-tap Answer.", RingCopy.RING_SCREEN_A11Y)
        assertTrue(RingCopy.ANSWER_A11Y.contains("Answer"))
        assertTrue(RingCopy.DECLINE_A11Y.contains("Decline"))
    }
}
