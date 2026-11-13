package com.magickagency.agent.ring

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import com.magickagency.agent.MainActivity
import com.magickagency.agent.R

/** Extras and actions of the intents the ring sends to [MainActivity], [RingActivity] and [RingActionReceiver]. */
object RingIntents {
    /** Launched for a ring: [MainActivity] shows over the lock screen and asks to dismiss the keyguard. */
    const val EXTRA_RING = "com.magickagency.agent.ring.EXTRA_RING"
    const val EXTRA_CALL_ID = "com.magickagency.agent.ring.EXTRA_CALL_ID"

    /** The away notification's "Stop ringing": Dart hears `stopRingingTapped`. */
    const val EXTRA_STOP_RINGING = "com.magickagency.agent.ring.EXTRA_STOP_RINGING"

    const val ACTION_ANSWER = "com.magickagency.agent.ring.ANSWER"
    const val ACTION_SHOW = "com.magickagency.agent.ring.SHOW"
    const val ACTION_DECLINE = "com.magickagency.agent.ring.DECLINE"
    const val ACTION_BACK_TO_CALLS = "com.magickagency.agent.ring.BACK_TO_CALLS"
    const val ACTION_STOP_RINGING = "com.magickagency.agent.ring.STOP_RINGING"
    const val ACTION_OPEN = "com.magickagency.agent.ring.OPEN"

    // One request code per action: a PendingIntent's identity ignores extras.
    private const val RC_ANSWER = 4101
    private const val RC_FULL_SCREEN = 4102
    private const val RC_DECLINE = 4103
    private const val RC_SHOW = 4104
    private const val RC_BACK = 4105
    private const val RC_STOP = 4106
    private const val RC_OPEN = 4107

    private const val FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

