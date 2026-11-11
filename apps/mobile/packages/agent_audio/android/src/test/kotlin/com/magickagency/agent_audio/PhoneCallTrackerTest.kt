package com.magickagency.agent_audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneCallTrackerTest {
    @Test
    fun turningItOnReportsTheStateNow() {
        val t = PhoneCallTracker()
        assertFalse(t.running)
        assertEquals(true, t.start(active = true), "a call already ringing is reported at once")
        assertTrue(t.running)
    }

    @Test
    fun onlyChangesAreReported() {
        val t = PhoneCallTracker()
        t.start(active = false)
        assertNull(t.update(active = false), "the same state twice is not news")
        assertEquals(true, t.update(active = true))
        assertNull(t.update(active = true))
        assertEquals(false, t.update(active = false))
    }

    @Test
    fun nothingIsReportedWhileOff() {
        val t = PhoneCallTracker()
        assertNull(t.update(active = true), "never turned on")
        t.start(active = false)
        t.stop()
        assertFalse(t.running)
        assertNull(t.update(active = true), "turned off")
        assertEquals(true, t.start(active = true), "on again: the state then, whatever was seen before")
    }
}
