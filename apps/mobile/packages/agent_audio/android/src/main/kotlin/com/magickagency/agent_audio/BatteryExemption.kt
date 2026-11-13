package com.magickagency.agent_audio

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * Battery optimisation off for this app: the on-duty service's (`requestIgnoreBatteryOptimizations`)
 * and the ring checklist's Fix (the app module's `RingSettings`) open the same prompt.
 */
object BatteryExemption {
    fun isExempt(context: Context): Boolean =
        (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName)

    /**
     * Opens the system's prompt to exempt this app, from [activity] when there is one (in its task),
     * else in a new task. Some OEM builds remove the direct prompt: the battery optimisation list
     * opens instead. True when the app is already exempt or a screen opened.
     */
    fun request(context: Context, activity: Activity?): Boolean {
        if (isExempt(context)) return true
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        for (intent in listOf(direct, list)) {
            try {
                if (activity != null) activity.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (_: ActivityNotFoundException) {
                // Fall through to the list screen.
            } catch (_: SecurityException) {
            }
        }
        return false
    }
}
