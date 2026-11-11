import 'package:agency_wire/agency_wire.dart';

import '../api/api_error.dart';
import '../station/call_autosave.dart';

/// The soft-phone call's autosave: its notes and its call details, debounced onto
/// `PATCH /softphone/calls/:id` while the call is on screen (a port of the console's
/// `useSoftphone` save loop, with the station's notes store). The rules are [CallAutosave]'s;
/// what is the soft phone's own:
///
/// * the request carries the call fields too ([fieldsChanged] re-arms the save), and is built
///   when it is SENT: a save armed before the field set arrived may fire after it, and then it
///   carries the fields;
/// * unsent notes are kept under `manual:<id>` ([storeKey]);
/// * a refusal of the call's own that cannot get better (`call_settled`, `call_not_found`,
///   `fields_invalid`) is not retried; a 403 and a 401 follow [CallAutosave]'s rule (a 403 is
///   not retried, a 401 is, on the slow backoff).
class ManualAutosave extends CallAutosave<ManualCall, ManualCallUpdateRequest> {
  ManualAutosave({
    required super.save,
    required super.request,
    required super.store,
    required super.onChanged,
    required super.onSaved,
    super.onFailed,
    super.now,
    super.debounce,
    super.retryDelay,
  }) : super(keyPrefix: 'manual', hopeless: _hopeless, logTag: 'softphone.autosave');

  /// The store key of a manual call's notes (beside the station's attempt ids).
  static String storeKey(String callId) => 'manual:$callId';

  static bool _hopeless(ApiError e) {
    final code = e is ApiHttpError ? ErrorBody.fromJson(e.body).softphoneCode : null;
    return code == SoftphoneErrorCode.callSettled ||
        code == SoftphoneErrorCode.callNotFound ||
        code == SoftphoneErrorCode.fieldsInvalid;
  }

  /// A call field changed: the next save carries the fields.
  void fieldsChanged() => touchedOther();
}
