package com.magickagency.agent_audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FocusRecoveryTest {
    @Test
    fun permanentLossDuringACallIsAskedAgainWithBackoff() {
        val r = FocusRecovery()
        // Android sends no GAIN after a permanent loss: the session must ask again itself,
        // backing off so it does not fight another app every second.
        assertEquals(listOf(1_000L, 2_000L, 5_000L, 10_000L, 10_000L, 10_000L), List(6) { r.notHeld(engineRunning = true) })
    }

    @Test
    fun nothingIsScheduledWithoutACallEngine() {
        val r = FocusRecovery()
        assertNull(r.notHeld(engineRunning = false), "the next engine start asks for focus")
    }

    @Test
    fun theBackoffStartsOverWithTheNextCall() {
        val r = FocusRecovery()
        repeat(3) { r.notHeld(engineRunning = true) }
        r.reset()
        assertEquals(1_000L, r.notHeld(engineRunning = true))
    }

    @Test
    fun theEndOfACellularCallAsksAtOnce() {
        val r = FocusRecovery()
        assertTrue(r.askOnModeChange(telephony = false, engineRunning = true, focusHeld = false))
        assertFalse(r.askOnModeChange(telephony = true, engineRunning = true, focusHeld = false), "refused during a cellular call")
        assertFalse(r.askOnModeChange(telephony = false, engineRunning = true, focusHeld = true), "already held")
        assertFalse(r.askOnModeChange(telephony = false, engineRunning = false, focusHeld = false), "no call running")
    }
}
