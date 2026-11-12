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
        assertTrue(RingCopy.ringOffText("ring_missed")!!.contains("two in a row"))
    }

    @Test
    fun theCopyIsBritishAndNamesNoCaller() {
        val all = listOf(
            RingCopy.INCOMING_TITLE, RingCopy.TEST_TITLE, RingCopy.TEST_TEXT, RingCopy.ANSWERING_TEXT, RingCopy.AWAY_TITLE,
            RingCopy.AWAY_TEXT, RingCopy.MISSED_TITLE, RingCopy.MISSED_TEXT, RingCopy.RING_OFF_TITLE, RingCopy.CHANNEL_RING_DESCRIPTION,
        ) + RingWire.RING_OFF_REASONS.mapNotNull(RingCopy::ringOffText)
        for (s in all) {
            for (us in listOf("canceled", "dialed", "color", "optimiz")) assertFalse(s.contains(us), "\"$s\" has \"$us\"")
        }
        assertEquals("Inbound call · Magick Agency", RingCopy.INCOMING_TITLE)
        assertEquals("Away · inbound calls ring this phone", RingCopy.AWAY_TITLE)
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
}