    fun mainActivity(context: Context, action: String): Intent =
        Intent(context, MainActivity::class.java).setAction(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    /** Answer is always an activity start (never a trampoline through a broadcast or a service). */
    fun answer(context: Context, callId: String): PendingIntent = PendingIntent.getActivity(
        context, RC_ANSWER,
        mainActivity(context, ACTION_ANSWER).putExtra(EXTRA_RING, true).putExtra(EXTRA_CALL_ID, callId),
        FLAGS,
    )

    /** The full-screen intent: the lock-screen ring ([RingActivity]), which does not start Flutter. */
    fun fullScreen(context: Context, callId: String): PendingIntent = PendingIntent.getActivity(
        context, RC_FULL_SCREEN,
        Intent(context, RingActivity::class.java)
            .setAction(ACTION_SHOW)
            .putExtra(EXTRA_CALL_ID, callId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
        FLAGS,
    )

    /** After Answer: bring the app up over the lock screen (the answered notification's tap and full-screen intent). */
    fun showAnswered(context: Context, callId: String): PendingIntent = PendingIntent.getActivity(
        context, RC_SHOW,
        mainActivity(context, ACTION_SHOW).putExtra(EXTRA_RING, true).putExtra(EXTRA_CALL_ID, callId),
        FLAGS,
    )

    fun decline(context: Context, callId: String): PendingIntent = PendingIntent.getBroadcast(
        context, RC_DECLINE,
        Intent(context, RingActionReceiver::class.java).setAction(ACTION_DECLINE).putExtra(EXTRA_CALL_ID, callId),
        FLAGS,
    )

    fun backToCalls(context: Context): PendingIntent =
        PendingIntent.getActivity(context, RC_BACK, mainActivity(context, ACTION_BACK_TO_CALLS), FLAGS)

    fun stopRinging(context: Context): PendingIntent = PendingIntent.getActivity(
        context, RC_STOP, mainActivity(context, ACTION_STOP_RINGING).putExtra(EXTRA_STOP_RINGING, true), FLAGS,
    )

    fun openApp(context: Context): PendingIntent =
        PendingIntent.getActivity(context, RC_OPEN, mainActivity(context, ACTION_OPEN), FLAGS)
}

/**
 * The ring's notifications. The ringing one is a `CallStyle.forIncomingCall` with a full-screen
 * intent (a CallStyle notification from an app with no foreground service must carry one), on a
 * high-importance channel whose sound is the ringtone, looped (`FLAG_INSISTENT`) until the ring
 * ends. Posted through the platform NotificationManager, after checking POST_NOTIFICATIONS.
 */
internal object RingNotifications {
    private const val TAG = "MagickRing"

    const val CHANNEL_RING = "magick_agency_ring"

    /** The ring's notifications that must make no sound: a silenced ring, a call answered and connecting. */
    const val CHANNEL_RING_QUIET = "magick_agency_ring_quiet"
    const val CHANNEL_AWAY = "magick_agency_away"
    const val CHANNEL_NOTICES = "magick_agency_ring_notices"

    /** The ringing/answered call, tagged with its call id so one call's end never drops another's. */
    private const val ID_CALL = 4201
    private const val ID_AWAY = 4202
    private const val ID_MISSED = 4203
    private const val ID_RING_OFF = 4204

    private fun nm(context: Context): NotificationManager = context.getSystemService(NotificationManager::class.java)

    fun ensureChannels(context: Context) {
        val nm = nm(context)
        if (nm.getNotificationChannel(CHANNEL_RING) == null) {
            val ring = NotificationChannel(CHANNEL_RING, RingCopy.CHANNEL_RING, NotificationManager.IMPORTANCE_HIGH).apply {
                description = RingCopy.CHANNEL_RING_DESCRIPTION
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 1000, 1000)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            nm.createNotificationChannel(ring)
        }
        if (nm.getNotificationChannel(CHANNEL_RING_QUIET) == null) {
            val quiet = NotificationChannel(CHANNEL_RING_QUIET, RingCopy.CHANNEL_RING_QUIET, NotificationManager.IMPORTANCE_HIGH).apply {
                description = RingCopy.CHANNEL_RING_QUIET_DESCRIPTION
                setSound(null, null)
                enableVibration(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            nm.createNotificationChannel(quiet)
        }
        if (nm.getNotificationChannel(CHANNEL_AWAY) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_AWAY, RingCopy.CHANNEL_AWAY, NotificationManager.IMPORTANCE_LOW).apply {
                    description = RingCopy.CHANNEL_AWAY_DESCRIPTION
                    setShowBadge(false)
                },
            )
        }
        if (nm.getNotificationChannel(CHANNEL_NOTICES) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_NOTICES, RingCopy.CHANNEL_NOTICES, NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = RingCopy.CHANNEL_NOTICES_DESCRIPTION
                },
            )
        }
    }

