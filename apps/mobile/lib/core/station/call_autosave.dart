import 'dart:async';

import '../api/api_error.dart';
import '../telemetry/log.dart';
import 'notes_autosave.dart' show NotesStore;
import 'station_view.dart' show NotesStatus, NotesView;

/// A call's autosave onto its own `PATCH` route, debounced while the call is on screen: the
/// soft phone's (notes and call details, `ManualAutosave`) and the inbound call's (notes,
/// `inboundAutosave`), a port of the console's save loop, with the station's notes store.
///
/// * One timer per call: every notes keystroke (and every other edit the request carries,
///   [touchedOther]) re-arms it, and the PATCH goes [debounce] after the last one. What it
///   carries is read when it is SENT ([_request]), not when it was armed.
/// * The notes go only once they are known: the call's own copy, or the agent's typing, or what
///   the store kept. A PATCH with `notes` left out keeps what the server holds; one sent before
///   the text was known would replace it. [_request] may answer null (nothing to send without
///   the notes), and then nothing is sent.
/// * Unsent notes are kept in the station's [NotesStore] under `<prefix>:<id>` (written when the
///   debounce fires, after each confirmed save, and on [persistNow] when the app leaves the
///   foreground), and swept with the station's after a day. A call that comes back on screen (a
///   restart, a reconnect) takes the stored text over the server's, as the station does.
/// * A refusal that cannot get better ([_hopeless]) is not retried; anything else is, every
///   [retryDelay], while the call is on screen (the console's 4× debounce).
/// * Saving the outcome cancels the pending save ([cancelPending]): the outcome carries the same
///   notes, and the PATCH would race it.
class CallAutosave<C, R extends Object> {
  CallAutosave({
    required this._save,
    required this._request,
    required this._store,
    required this._onChanged,
    required this._onSaved,
    required this._keyPrefix,
    required this._hopeless,
    this._onFailed,
    this._now = DateTime.now,
    this.debounce = const Duration(milliseconds: 700),
    this.retryDelay = const Duration(milliseconds: 2800),
    String logTag = 'call.autosave',
  }) : _log = Log(logTag);

  final Log _log;

  /// The call's `PATCH`. Throws an [ApiError] on a refusal.
  final Future<C> Function(String callId, R request) _save;

  /// The body to send now, given the notes to send (null: leave them out); null: nothing to send.
  final R? Function(String? notes) _request;
  final NotesStore _store;
  final void Function() _onChanged;

  /// A save's answer: the row as the server holds it now.
  final void Function(C call) _onSaved;

  /// The store key's prefix: `manual`, `inbound`.
  final String _keyPrefix;

  /// A refusal no retry can fix (the call is settled or gone, the body is invalid, the sign-in
  /// expired).
  final bool Function(ApiError error) _hopeless;
  final void Function(String callId, ApiError error)? _onFailed;
  final DateTime Function() _now;
  final Duration debounce;
  final Duration retryDelay;

  String? _callId;
  String _text = '';

  /// The notes on screen are the call's (or the agent's): safe to send.
  bool _hydrated = false;

  /// The agent edited the notes on this call, so blank means cleared, not never typed.
  bool _touched = false;

  /// The text on screen came from the store (the agent's, from before a restart) and no save has
  /// carried it since: the server's copy is older, so it never replaces it.
  bool _restoredUnsent = false;
  bool _accepting = false;
  Timer? _timer;
  int _inFlight = 0;
  _Failure? _failure;
  DateTime? _lastKeystrokeAt;
  DateTime? _lastSaveSucceededAt;
  bool _disposed = false;
  NotesView _view = const NotesView();

  /// The store key of [callId]'s notes.
  String storeKeyOf(String callId) => '$_keyPrefix:$callId';

  NotesView get view => _view;
  String get text => _text;
  String? get callId => _callId;

  /// The agent edited the notes on this call.
  bool get touched => _touched;

  /// A save is armed (debounce or retry).
  bool get pending => _timer != null;

  /// The call on screen, its notes as the server holds them, and whether its PATCH takes
  /// writes. A new call starts from [serverNotes], unless the store kept unsent text for it.
  void callChanged(String? callId, {String? serverNotes, required bool accepting}) {
    if (_disposed) return;
    if (callId == _callId) {
      var changed = accepting != _accepting;
      _accepting = accepting;
      // Notes the server came to hold (written on another device, or by the server before the
      // first copy carried them) reach a field the agent has not typed in, with nothing of
      // theirs on its way: never over their text, and never over text restored from the store
      // that no save has carried yet (the server's copy is the older one).
      if (callId != null &&
          serverNotes != null &&
          serverNotes != _text &&
          !_touched &&
          !_restoredUnsent &&
          _timer == null &&
          _inFlight == 0) {
        _text = serverNotes;
        _hydrated = true;
        changed = true;
      }
      if (changed) _refresh();
      return;
    }
    final previous = _callId;
    if (previous != null && _touched && _timer != null) unawaited(_persist(previous, _text));
    _timer?.cancel();
    _timer = null;
    _callId = callId;
    _accepting = accepting;
    _touched = false;
    _restoredUnsent = false;
    _failure = null;
    _inFlight = 0;
    _lastKeystrokeAt = null;
    _lastSaveSucceededAt = null;
    _text = callId == null ? '' : (serverNotes ?? '');
    _hydrated = callId != null && serverNotes != null;
    if (callId != null) unawaited(_restore(callId));
    _refresh();
  }

