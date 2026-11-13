package com.magickagency.agent.ring

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The lock-screen ring: the ringing notification's full-screen intent. Android launches it on its
 * own when the phone is locked or its screen is off, so it must not start Flutter: opening the app
 * attaches the station, which the server takes as an answer (N5). It shows the ring and two
 * buttons; Answer starts MainActivity (an activity start from the foreground, with the answer
 * already posted by native code), Decline posts the decline. It closes itself when the ring ends.
 */
class RingActivity : Activity() {
    private var callId: String? = null
    private val follow: (RingState) -> Unit = { s -> if (!ringing(s)) finish() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        callId = intent.getStringExtra(RingIntents.EXTRA_CALL_ID)
        if (!ringing(RingCoordinator.state)) {
            finish()
            return
        }
        setContentView(layout())
        RingCoordinator.addListener(follow)
    }

    override fun onDestroy() {
        RingCoordinator.removeListener(follow)
        super.onDestroy()
    }

    private fun ringing(s: RingState): Boolean = s is RingState.Ringing && s.call.callId == callId

    private fun layout(): LinearLayout {
        val test = (RingCoordinator.state as? RingState.Ringing)?.call?.test == true
        val dp = { v: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt() }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(opaque(RingScreenColours.BACKGROUND))
            setPadding(dp(24), dp(48), dp(24), dp(48))
            addView(
                TextView(this@RingActivity).apply {
                    text = if (test) RingCopy.TEST_TITLE else RingCopy.INCOMING_TITLE
                    // TalkBack says what this is and what to do, once, as the screen opens.
                    contentDescription = if (test) RingCopy.TEST_RING_SCREEN_A11Y else RingCopy.RING_SCREEN_A11Y
                    accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE
                    setTextColor(opaque(RingScreenColours.TEXT))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
                    typeface = Typeface.DEFAULT_BOLD
                    gravity = Gravity.CENTER
                },
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(48) },
            )
            addView(
                button(RingCopy.ANSWER, RingCopy.ANSWER_A11Y, RingScreenColours.ANSWER) { onAnswer() },
                LinearLayout.LayoutParams(MATCH_PARENT, dp(64)).apply { bottomMargin = dp(16) },
            )
            addView(
                button(RingCopy.DECLINE, RingCopy.DECLINE_A11Y, RingScreenColours.DECLINE) { onDecline() },
                LinearLayout.LayoutParams(MATCH_PARENT, dp(64)),
            )
        }
    }

    /** White text on [colour] (WCAG AA, [RingScreenColours]), bold and large. */
    private fun button(label: String, description: String, colour: Int, onClick: () -> Unit) = Button(this).apply {
        text = label
        contentDescription = description
        setTextColor(opaque(RingScreenColours.TEXT))
        setBackgroundColor(opaque(colour))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        typeface = Typeface.DEFAULT_BOLD
        setOnClickListener { onClick() }
    }

    private fun opaque(rgb: Int): Int = Color.rgb((rgb shr 16) and 0xff, (rgb shr 8) and 0xff, rgb and 0xff)

    private fun onAnswer() {
        val id = callId ?: return finish()
        val test = (RingCoordinator.state as? RingState.Ringing)?.call?.test == true
        // A test ring's Answer only dismisses it. The app is started first, while this activity is
        // still in front (answering finishes it through the listener).
        if (!test) {
            startActivity(
                RingIntents.mainActivity(this, RingIntents.ACTION_SHOW)
                    .putExtra(RingIntents.EXTRA_RING, true)
                    .putExtra(RingIntents.EXTRA_CALL_ID, id),
            )
        }
        RingCoordinator.answer(this, id, AnswerSource.LOCK_SCREEN)
        finish()
    }

    private fun onDecline() {
        callId?.let { RingCoordinator.decline(this, it) }
        finish()
    }
}