    fun canPost(context: Context): Boolean =
        (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            nm(context).areNotificationsEnabled()

    /**
     * The ringing call. [silent]: Telecom asked to silence it (a volume key); it stays, quietly. The
     * looping ringtone belongs to the posted notification, and an update is not sure to stop it,
     * so the silent copy replaces it: the ringing one is cancelled, and the copy posted on the
     * soundless channel.
     */
    fun showIncoming(context: Context, call: RingCall, deadlineMs: Long, silent: Boolean): Boolean {
        val title = if (call.test) RingCopy.TEST_TITLE else RingCopy.INCOMING_TITLE
        val caller = Person.Builder().setName(title).setImportant(true).build()
        val fullScreen = RingIntents.fullScreen(context, call.callId)
        if (silent) cancelCall(context, call.callId)
        val builder = NotificationCompat.Builder(context, if (silent) CHANNEL_RING_QUIET else CHANNEL_RING)
            .setSmallIcon(R.drawable.ring_ic_call)
            .setContentTitle(title)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(silent)
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
            .setTimeoutAfter(maxOf(1L, deadlineMs - System.currentTimeMillis()))
            .setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    caller,
                    RingIntents.decline(context, call.callId),
                    RingIntents.answer(context, call.callId),
                ),
            )
        if (call.test) builder.setContentText(RingCopy.TEST_TEXT)
        val n = builder.build()
        if (!silent) n.flags = n.flags or Notification.FLAG_INSISTENT
        return post(context, call.callId, ID_CALL, n)
    }

    /**
     * After Answer, until the station binds, with Hang up (a decline, N4; once the accept went
     * through, Dart hangs the call up through the station). The ringing notification is cancelled
     * first (that stops its ringtone) and this one goes on the soundless channel.
     *
     * [surfaceApp] (Answer came from a headset or a car, no activity launching with it): an
     * ongoing CallStyle whose full-screen intent brings the app up over the lock screen. Otherwise
     * the app is already launching, so a second launch is not wanted: a plain ongoing call
     * notification with no full-screen intent (a CallStyle must carry one, or be a foreground
     * service's).
     */
    fun showAnswering(context: Context, call: RingCall, surfaceApp: Boolean) {
        val show = RingIntents.showAnswered(context, call.callId)
        val hangUp = RingIntents.decline(context, call.callId)
        val builder = NotificationCompat.Builder(context, CHANNEL_RING_QUIET)
            .setSmallIcon(R.drawable.ring_ic_call)
            .setContentTitle(RingCopy.INCOMING_TITLE)
            .setContentText(RingCopy.ANSWERING_TEXT)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(show)
        if (surfaceApp) {
            val caller = Person.Builder().setName(RingCopy.INCOMING_TITLE).setImportant(true).build()
            builder.setFullScreenIntent(show, true)
                .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangUp))
        } else {
            builder.addAction(0, RingCopy.HANG_UP, hangUp)
        }
        cancelCall(context, call.callId)
        post(context, call.callId, ID_CALL, builder.build())
    }

    fun cancelCall(context: Context, callId: String) = nm(context).cancel(callId, ID_CALL)

    fun showAway(context: Context, on: Boolean) {
        if (!on) {
            nm(context).cancel(ID_AWAY)
            return
        }
        val n = NotificationCompat.Builder(context, CHANNEL_AWAY)
            .setSmallIcon(R.drawable.ring_ic_call)
            .setContentTitle(RingCopy.AWAY_TITLE)
            .setContentText(RingCopy.AWAY_TEXT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(RingIntents.backToCalls(context))
            .addAction(0, RingCopy.BACK_TO_CALLS, RingIntents.backToCalls(context))
            .addAction(0, RingCopy.STOP_RINGING, RingIntents.stopRinging(context))
            .build()
        post(context, null, ID_AWAY, n)
    }

    fun showMissed(context: Context) {
        val n = NotificationCompat.Builder(context, CHANNEL_NOTICES)
            .setSmallIcon(R.drawable.ring_ic_call)
            .setContentTitle(RingCopy.MISSED_TITLE)
            .setContentText(RingCopy.MISSED_TEXT)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setAutoCancel(true)
            .setContentIntent(RingIntents.openApp(context))
            .build()
        post(context, null, ID_MISSED, n)
    }

    /** A `ring_off`: the away notification goes, and the agent is told why (nothing for their own "Stop ringing"). */
    fun showRingOff(context: Context, reason: String?) {
        nm(context).cancel(ID_AWAY)
        val text = RingCopy.ringOffText(reason) ?: return
        val n = NotificationCompat.Builder(context, CHANNEL_NOTICES)
            .setSmallIcon(R.drawable.ring_ic_call)
            .setContentTitle(RingCopy.RING_OFF_TITLE)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(RingIntents.openApp(context))
            .build()
        post(context, null, ID_RING_OFF, n)
    }

    /** Whether the notification was handed to the system. */
    private fun post(context: Context, tag: String?, id: Int, n: Notification): Boolean {
        ensureChannels(context)
        if (!canPost(context)) {
            Log.w(TAG, "Notifications are off; notification $id not shown")
            return false
        }
        return try {
            nm(context).notify(tag, id, n)
            true
        } catch (e: RuntimeException) {
            // e.g. a CallStyle refused by the system.
            Log.w(TAG, "Notification $id refused: ${e.javaClass.simpleName}: ${e.message}")
            false
        }
    }
}
