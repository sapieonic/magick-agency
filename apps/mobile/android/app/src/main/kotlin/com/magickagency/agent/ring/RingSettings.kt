package com.magickagency.agent.ring

import android.Manifest
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.telecom.TelecomManager
import android.util.Log

/** The settings card's checklist (`checklist`) and the screens that fix each item (`openSettings`). */
internal object RingSettings {
    private const val TAG = "MagickRing"

    fun checklist(context: Context): RingChecklist {
        RingNotifications.ensureChannels(context)
        val nm = context.getSystemService(NotificationManager::class.java)
        val ringChannel = nm.getNotificationChannel(RingNotifications.CHANNEL_RING)
        val notifications = RingNotifications.canPost(context) &&
            (ringChannel == null || ringChannel.importance != NotificationManager.IMPORTANCE_NONE)
        val fullScreen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) nm.canUseFullScreenIntent() else true
        val battery = context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true
        val microphone = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        return RingChecklist(
            notifications = notifications,
            fullScreen = fullScreen,
            batteryExempt = battery,
            microphone = microphone,
            phoneAccount = RingTelecom.accountUsable(context),
            dndAllowsCalls = dndAllowsCalls(nm, ringChannel?.canBypassDnd() == true),
        )
    }

    private fun dndAllowsCalls(nm: NotificationManager, channelBypasses: Boolean): Boolean {
        val filter = when (nm.currentInterruptionFilter) {
            NotificationManager.INTERRUPTION_FILTER_ALL -> DndFilter.ALL
            NotificationManager.INTERRUPTION_FILTER_PRIORITY -> DndFilter.PRIORITY
            NotificationManager.INTERRUPTION_FILTER_ALARMS -> DndFilter.ALARMS
            NotificationManager.INTERRUPTION_FILTER_NONE -> DndFilter.NONE
            else -> DndFilter.UNKNOWN
        }
        val callsFromAnyone = try {
            val policy = nm.notificationPolicy
            (policy.priorityCategories and NotificationManager.Policy.PRIORITY_CATEGORY_CALLS) != 0 &&
                policy.priorityCallSenders == NotificationManager.Policy.PRIORITY_SENDERS_ANY
        } catch (e: RuntimeException) {
            false
        }
        return RingRules.dndAllowsCalls(filter, callsFromAnyone, channelBypasses)
    }

    /** Opens the system screen that fixes [item] (a checklist key), trying each candidate in turn. */
    fun open(context: Context, item: String) {
        val pkg = context.packageName
        val packageUri = Uri.fromParts("package", pkg, null)
        val appDetails = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)
        val appNotifications = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
        val candidates: List<Intent> = when (item) {
            "notifications" -> {
                val nm = context.getSystemService(NotificationManager::class.java)
                if (nm.areNotificationsEnabled()) {
                    listOf(
                        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                            .putExtra(Settings.EXTRA_CHANNEL_ID, RingNotifications.CHANNEL_RING),
                        appNotifications,
                    )
                } else {
                    listOf(appNotifications, appDetails)
                }
            }
            "full_screen" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                listOf(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, packageUri), appNotifications)
            } else {
                listOf(appNotifications)
            }
            "battery_exempt" -> listOf(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri),
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            )
            "microphone" -> listOf(appDetails)
            "phone_account" -> {
                RingTelecom.register(context)
                listOf(Intent(TelecomManager.ACTION_CHANGE_PHONE_ACCOUNTS), appDetails)
            }
            // The Do Not Disturb screen has no public action; the sound settings hold it.
            "dnd_allows_calls" -> listOf(Intent("android.settings.ZEN_MODE_SETTINGS"), Intent(Settings.ACTION_SOUND_SETTINGS))
            else -> emptyList()
        }
        for (intent in candidates) {
            try {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (e: ActivityNotFoundException) {
                continue
            } catch (e: SecurityException) {
                continue
            }
        }
        Log.w(TAG, "No settings screen opened for $item")
    }
}
