package com.magickagency.agent.ring

// Pure Kotlin (no android.* imports): JVM unit-tested (src/test/.../RingCopyTest.kt).
// User-facing copy is British English. IQ61: no caller's name or number anywhere here.

object RingCopy {
    const val INCOMING_TITLE = "Inbound call · Magick Agency"
    const val TEST_TITLE = "Test ring · Magick Agency"
    const val TEST_TEXT = "This is how an inbound call rings while you’re away."
    const val ANSWERING_TEXT = "Connecting the call…"
    const val ANSWER = "Answer"
    const val DECLINE = "Decline"
    const val HANG_UP = "Hang up"

    const val AWAY_TITLE = "Away · this phone rings for inbound calls"
    const val AWAY_TEXT = "Open the app to take calls on screen again."
    const val BACK_TO_CALLS = "Back to calls"
    const val STOP_RINGING = "Stop ringing"

    const val MISSED_TITLE = "Missed inbound call"
    const val MISSED_TEXT = "You didn’t answer an inbound call. It went back to the queue."

    const val RING_OFF_TITLE = "Your phone stopped ringing for inbound calls"

    const val CHANNEL_RING = "Inbound calls"
    const val CHANNEL_RING_DESCRIPTION = "Rings this phone for inbound callers while you’re away from the app."
    const val CHANNEL_RING_QUIET = "Inbound calls, silenced or connecting"
    const val CHANNEL_RING_QUIET_DESCRIPTION = "An inbound call you silenced, or one you answered while it connects."
    const val CHANNEL_AWAY = "Away status"
    const val CHANNEL_AWAY_DESCRIPTION = "Shows that this phone rings for inbound calls while you’re away."
    const val CHANNEL_NOTICES = "Missed inbound calls"
    const val CHANNEL_NOTICES_DESCRIPTION = "Rings you missed, and when your phone stops ringing for inbound calls."

    /** TalkBack's reading of the lock-screen ring ([RingActivity]), said as it opens. */
    const val RING_SCREEN_A11Y = "Inbound call. Double-tap Answer."
    const val TEST_RING_SCREEN_A11Y = "Test ring. Double-tap Answer or Decline to stop it."
    const val ANSWER_A11Y = "Answer the inbound call"
    const val DECLINE_A11Y = "Decline the inbound call"

    const val ACCOUNT_LABEL = "Magick Agency"
    const val ACCOUNT_DESCRIPTION = "Inbound calls for agents who are away from the app"

    /**
     * The `ring_off` notice's text for [reason] (`AGENCY_RING_OFF_REASONS`); null for `opted_out`,
     * which the agent did themselves ("Stop ringing"), so there is nothing to tell them.
     */
    fun ringOffText(reason: String?): String? = when (reason) {
        "ring_missed" -> "You missed two inbound calls. Open the app to turn it back on."
        "revoked" -> "This phone was removed from ringing for inbound calls."
        "opted_out" -> null
        "flag_off" -> "Ringing for inbound calls was switched off for your account."
        "max_age" -> "It stops after 4 hours away. Open the app to go back to calls."
        "taken_over" -> "Your station was opened on another device."
        else -> "Open the app to see why."
    }
}

/** The settings card's checklist (`checklist` on the channel): each true when it lets the phone ring. */
data class RingChecklist(
    val notifications: Boolean,
    val fullScreen: Boolean,
    val batteryExempt: Boolean,
    val microphone: Boolean,
    val phoneAccount: Boolean,
    val dndAllowsCalls: Boolean,
) {
    fun toChannelMap(): Map<String, Boolean> = mapOf(
        "notifications" to notifications,
        "full_screen" to fullScreen,
        "battery_exempt" to batteryExempt,
        "microphone" to microphone,
        "phone_account" to phoneAccount,
        "dnd_allows_calls" to dndAllowsCalls,
    )

    companion object {
        /** The channel's checklist keys, which `openSettings` takes as its `item`. */
        val ITEMS = listOf("notifications", "full_screen", "battery_exempt", "microphone", "phone_account", "dnd_allows_calls")
    }
}

/** Do Not Disturb as `NotificationManager` reports it, without Android types. */
enum class DndFilter { ALL, PRIORITY, ALARMS, NONE, UNKNOWN }

object RingRules {
    /**
     * Whether Do Not Disturb lets a call notification through: DND off; or priority-only with calls
     * from anyone allowed (the ring has no contact behind it); or the ring channel set by the agent
     * to override DND. Alarms-only and total silence never let it through.
     */
    fun dndAllowsCalls(filter: DndFilter, priorityCallsFromAnyone: Boolean, channelBypassesDnd: Boolean): Boolean =
        when (filter) {
            DndFilter.ALL, DndFilter.UNKNOWN -> true
            DndFilter.PRIORITY -> priorityCallsFromAnyone || channelBypassesDnd
            DndFilter.ALARMS, DndFilter.NONE -> false
        }
}

/**
 * The lock-screen ring's colours (`0xRRGGBB`), white text on each. Chosen for WCAG AA (4.5:1 or
 * more for the buttons' text, [RingContrast]); the JVM test checks them.
 */
object RingScreenColours {
    const val BACKGROUND = 0x111827
    const val TEXT = 0xFFFFFF

    /** Green 700: 5.0:1 with white (green 600, 0x16A34A, was 3.3:1). */
    const val ANSWER = 0x15803D

    /** Red 600: 4.8:1 with white. */
    const val DECLINE = 0xDC2626
}

/** WCAG 2's contrast ratio between two `0xRRGGBB` colours. */
object RingContrast {
    fun ratio(a: Int, b: Int): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
    }

    private fun luminance(rgb: Int): Double {
        fun channel(c: Int): Double {
            val s = c / 255.0
            return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel((rgb shr 16) and 0xff) + 0.7152 * channel((rgb shr 8) and 0xff) + 0.0722 * channel(rgb and 0xff)
    }
}
