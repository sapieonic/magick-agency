import 'package:agency_wire/agency_wire.dart';

import '../api/api_error.dart';
import '../softphone/call_state.dart';
import '../softphone/softphone_host.dart';
import '../telemetry/log.dart';
import 'station_copy.dart';

final _log = Log('station.softphone');

/// Closes the agent's soft-phone session so something else can open: a port
/// of the console's `closeSoftphoneSession`. The campaign join's "Close the
/// soft phone and join" and the soft phone's own close both run this, so they
/// decide alike.
///
/// ── Never closing over a call ───────────────────────────────────────────────
/// The server refuses `leave` while a soft-phone call is LIVE (409
/// `agent_on_live_call`), but not while an ended call waits for its outcome:
/// that one would lapse to "no outcome" with the session. So the soft phone's
/// bootstrap is read first, and a call there, live or owed, stops the close. A
/// bootstrap that cannot be read (offline, a server fault) does not block: the
/// server still guards the live call. The app adds one guard the console has
/// no need of: when the bootstrap cannot be read and the session is the one
/// this phone hosts, the call it holds (from the socket's frames) still stops
/// the close.
///
/// ── The session's own account ───────────────────────────────────────────────
/// One live session per agent (across tenants, OS1), so the session may be in a sibling
/// account. The bootstrap names the agent's session tenant-wide with its
/// account, but reads its call only in the account asked, and `leave` is
/// scoped to the session's account: both go with [sessionAccountId] (the
/// refusal's), else [currentAccountId], and the bootstrap's
/// `session.account_id` decides when it names the session.
///
/// Returns what happened and the session it was about ([closedId] is the
/// session left, or null when nothing was).
Future<({SoftphoneCloseResult result, String? closedId})> closeSoftphoneSession({
  required Future<SoftphoneBootstrap> Function(String? accountId) readBootstrap,
  required Future<void> Function(String sessionId, String? accountId) leave,
  required String? currentAccountId,
  String? sessionId,
  String? sessionAccountId,
  ManualCall? Function(String sessionId)? heldCall,
}) async {
  var id = sessionId == null || sessionId.isEmpty ? null : sessionId;
  var account = sessionAccountId ?? currentAccountId;
  var bootstrapRead = false;
  try {
    var phone = await readBootstrap(account);
    final s = phone.session;
    final held = s != null && s.kind == SessionKind.softphone && (id == null || s.sessionId == id) ? s : null;
    if (held != null) {
      id = held.sessionId;
      if (held.accountId != account) {
        account = held.accountId;
        phone = await readBootstrap(account);
      }
    }
    bootstrapRead = true;
    final call = phone.call;
    if (call != null) return (result: SoftphoneCloseCallPending(call: call), closedId: null);
  } on ApiError catch (e) {
    // See above: unreadable is not a reason to keep the agent out.
    _log.warn('soft-phone bootstrap unreadable before closing', {'error': e.runtimeType.toString()});
  }
  if (id == null) return (result: const SoftphoneCloseNoSession(), closedId: null);
  if (!bootstrapRead) {
    final local = heldCall?.call(id);
    if (isCallUnsettled(local)) return (result: SoftphoneCloseCallPending(call: local), closedId: null);
  }

  try {
    await leave(id, account);
  } on ApiError catch (e) {
    final code = e is ApiHttpError ? e.code : null;
    if (code == AgencyErrorCode.agentOnLiveCall.wire || code == SoftphoneErrorCode.manualCallLive.wire) {
      final call = e is ApiHttpError ? ErrorBody.fromJson(e.body).callPending?.call : null;
      return (result: SoftphoneCloseCallPending(call: call), closedId: null);
    }
    final gone = e is ApiHttpError && (e.status == 404 || e.code == AgencyErrorCode.sessionEnded.wire);
    if (!gone) return (result: SoftphoneCloseFailed(softphoneStillOpenCopy(errorDetail(e))), closedId: null);
  }
  return (result: const SoftphoneClosed(), closedId: id);
}
