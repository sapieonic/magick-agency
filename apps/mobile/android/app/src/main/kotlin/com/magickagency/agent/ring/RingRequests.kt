package com.magickagency.agent.ring

// Pure Kotlin (no android.* imports): JVM unit-tested (src/test/.../RingRequestsTest.kt).
// RingApi sends what this builds with HttpURLConnection.

/** One request to the ring routes. The body holds the offer token: never log it (see [toString]). */
data class RingHttpRequest(
    val url: String,
    val method: String,
    val headers: Map<String, String>,
    val body: String,
) {
    override fun toString(): String = "RingHttpRequest($method $url)"
}

/** How a ring route answered, for the retry rule and the log. */
enum class RingApiOutcome {
    OK,

    /** 404 `ring_not_offered`: the token is unknown, spent or expired (uniform, IQ71). */
    GONE,

    /** 409, e.g. `already_accepted`, `ring_expired`. */
    CONFLICT,
    RATE_LIMITED,
    CLIENT_ERROR,
    SERVER_ERROR,

    /** No HTTP answer at all (no network, a timeout). */
    NETWORK,
}

/**
 * The token-only ring routes (IQ71, `packages/contracts/src/agency/inbound.ts` "The ring routes"):
 * `POST /proxy/agency/inbound/calls/:id/ring/answering {offer_token}` and
 * `…/ring/decline {offer_token, reason}`. No Bearer: the offer token is their only authority.
 */
object RingRequests {
    const val CALLS_PATH = "/proxy/agency/inbound/calls/"

    /** Attempts per request: one retry, for an answer that never came or a server error. */
    const val MAX_ATTEMPTS = 2

    /** Connect and read timeout, each, for one attempt. */
    const val TIMEOUT_MS = 5_000

    /** The wait before the retry. */
    const val RETRY_DELAY_MS = 1_000L

    /**
     * The decline is sent from a broadcast receiver kept alive by `goAsync`, which Android reports
     * as not responding after about 10 s: every attempt, and the wait between, stays inside this.
     */
    const val DECLINE_BUDGET_MS = 8_000L

    /** No attempt with less than this of the budget left. */
    const val MIN_ATTEMPT_MS = 1_000L

    /**
     * The connect and read timeout, each, for an attempt with [remainingMs] of the budget left
     * (null: no budget, [TIMEOUT_MS]): connect plus read fit in what is left. Null when too little
     * is left to try ([MIN_ATTEMPT_MS]).
     */
    fun attemptTimeoutMs(remainingMs: Long?): Int? {
        if (remainingMs == null) return TIMEOUT_MS
        if (remainingMs < MIN_ATTEMPT_MS) return null
        return minOf(TIMEOUT_MS.toLong(), remainingMs / 2).toInt()
    }

    /** `X-Client`, as `ClientIdentity.header` in Dart: printable ASCII only. */
    fun clientHeader(version: String, build: String, osVersion: String, model: String): String {
        val raw = "magick-agency-mobile/$version+$build (android $osVersion; $model)"
        return raw.filter { it.code in 0x20..0x7e }
    }

    /** The API origin with no trailing slash; null unless it is an http(s) origin. */
    fun normaliseOrigin(origin: String): String? {
        val trimmed = origin.trim().trimEnd('/')
        if (!(trimmed.startsWith("https://") || trimmed.startsWith("http://"))) return null
        val host = trimmed.substringAfter("://")
        if (host.isEmpty() || host.contains('/') || host.contains('?') || host.contains('#')) return null
        return trimmed
    }

    fun answering(origin: String, callId: String, offerToken: String, clientHeader: String, requestId: String): RingHttpRequest? =
        build(origin, callId, "answering", "{\"offer_token\":${jsonString(offerToken)}}", clientHeader, requestId)

    fun decline(
        origin: String,
        callId: String,
        offerToken: String,
        reason: DeclineReason,
        clientHeader: String,
        requestId: String,
    ): RingHttpRequest? = build(
        origin, callId, "decline",
        "{\"offer_token\":${jsonString(offerToken)},\"reason\":${jsonString(reason.wire)}}",
        clientHeader, requestId,
    )

    private fun build(
        origin: String,
        callId: String,
        action: String,
        body: String,
        clientHeader: String,
        requestId: String,
    ): RingHttpRequest? {
        val base = normaliseOrigin(origin) ?: return null
        if (callId.isBlank()) return null
        return RingHttpRequest(
            url = "$base$CALLS_PATH${encodePathSegment(callId)}/ring/$action",
            method = "POST",
            headers = linkedMapOf(
                "accept" to "application/json",
                "content-type" to "application/json",
                "x-client" to clientHeader,
                "x-request-id" to requestId,
            ),
            body = body,
        )
    }

    /** An HTTP status (null: no answer) as an outcome. */
    fun classify(status: Int?): RingApiOutcome = when {
        status == null -> RingApiOutcome.NETWORK
        status in 200..299 -> RingApiOutcome.OK
        status == 404 -> RingApiOutcome.GONE
        status == 409 -> RingApiOutcome.CONFLICT
        status == 429 -> RingApiOutcome.RATE_LIMITED
        status in 400..499 -> RingApiOutcome.CLIENT_ERROR
        else -> RingApiOutcome.SERVER_ERROR
    }

    /** Whether to send again after [attempt] (1-based) ended with [outcome]. A refusal is final. */
    fun shouldRetry(outcome: RingApiOutcome, attempt: Int): Boolean =
        attempt < MAX_ATTEMPTS && (outcome == RingApiOutcome.NETWORK || outcome == RingApiOutcome.SERVER_ERROR)

    /** [shouldRetry], and with a budget ([remainingMs] left, null for none) only when the wait and one attempt still fit. */
    fun shouldRetry(outcome: RingApiOutcome, attempt: Int, remainingMs: Long?): Boolean =
        shouldRetry(outcome, attempt) && (remainingMs == null || remainingMs - RETRY_DELAY_MS >= MIN_ATTEMPT_MS)

    // Hex by hand: String.format follows the default locale.
    private val HEX = "0123456789ABCDEF".toCharArray()

    /** A JSON string literal. */
    fun jsonString(value: String): String {
        val sb = StringBuilder(value.length + 2).append('"')
        for (c in value) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (c.code < 0x20) sb.append("\\u00").append(HEX[c.code shr 4]).append(HEX[c.code and 0xf]) else sb.append(c)
            }
        }
        return sb.append('"').toString()
    }

    /** RFC 3986 path segment: unreserved characters stay, everything else is percent-encoded (UTF-8). */
    fun encodePathSegment(value: String): String {
        val sb = StringBuilder()
        for (b in value.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xff
            val ch = c.toChar()
            if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '-' || ch == '.' || ch == '_' || ch == '~') {
                sb.append(ch)
            } else {
                sb.append('%').append(HEX[c shr 4]).append(HEX[c and 0xf])
            }
        }
        return sb.toString()
    }
}
