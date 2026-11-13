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

class OwnRingTest {
    @Test
    fun aCellularCallsModeIsAlwaysAPhoneCallThatIsNotOurs() {
        assertTrue(isOthersPhoneCall(CallModeKind.CELLULAR, ownRingLive = false))
        assertTrue(isOthersPhoneCall(CallModeKind.CELLULAR, ownRingLive = true), "our ring is VoIP, never in call")
    }

    @Test
    fun theRingtoneModeIsACellularRingUnlessOurOwnRingIsLive() {
        assertTrue(isOthersPhoneCall(CallModeKind.RINGTONE, ownRingLive = false))
        assertFalse(isOthersPhoneCall(CallModeKind.RINGTONE, ownRingLive = true), "our own ring (a test ring, an inbound ring)")
    }

    @Test
    fun anyOtherModeIsNot() {
        assertFalse(isOthersPhoneCall(CallModeKind.OTHER, ownRingLive = false))
        assertFalse(isOthersPhoneCall(CallModeKind.OTHER, ownRingLive = true))
    }

    @Test
    fun audioModesAreClassifiedAsThePlatformHasThem() {
        assertEquals(CallModeKind.RINGTONE, callModeKindOf(AudioModes.RINGTONE, sdk = 28))
        assertEquals(CallModeKind.CELLULAR, callModeKindOf(AudioModes.IN_CALL, sdk = 28))
        assertEquals(CallModeKind.OTHER, callModeKindOf(3, sdk = 34), "MODE_IN_COMMUNICATION: our own VoIP")
        assertEquals(CallModeKind.OTHER, callModeKindOf(0, sdk = 34), "MODE_NORMAL")
        assertEquals(CallModeKind.OTHER, callModeKindOf(AudioModes.CALL_SCREENING, sdk = 29), "no call screening before R")
        assertEquals(CallModeKind.CELLULAR, callModeKindOf(AudioModes.CALL_SCREENING, sdk = AudioModes.SDK_R))
        assertEquals(CallModeKind.OTHER, callModeKindOf(AudioModes.CALL_REDIRECT, sdk = 32), "no call redirect before Tiramisu")
        assertEquals(CallModeKind.CELLULAR, callModeKindOf(AudioModes.CALL_REDIRECT, sdk = AudioModes.SDK_TIRAMISU))
    }
}
