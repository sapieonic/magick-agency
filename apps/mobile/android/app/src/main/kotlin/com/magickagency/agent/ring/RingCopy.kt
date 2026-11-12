package com.magickagency.agent.ring

// Pure Kotlin (no android.* imports): JVM unit-tested (src/test/.../RingCopyTest.kt).
// User-facing copy is British English. IQ61: no caller's name or number anywhere here.

object RingCopy {
    const val INCOMING_TITLE = "Inbound call · Magick Agency"
    const val TEST_TITLE = "Test ring · Magick Agency"
    const val TEST_TEXT = "This is how an inbound call rings while you are away."
    const val ANSWERING_TEXT = "Connecting the call…"
    const val ANSWER = "Answer"
    const val DECLINE = "Decline"

    const val AWAY_TITLE = "Away · inbound calls ring this phone"
    const val AWAY_TEXT = "Open the app to take calls on screen again."
    const val BACK_TO_CALLS = "Back to calls"
    const val STOP_RINGING = "Stop ringing"

    const val MISSED_TITLE = "Missed inbound call"
    const val MISSED_TEXT = "Your phone rang for an inbound caller and the call was not answered."

    const val RING_OFF_TITLE = "Your phone stopped ringing for inbound calls"

    const val CHANNEL_RING = "Inbound calls"
    const val CHANNEL_RING_DESCRIPTION = "Rings this phone for inbound callers while you are away from the app."
    const val CHANNEL_AWAY = "Away status"
    const val CHANNEL_AWAY_DESCRIPTION = "Shows that inbound calls ring this phone while you are away."
    const val CHANNEL_NOTICES = "Missed inbound calls"
    const val CHANNEL_NOTICES_DESCRIPTION = "Rings you missed, and when your phone stops ringing for inbound calls."

    const val ACCOUNT_LABEL = "Magick Agency"
    const val ACCOUNT_DESCRIPTION = "Inbound calls for agents who are away from the app"

    /**
     * The `ring_off` notice's text for [reason] (`AGENCY_RING_OFF_REASONS`); null for `opted_out`,
     * which the agent did themselves ("Stop ringing"), so there is nothing to tell them.
     */
    fun ringOffText(reason: String?): String? = when (reason) {
        "ring_missed" -> "You missed two in a row. Open the app to turn it back on."
        "revoked" -> "This phone was removed from ringing for inbound calls."
        "opted_out" -> null
        "flag_off" -> "Ringing for inbound calls was switched off for your account."
        "max_age" -> "You were away for too long. Open the app to go back to calls."
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
