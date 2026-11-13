package com.magickagency.agent.ring

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.magickagency.agent.R
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Sends the token-only ring routes (`…/ring/answering`, `…/ring/decline`; IQ71) from native code,
 * at the tap, without Flutter: HttpURLConnection on one background thread to the build's
 * `API_ORIGIN` (the dart-define, written into `R.string.magick_api_origin` by Gradle). The request
 * itself is built by [RingRequests]. The offer token is never logged.
 */
internal class RingApi(context: Context) {
    private val app = context.applicationContext
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "magick-ring-api").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())

    fun answering(callId: String, offerToken: String, onDone: ((RingApiOutcome) -> Unit)? = null) =
        send(null, onDone) { origin, client, id -> RingRequests.answering(origin, callId, offerToken, client, id) }

    /** Sent from a broadcast receiver held by `goAsync`: every attempt inside [RingRequests.DECLINE_BUDGET_MS]. */
    fun decline(callId: String, offerToken: String, reason: DeclineReason, onDone: ((RingApiOutcome) -> Unit)? = null) =
        send(RingRequests.DECLINE_BUDGET_MS, onDone) { origin, client, id -> RingRequests.decline(origin, callId, offerToken, reason, client, id) }

    /** [budgetMs]: the whole send (attempts and the wait between) stays inside it; null for none. [onDone] always runs. */
    private fun send(budgetMs: Long?, onDone: ((RingApiOutcome) -> Unit)?, build: (String, String, String) -> RingHttpRequest?) {
        val origin = app.getString(R.string.magick_api_origin)
        val client = clientHeader()
        executor.execute {
            val start = SystemClock.elapsedRealtime()
            val left = { budgetMs?.let { it - (SystemClock.elapsedRealtime() - start) } }
            var outcome = RingApiOutcome.NETWORK
            try {
                val request = build(origin, client, UUID.randomUUID().toString())
                outcome = if (request == null) {
                    Log.w(TAG, "No request: the build's API origin is not an http(s) origin")
                    RingApiOutcome.CLIENT_ERROR
                } else {
                    var attempt = 1
                    var answer = execute(request, RingRequests.attemptTimeoutMs(left()) ?: 0)
                    var result = RingRequests.classify(answer.status)
                    while (true) {
                        val delay = RingRequests.retryDelayMs(result, attempt, left(), RingRequests.retryAfterMs(answer.retryAfter))
                            ?: break
                        Thread.sleep(delay)
                        val timeout = RingRequests.attemptTimeoutMs(left()) ?: break
                        attempt += 1
                        answer = execute(request, timeout)
                        result = RingRequests.classify(answer.status)
                    }
                    Log.i(TAG, "$request: $result after $attempt attempt(s)")
                    result
                }
            } catch (e: Exception) {
                // Never leave onDone unrun (a receiver's goAsync waits on it).
                Log.w(TAG, "A ring request failed: ${e.javaClass.simpleName}")
            } finally {
                val result = outcome
                if (onDone != null) main.post { onDone(result) }
            }
        }
    }

    /** An attempt's HTTP status (null: no answer came) and its `Retry-After` header, if any. */
    private class Answer(val status: Int?, val retryAfter: String? = null)

    /** One attempt. [timeoutMs]: connect and read, each; 0 sends nothing. */
    private fun execute(request: RingHttpRequest, timeoutMs: Int): Answer {
        if (timeoutMs <= 0) return Answer(null)
        var conn: HttpURLConnection? = null
        return try {
            conn = (URI(request.url).toURL().openConnection() as HttpURLConnection).apply {
                requestMethod = request.method
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                useCaches = false
                doOutput = true
                for ((k, v) in request.headers) setRequestProperty(k, v)
            }
            val bytes = request.body.toByteArray(Charsets.UTF_8)
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.outputStream.use { it.write(bytes) }
            val status = conn.responseCode
            // Drain so the connection can be reused; the body carries nothing native needs.
            runCatching { (if (status >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() } }
            Answer(status, conn.getHeaderField("Retry-After"))
        } catch (e: IOException) {
            Log.w(TAG, "$request failed: ${e.javaClass.simpleName}")
            Answer(null)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "$request not sent: ${e.javaClass.simpleName}")
            Answer(null)
        } finally {
            conn?.disconnect()
        }
    }

    /** `X-Client`, as Dart's `ClientIdentity.header`. */
    private fun clientHeader(): String {
        val (version, build) = try {
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                app.packageManager.getPackageInfo(app.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                app.packageManager.getPackageInfo(app.packageName, 0)
            }
            (info.versionName ?: "unknown") to info.longVersionCode.toString()
        } catch (e: PackageManager.NameNotFoundException) {
            "unknown" to "0"
        }
        return RingRequests.clientHeader(version, build, Build.VERSION.RELEASE ?: "", "${Build.MANUFACTURER} ${Build.MODEL}")
    }

    private companion object {
        const val TAG = "MagickRing"
    }
}
