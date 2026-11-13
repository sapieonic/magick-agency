package com.magickagency.agent.ring

import android.content.ComponentName
import android.content.Context
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import com.magickagency.agent_audio.CallModeKind
import com.magickagency.agent_audio.callModeKindOf

/**
 * The ring's self-managed Telecom calling account (`MANAGE_OWN_CALLS`): Android treats the ring
 * as a call (the lock screen, a headset's answer button, a car), and the app draws its own UI (the
 * CallStyle notification, [RingActivity]). The call is a placeholder for the ring only; its audio
 * is the station's, started by Flutter after accept.
 */
internal object RingTelecom {
    private const val TAG = "MagickRing"
    private const val ACCOUNT_ID = "magick_agency_ring"
    const val EXTRA_CALL_ID = "com.magickagency.agent.ring.CALL_ID"

    fun handle(context: Context) =
        PhoneAccountHandle(ComponentName(context, RingConnectionService::class.java), ACCOUNT_ID)

    private fun telecom(context: Context): TelecomManager? = context.getSystemService(TelecomManager::class.java)

    /** The account went through [register] in this process: a ring push need not ask Telecom again. */
    @Volatile
    private var registered = false

    /**
     * [register] once per process: Telecom keeps the account across process starts, so a ring push
     * (on its hot path) does not make the `registerPhoneAccount` IPC each time. The checklist
     * ([accountUsable]) still refreshes it whenever the card reads it.
     */
    fun ensureRegistered(context: Context): Boolean = registered || register(context)

    /** Registers (or refreshes) the account; idempotent. False when Telecom refused it. */
    fun register(context: Context): Boolean = try {
        // CAPABILITY_SELF_MANAGED is deprecated as of API 37 (the transactional calling API is
        // the new way); it is what API 28-36 have, and still works there and on 37.
        @Suppress("DEPRECATION")
        val account = PhoneAccount.builder(handle(context), RingCopy.ACCOUNT_LABEL)
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
            .setShortDescription(RingCopy.ACCOUNT_DESCRIPTION)
            .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
            .build()
        val tm = telecom(context)
        tm?.registerPhoneAccount(account)
        (tm != null).also { registered = it }
    } catch (e: RuntimeException) {
        Log.w(TAG, "Registering the calling account failed: ${e.javaClass.simpleName}")
        false
    }

    /** The checklist's `phone_account`: registered, and enabled (a self-managed account is enabled on registration). */
    fun accountUsable(context: Context): Boolean {
        if (!register(context)) return false
        return try {
            telecom(context)?.getPhoneAccount(handle(context))?.isEnabled == true
        } catch (e: SecurityException) {
            // Some builds refuse the read; registration went through, which is what the ring needs.
            true
        }
    }

    /**
     * IQ70: what the phone says about calls, for the state machine's "busy on the phone"
     * ([PhoneSignals.busy]): the audio mode (a cellular call's, or the ringtone's) and whether
     * Telecom permits an incoming call on our account. Our own ring can raise the last two itself,
     * which is why the state machine, knowing whether ours rings, decides.
     */
    fun phoneSignals(context: Context): PhoneSignals {
        val am = context.getSystemService(AudioManager::class.java)
        // agent_audio's own classification of the audio mode (its `phone_call` pause reads the same).
        val kind = callModeKindOf(am?.mode ?: AudioManager.MODE_NORMAL, Build.VERSION.SDK_INT)
        val notPermitted = ensureRegistered(context) && try {
            telecom(context)?.isIncomingCallPermitted(handle(context)) == false
        } catch (e: RuntimeException) {
            false
        }
        return PhoneSignals(
            inCellularCall = kind == CallModeKind.CELLULAR,
            ringtoneMode = kind == CallModeKind.RINGTONE,
            incomingNotPermitted = notPermitted,
        )
    }

    /** Asks Telecom for the incoming call; false when it could not be asked (the ring then shows by notification alone). */
    fun addIncoming(context: Context, callId: String): Boolean {
        if (!ensureRegistered(context)) return false
        val extras = Bundle().apply {
            putString(EXTRA_CALL_ID, callId)
            putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, Bundle().apply { putString(EXTRA_CALL_ID, callId) })
        }
        return try {
            val tm = telecom(context) ?: return false
            tm.addNewIncomingCall(handle(context), extras)
            true
        } catch (e: RuntimeException) {
            Log.w(TAG, "Telecom refused the incoming call: ${e.javaClass.simpleName}")
            false
        }
    }

    fun callIdOf(request: ConnectionRequest?): String? {
        val extras = request?.extras ?: return null
        return extras.getString(EXTRA_CALL_ID)
            ?: extras.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS)?.getString(EXTRA_CALL_ID)
    }

    fun disconnectCause(cause: EndCause): DisconnectCause = DisconnectCause(
        when (cause) {
            EndCause.LOCAL -> DisconnectCause.LOCAL
            EndCause.REMOTE -> DisconnectCause.REMOTE
            EndCause.REJECTED -> DisconnectCause.REJECTED
            EndCause.MISSED -> DisconnectCause.MISSED
            EndCause.CANCELED -> DisconnectCause.CANCELED
            EndCause.ANSWERED_ELSEWHERE -> DisconnectCause.ANSWERED_ELSEWHERE
            EndCause.BUSY -> DisconnectCause.BUSY
            EndCause.ERROR -> DisconnectCause.ERROR
        },
    )
}

/** Telecom binds this for the ring's calls. No foreground service: the ring is Telecom plus the notification. */
class RingConnectionService : ConnectionService() {
    override fun onCreateIncomingConnection(handle: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        val callId = RingTelecom.callIdOf(request)
            ?: return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR))
        val connection = RingConnection(callId).apply {
            connectionProperties = Connection.PROPERTY_SELF_MANAGED
            audioModeIsVoip = true
            // IQ61: no caller name or number reaches the phone before accept.
            setAddress(Uri.fromParts(PhoneAccount.SCHEME_SIP, "magick-agency", null), TelecomManager.PRESENTATION_ALLOWED)
            setCallerDisplayName(RingCopy.INCOMING_TITLE, TelecomManager.PRESENTATION_ALLOWED)
            setRinging()
        }
        RingCoordinator.onConnectionCreated(applicationContext, callId, connection)
        return connection
    }

    override fun onCreateIncomingConnectionFailed(handle: PhoneAccountHandle?, request: ConnectionRequest?) {
        val callId = RingTelecom.callIdOf(request) ?: return
        RingCoordinator.onIncomingRefused(applicationContext, callId)
    }
}

/** One ring's Telecom call. Every callback hands over to [RingCoordinator] (Telecom calls them on the main thread). */
class RingConnection(val callId: String) : Connection() {
    override fun onShowIncomingCallUi() = RingCoordinator.onShowIncomingUi(callId)

    override fun onAnswer() = RingCoordinator.onTelecomAnswer(callId)

    override fun onReject() = RingCoordinator.onTelecomReject(callId)

    override fun onDisconnect() = RingCoordinator.onTelecomDisconnect(callId)

    override fun onAbort() = RingCoordinator.onTelecomDisconnect(callId)

    override fun onSilence() = RingCoordinator.onSilence(callId)
}
