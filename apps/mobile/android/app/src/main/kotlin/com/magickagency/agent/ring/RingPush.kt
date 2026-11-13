package com.magickagency.agent.ring

import java.time.Instant
import java.time.OffsetDateTime

// Pure Kotlin (no android.* imports): JVM unit-tested (src/test/.../RingPushParserTest.kt).

/**
 * The ring's timings and wire values, mirrored by hand from `packages/contracts`
 * (`agency/inbound.ts`, `agency/push-devices.ts`, Mode B, IQ58–IQ74). Contract constants, never
 * configuration: a change there lands here in the same commit.
 */
object RingWire {
    /** `AGENCY_INBOUND_RING_MS` (IQ59): how long one ring lasts. */
    const val RING_MS = 20_000L

    /** `AGENCY_INBOUND_ACCEPT_GRACE_MS` (IQ59): from the tap on Answer to audio. */
    const val ACCEPT_GRACE_MS = 15_000L

    /**
     * Added to the grace on the phone: the server starts its grace when `…/ring/answering`
     * arrives, a round trip after the tap, so the phone never gives up on a call the server still
     * holds.
     */
    const val GRACE_MARGIN_MS = 3_000L

    /**
     * How far past `RING_MS` from now a ring's `ring_expires_at` may reach before it is capped: a
     * phone clock running behind must not ring for longer than the server offers the call.
     */
    const val CLOCK_SLACK_MS = 2_000L

    /**
     * How much older than the absence the phone shows a `ring_off`'s absence may start and still be
     * taken as ending it: the two starts are stamped by different writes on the server.
     */
    const val RING_OFF_TOLERANCE_MS = 2_000L

    /**
     * After the away notification's "Stop ringing", how long a ring that arrives anyway is declined
     * at once: the app asks `device_away` over HTTP before its station attaches (an attach during a
     * ring would answer it, N5), and a ring already in flight on the server keeps `away_ring` until
     * it ends. One ring window covers the app's ask and its retries.
     */
    const val STOP_RINGING_HOLD_MS = RING_MS

    /**
     * How long a "Stop ringing" tap Dart has not cleared is kept: one ring window plus the accept
     * grace, the longest a ring in flight at the tap can hold the session. Older, it is dropped
     * unread, so it never pauses a later absence.
     */
    const val STOP_RINGING_KEEP_MS = RING_MS + ACCEPT_GRACE_MS

    /**
     * Without a fresh server clock offset, the most of a push's delivery delay a ring's time left
     * loses ([RingTiming.remainingMs]): the phone's clock cannot tell a slow delivery from a clock
     * running fast, so a fast clock shortens a ring by this much at most and never drops it.
     */
    const val DELIVERY_CAP_MS = 3_000L

    /** How long the server clock offset Dart measured is trusted ([ServerClockOffset.isFresh]). */
    const val SERVER_CLOCK_MAX_AGE_MS = 24L * 60 * 60 * 1000

    /** `AGENCY_INBOUND_RING_RESULTS`: a `ring_cancel`'s `reason`, and `ringEnded`'s. */
    val RING_RESULTS = listOf(
        "answered", "declined", "expired", "accept_lapsed", "busy_on_phone", "push_failed", "caller_left",
        "answered_elsewhere", "cancelled",
    )

    /** `AGENCY_RING_OFF_REASONS`: a `ring_off`'s `reason`. */
    val RING_OFF_REASONS = listOf("ring_missed", "revoked", "opted_out", "flag_off", "max_age", "taken_over", "left")

    /** `AGENCY_RING_PUSH_TYPES`. */
    val PUSH_TYPES = listOf("ring", "ring_cancel", "ring_off", "test_ring")
}

/** `AGENCY_INBOUND_RING_DECLINE_REASONS`: why the phone declined a ring. */
enum class DeclineReason(val wire: String) {
    DECLINED("declined"),
    BUSY_ON_PHONE("busy_on_phone"),
}

/** A data push (`AgencyRingPush`), parsed and checked. IQ61: never a name or a number. */
sealed class RingPush {
    /** Ring this phone for [callId] until [expiresAtMs] (epoch ms, the server's clock). */
    data class Ring(
        val callId: String,
        val offerToken: String,
        val sessionId: String,
        val expiresAtMs: Long,
    ) : RingPush() {
        // The offer token never reaches a log line, even through a data class's toString.
        override fun toString(): String = "Ring(callId=$callId, sessionId=$sessionId, expiresAtMs=$expiresAtMs)"
    }

    /** Stop ringing [callId]; [reason] is one of [RingWire.RING_RESULTS] (`cancelled` when absent or unknown). */
    data class Cancel(val callId: String, val reason: String) : RingPush()

    /**
     * The server ended this device's `away_ring`; [reason] is one of [RingWire.RING_OFF_REASONS], or
     * null when unknown. [awaySinceMs]: the start of the absence it ends (`away_since`, epoch ms);
     * null from a server older than the field.
     */
    data class Off(val sessionId: String?, val reason: String?, val awaySinceMs: Long? = null) : RingPush()

    /** The settings card's "Send a test ring": ring locally, no call behind it. */
    data object Test : RingPush()
}

/** Reads an FCM data payload (every value a string) into a [RingPush]; null when it is not one or is malformed. */
object RingPushParser {
    fun parse(data: Map<String, String>): RingPush? {
        return when (data["type"]) {
            "ring" -> {
                val callId = data.nonBlank("call_id") ?: return null
                val token = data.nonBlank("offer_token") ?: return null
                val sessionId = data.nonBlank("session_id") ?: return null
                val expires = data.nonBlank("ring_expires_at")?.let(::parseIsoMillis) ?: return null
                RingPush.Ring(callId, token, sessionId, expires)
            }
            "ring_cancel" -> {
                val callId = data.nonBlank("call_id") ?: return null
                val reason = data["reason"]?.takeIf { it in RingWire.RING_RESULTS } ?: "cancelled"
                RingPush.Cancel(callId, reason)
            }
            "ring_off" -> RingPush.Off(
                sessionId = data.nonBlank("session_id"),
                reason = data["reason"]?.takeIf { it in RingWire.RING_OFF_REASONS },
                awaySinceMs = data.nonBlank("away_since")?.let(::parseIsoMillis),
            )
            "test_ring" -> RingPush.Test
            else -> null
        }
    }

    /** ISO-8601 with a `Z` or an offset, to epoch ms; null when it does not parse. */
    fun parseIsoMillis(value: String): Long? {
        runCatching { return Instant.parse(value).toEpochMilli() }
        return runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()
    }

    private fun Map<String, String>.nonBlank(key: String): String? = this[key]?.trim()?.takeIf { it.isNotEmpty() }
}