  Future<void> _restore(String callId) async {
    String? restored;
    try {
      restored = await _store.read(storeKeyOf(callId));
    } catch (e) {
      _log.warn('notes restore failed', {'error': e.runtimeType.toString()});
    }
    // An edit made while the read was in flight is the agent's and wins.
    if (_disposed || _callId != callId || _touched) return;
    if (restored != null && restored.isNotEmpty && restored != _text) {
      _text = restored;
      _restoredUnsent = true;
    }
    _hydrated = true;
    _refresh();
  }

  /// Every notes keystroke.
  void editNotes(String value) {
    if (_disposed || _callId == null) return;
    _text = value;
    _touched = true;
    // The agent's own text is the provenance that licenses even a clear.
    _hydrated = true;
    _lastKeystrokeAt = _now();
    _arm(debounce);
    _refresh();
  }

  /// Something else the request carries changed (the soft phone's call fields): the next save
  /// carries it.
  void touchedOther() {
    if (_disposed || _callId == null) return;
    _arm(debounce);
  }

  /// The outcome is being saved with the notes: drop the armed save.
  void cancelPending() {
    _timer?.cancel();
    _timer = null;
  }

  /// The outcome carrying [notes] was saved: the server has them.
  void savedWithOutcome(String callId, String? notes) {
    if (_disposed || callId != _callId) return;
    _lastSaveSucceededAt = _now();
    _failure = null;
    if (notes != null && notes == _text) _restoredUnsent = false;
    if (notes != null) unawaited(_persist(callId, notes));
    _refresh();
  }

  /// The app is leaving the foreground: put the agent's text in the store now.
  Future<void> persistNow() async {
    final id = _callId;
    if (id == null || !_touched) return;
    await _persist(id, _text);
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
  }

  void _arm(Duration after) {
    _timer?.cancel();
    final id = _callId!;
    _timer = Timer(after, () {
      _timer = null;
      if (_touched) unawaited(_persist(id, _text));
      unawaited(_send(id));
    });
  }

  Future<void> _send(String callId) async {
    if (_disposed || _callId != callId) return;
    final notes = _hydrated ? _text : null;
    final request = _request(notes);
    if (request == null) return;
    _inFlight++;
    _refresh();
    try {
      final saved = await _save(callId, request);
      if (_disposed || _callId != callId) return;
      _lastSaveSucceededAt = _now();
      _failure = null;
      // The server now holds what was on screen when this was sent.
      if (notes != null && notes == _text) _restoredUnsent = false;
      if (notes != null && _touched) unawaited(_persist(callId, notes));
      _onSaved(saved);
    } on ApiError catch (e) {
      if (_disposed || _callId != callId) return;
      final hopeless = _hopeless(e);
      _failure = hopeless ? _Failure.terminal : _Failure.retryable;
      // A newer edit has its own save armed; otherwise try again later.
      if (!hopeless && _timer == null) _arm(retryDelay);
      _log.warn('call save failed', {
        'error': e.runtimeType.toString(),
        'code': e is ApiHttpError ? e.code : null,
      });
      _onFailed?.call(callId, e);
    } finally {
      if (!_disposed && _callId == callId) {
        _inFlight = _inFlight > 0 ? _inFlight - 1 : 0;
        _refresh();
      }
    }
  }

  Future<void> _persist(String callId, String value) async {
    try {
      await _store.write(storeKeyOf(callId), value, _now());
    } catch (e) {
      _log.warn('notes persist failed', {'error': e.runtimeType.toString()});
    }
  }

  void _refresh() {
    final next = NotesView(text: _text, status: _status(), savedAt: _lastSaveSucceededAt);
    if (next == _view) return;
    _view = next;
    _onChanged();
  }

  NotesStatus _status() {
    if (!_accepting) return _callId == null ? NotesStatus.idle : NotesStatus.closed;
    final keystroke = _lastKeystrokeAt;
    final saved = _lastSaveSucceededAt;
    final unsaved = keystroke != null && (saved == null || keystroke.isAfter(saved));
    if (_failure == _Failure.terminal) return NotesStatus.failed;
    if (_failure == _Failure.retryable) return NotesStatus.retrying;
    if (unsaved || _inFlight > 0) return NotesStatus.saving;
    if (saved != null) return NotesStatus.saved;
    return NotesStatus.idle;
  }
}

enum _Failure { retryable, terminal }
