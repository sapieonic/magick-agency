package com.magickagency.agent.ring

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RingRequestsTest {
    private val client = "magick-agency-mobile/0.9.0+412 (android 15; Google Pixel 8)"

    @Test
    fun answeringCarriesOnlyTheOfferToken() {
        val r = RingRequests.answering("https://agency.example.invalid", "7d2b9e4f-6a1c", "q0Vx3b9KcT1mN7zR2aW5yE", client, "req-1")!!
        assertEquals("POST", r.method)
        assertEquals("https://agency.example.invalid/proxy/agency/inbound/calls/7d2b9e4f-6a1c/ring/answering", r.url)
        // As fixtures/agent/push.json's ring_answering_request.
        assertEquals("{\"offer_token\":\"q0Vx3b9KcT1mN7zR2aW5yE\"}", r.body)
        assertEquals(
            mapOf(
                "accept" to "application/json",
                "content-type" to "application/json",
                "x-client" to client,
                "x-request-id" to "req-1",
            ),
            r.headers,
        )
        assertFalse(r.headers.keys.any { it.equals("authorization", ignoreCase = true) }, "no Bearer: the token is the authority")
    }

    @Test
    fun declineCarriesTheTokenAndTheReason() {
        val r = RingRequests.decline("https://agency.example.invalid/", "c1", "q0Vx3b9KcT1mN7zR2aW5yE", DeclineReason.DECLINED, client, "req-2")!!
        assertEquals("https://agency.example.invalid/proxy/agency/inbound/calls/c1/ring/decline", r.url)
        assertEquals("{\"offer_token\":\"q0Vx3b9KcT1mN7zR2aW5yE\",\"reason\":\"declined\"}", r.body)
        val busy = RingRequests.decline("http://10.0.2.2:3021", "c1", "t", DeclineReason.BUSY_ON_PHONE, client, "req-3")!!
        assertEquals("http://10.0.2.2:3021/proxy/agency/inbound/calls/c1/ring/decline", busy.url)
        assertEquals("{\"offer_token\":\"t\",\"reason\":\"busy_on_phone\"}", busy.body)
    }

    @Test
    fun theRequestNeverPrintsItsBody() {
        val r = RingRequests.answering("https://a.example", "c1", "secret-token", client, "req")!!
        assertFalse(r.toString().contains("secret-token"))
        assertEquals("RingHttpRequest(POST https://a.example/proxy/agency/inbound/calls/c1/ring/answering)", r.toString())
    }

    @Test
    fun theCallIdIsOnePathSegment() {
        val r = RingRequests.answering("https://a.example", "../x y/é", "t", client, "req")!!
        assertEquals("https://a.example/proxy/agency/inbound/calls/..%2Fx%20y%2F%C3%A9/ring/answering", r.url)
        assertNull(RingRequests.answering("https://a.example", " ", "t", client, "req"))
    }

    @Test
    fun onlyAnHttpOriginIsUsed() {
        assertEquals("https://a.example", RingRequests.normaliseOrigin(" https://a.example// "))
        assertEquals("http://10.0.2.2:3021", RingRequests.normaliseOrigin("http://10.0.2.2:3021"))
        assertNull(RingRequests.normaliseOrigin(""))
        assertNull(RingRequests.normaliseOrigin("a.example"))
        assertNull(RingRequests.normaliseOrigin("ftp://a.example"))
        assertNull(RingRequests.normaliseOrigin("https://"))
        assertNull(RingRequests.normaliseOrigin("https://a.example/api"))
        assertNull(RingRequests.answering("wss://a.example", "c", "t", client, "r"))
    }

    @Test
    fun tokensAreEscapedAsJson() {
        assertEquals("\"a\\\"b\\\\c\\n\\u0001\"", RingRequests.jsonString("a\"b\\c\n\u0001"))
        assertEquals("\"plain-token_123\"", RingRequests.jsonString("plain-token_123"))
    }

    @Test
    fun theClientHeaderMatchesDartsAndDropsWhatHttpCannotCarry() {
        assertEquals(client, RingRequests.clientHeader("0.9.0", "412", "15", "Google Pixel 8"))
        assertEquals(
            "magick-agency-mobile/0.9.0+412 (android 14; Phone X)",
            RingRequests.clientHeader("0.9.0", "412", "14", "Phone™ X\n"),
        )
    }

    @Test
    fun statusesAreClassified() {
        assertEquals(RingApiOutcome.NETWORK, RingRequests.classify(null))
        assertEquals(RingApiOutcome.OK, RingRequests.classify(200))
        assertEquals(RingApiOutcome.OK, RingRequests.classify(204))
        assertEquals(RingApiOutcome.GONE, RingRequests.classify(404))
        assertEquals(RingApiOutcome.CONFLICT, RingRequests.classify(409))
        assertEquals(RingApiOutcome.RATE_LIMITED, RingRequests.classify(429))
        assertEquals(RingApiOutcome.CLIENT_ERROR, RingRequests.classify(400))
        assertEquals(RingApiOutcome.SERVER_ERROR, RingRequests.classify(503))
    }

    @Test
    fun onlyANetworkFailureOrAServerErrorIsRetriedAndOnlyOnce() {
        assertTrue(RingRequests.shouldRetry(RingApiOutcome.NETWORK, attempt = 1))
        assertTrue(RingRequests.shouldRetry(RingApiOutcome.SERVER_ERROR, attempt = 1))
        assertFalse(RingRequests.shouldRetry(RingApiOutcome.NETWORK, attempt = 2))
        for (o in listOf(RingApiOutcome.OK, RingApiOutcome.GONE, RingApiOutcome.CONFLICT, RingApiOutcome.RATE_LIMITED, RingApiOutcome.CLIENT_ERROR)) {
            assertFalse(RingRequests.shouldRetry(o, attempt = 1), "$o")
        }
    }
}
