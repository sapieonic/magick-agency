import 'dart:async';
import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/api_error.dart';
import '../telemetry/log.dart';
import 'station_view.dart';

/// Where unsent notes survive a process death until the server has them.
abstract interface class NotesStore {
  Future<String?> read(String attemptId);
  Future<void> write(String attemptId, String notes, DateTime at);
  Future<void> delete(String attemptId);

  /// Drops entries older than [maxAge]: a day of calls must not accumulate forever.
  Future<void> sweep(DateTime now, {Duration maxAge});
}

/// Notes in the platform keystore/keychain: they can hold what a customer
/// said, so they are never written to plain storage.
final class SecureNotesStore implements NotesStore {
  SecureNotesStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  static const _prefix = 'agency.notes.';

  @override
  Future<String?> read(String attemptId) async {
    final raw = await _storage.read(key: '$_prefix$attemptId');
    if (raw == null) return null;
    try {
      final j = jsonDecode(raw);
      return j is Map<String, Object?> && j['notes'] is String ? j['notes']! as String : null;
    } on FormatException {
      return null;
    }
  }

  @override
  Future<void> write(String attemptId, String notes, DateTime at) => _storage.write(
        key: '$_prefix$attemptId',
        value: jsonEncode({'notes': notes, 'at': at.millisecondsSinceEpoch}),
      );

  @override
  Future<void> delete(String attemptId) => _storage.delete(key: '$_prefix$attemptId');

  @override
  Future<void> sweep(DateTime now, {Duration maxAge = const Duration(hours: 24)}) async {
    final all = await _storage.readAll();
    for (final e in all.entries) {
      if (!e.key.startsWith(_prefix)) continue;
      var keep = false;
      try {
        final j = jsonDecode(e.value);
        final at = j is Map<String, Object?> ? j['at'] : null;
        keep = at is int && now.millisecondsSinceEpoch - at < maxAge.inMilliseconds;
      } on FormatException {
        keep = false;
      }
      if (!keep) await _storage.delete(key: e.key);
    }
  }
}

/// In memory only (tests, and builds without a keystore).
final class MemoryNotesStore implements NotesStore {
  final Map<String, ({String notes, DateTime at})> entries = {};

  @override
  Future<String?> read(String attemptId) async => entries[attemptId]?.notes;

  @override
  Future<void> write(String attemptId, String notes, DateTime at) async => entries[attemptId] = (notes: notes, at: at);

  @override
  Future<void> delete(String attemptId) async => entries.remove(attemptId);

  @override
  Future<void> sweep(DateTime now, {Duration maxAge = const Duration(hours: 24)}) async =>
      entries.removeWhere((_, v) => now.difference(v.at) >= maxAge);
}

/// The notes field's autosave (port of the console's `useAgencyNotes` and the
/// status rules of `agencyNotes.ts`), keyed by attempt throughout.
///
/// * Every keystroke updates memory; the save goes [debounce] after the last
///   one, to `POST /attempts/:id/notes`, keyed on the attempt that was on
///   screen WHEN THE AGENT TYPED: a timer from call A that fires after call B
///   was reserved must write A's notes to A.
/// * A new attempt FLUSHES the pending save rather than cancelling it: the last
///   two seconds of typing are the outcome being written down.
/// * Unsent text stays in memory and in [NotesStore] until the server has it
///   (written when the debounce fires, and on [persistNow] when the app leaves
///   the foreground), then is cleared.
/// * Nothing saves before the attempt's text is hydrated: a save racing the
///   restore would send `''`, which clears the server's copy wholesale.
/// * Mobile addition: a network failure is retried ([retryDelays]) before it
///   is reported as failed; the console has no retry.
class NotesAutosave {
  NotesAutosave({
    required this._save,
    required this._store,
    required this._onChanged,
    this._now = DateTime.now,
    this.debounce = const Duration(seconds: 2),
    this.retryDelays = const [Duration(seconds: 3), Duration(seconds: 10)],
  });

  static final _log = Log('station.notes');

  /// `POST /attempts/:id/notes`: (attemptId, notes).
  final Future<NotesResponse> Function(String attemptId, String notes) _save;
  final NotesStore _store;
  final void Function() _onChanged;
  final DateTime Function() _now;
  final Duration debounce;
  final List<Duration> retryDelays;

  /// Text not yet confirmed saved, per attempt.
  final Map<String, String> _unsent = {};

  String? _attemptId;
  String _text = '';
  bool _hydrated = false;
  bool _accepting = false;
  DateTime? _lastKeystrokeAt;
  DateTime? _lastSaveSucceededAt;
  int _inFlight = 0;
  _Failure? _failure;
  bool _foreignWrite = false;
  Timer? _debounceTimer;
  ({String attemptId, String value})? _pending;
  final Map<String, Timer> _retryTimers = {};
  bool _disposed = false;
  NotesView _view = const NotesView();

  NotesView get view => _view;
  String get text => _text;
  String? get attemptId => _attemptId;

  /// Whether the agent has typed anything the server does not have yet.
  bool get hasUnsent => _unsent.isNotEmpty;

  /// The attempt on screen and whether its notes route takes writes now.
  void attemptChanged(String? attemptId, {required bool accepting}) {
    if (_disposed) return;
    if (attemptId == _attemptId) {
      if (accepting != _accepting) {
        _accepting = accepting;
        _refresh();
      }
      return;
    }
    // Flush, never cancel, the save the debounce is holding for the old attempt.
    final pending = _pending;
    _debounceTimer?.cancel();
    _debounceTimer = null;
    _pending = null;
    if (pending != null) unawaited(_flush(pending));

    _attemptId = attemptId;
    _accepting = accepting;
    _lastKeystrokeAt = null;
    _lastSaveSucceededAt = null;
    _failure = null;
    _foreignWrite = false;
    _inFlight = 0;
    if (attemptId == null) {
      _text = '';
      _hydrated = false;
    } else if (_unsent.containsKey(attemptId)) {
      _text = _unsent[attemptId]!;
      _hydrated = true;
    } else {
      _text = '';
      _hydrated = false;
      unawaited(_restore(attemptId));
    }
    _refresh();
  }

  Future<void> _restore(String attemptId) async {
    String? restored;
    try {
      restored = await _store.read(attemptId);
    } catch (e) {
      _log.warn('notes restore failed', {'error': e.runtimeType.toString()});
    }
    // An edit made while the read was in flight is the agent's and wins.
    if (_disposed || _attemptId != attemptId || _hydrated) return;
    _text = restored ?? '';
    if (restored != null && restored.isNotEmpty) _unsent[attemptId] = restored;
    _hydrated = true;
    _refresh();
  }

  /// Every keystroke.
  void edit(String value) {
    if (_disposed) return;
    final attemptId = _attemptId;
    _text = value;
    _lastKeystrokeAt = _now();
    if (attemptId == null) {
      _refresh();
      return;
    }
    // The agent's own text is the provenance that licenses even a clear.
    _hydrated = true;
    _unsent[attemptId] = value;
    _debounceTimer?.cancel();
    final pending = (attemptId: attemptId, value: value);
    _pending = pending;
    _debounceTimer = Timer(debounce, () {
      _debounceTimer = null;
      _pending = null;
      unawaited(_persist(pending.attemptId, pending.value));
      unawaited(_flush(pending));
    });
    _refresh();
  }

  /// The app is leaving the foreground: put unsent text in the store now.
  Future<void> persistNow() async {
    for (final e in _unsent.entries.toList()) {
      await _persist(e.key, e.value);
    }
  }

  /// The disposition (which carries the notes) was saved: forget them.
  void savedWithDisposition(String attemptId) {
    _unsent.remove(attemptId);
    _retryTimers.remove(attemptId)?.cancel();
    if (_pending?.attemptId == attemptId) {
      _debounceTimer?.cancel();
      _debounceTimer = null;
      _pending = null;
    }
    unawaited(_deleteStored(attemptId));
  }

  void dispose() {
    _disposed = true;
    _debounceTimer?.cancel();
    for (final t in _retryTimers.values) {
      t.cancel();
    }
    _retryTimers.clear();
  }

  Future<void> _persist(String attemptId, String value) async {
    try {
      await _store.write(attemptId, value, _now());
    } catch (e) {
      _log.warn('notes persist failed', {'error': e.runtimeType.toString()});
    }
  }

  Future<void> _deleteStored(String attemptId) async {
    try {
      await _store.delete(attemptId);
    } catch (_) {}
  }

  Future<void> _flush(({String attemptId, String value}) pending, {int attempt = 0}) async {
    if (_disposed) return;
    final attemptId = pending.attemptId;
    bool current() => _attemptId == attemptId;
    _retryTimers.remove(attemptId)?.cancel();
    if (current()) {
      _inFlight += 1;
      _refresh();
    }
    try {
      final response = await _save(attemptId, pending.value);
      if (_disposed) return;
      // Cleared only when nothing newer was typed since this was sent.
      if (_unsent[attemptId] == pending.value) {
        _unsent.remove(attemptId);
        unawaited(_deleteStored(attemptId));
      }
      if (current()) {
        _lastSaveSucceededAt = _now();
        _failure = null;
        // Against what was SENT, never the live field.
        _foreignWrite = response.notes != pending.value;
      }
    } on ApiError catch (e) {
      if (_disposed) return;
      final retryable = e is ApiNetworkError || (e is ApiHttpError && e.isServerError);
      if (retryable && attempt < retryDelays.length) {
        if (current()) _failure = _Failure.retryable;
        _retryTimers[attemptId] = Timer(retryDelays[attempt], () {
          _retryTimers.remove(attemptId);
          // A newer keystroke has its own save coming.
          if (_pending?.attemptId == attemptId) return;
          final latest = _unsent[attemptId];
          if (latest == null) return;
          unawaited(_flush((attemptId: attemptId, value: latest), attempt: attempt + 1));
        });
      } else {
        if (current()) _failure = _Failure.terminal;
        _log.warn('notes save failed', {'error': e.runtimeType.toString()});
      }
    } finally {
      if (!_disposed && current()) {
        _inFlight = _inFlight > 0 ? _inFlight - 1 : 0;
        _refresh();
      }
    }
  }

  void _refresh() {
    final next = NotesView(
      text: _text,
      status: _status(),
      changedElsewhere: _foreignWrite,
      savedAt: _lastSaveSucceededAt,
    );
    if (next == _view) return;
    _view = next;
    _onChanged();
  }

  NotesStatus _status() {
    final keystroke = _lastKeystrokeAt;
    final saved = _lastSaveSucceededAt;
    final unsaved = keystroke != null && (saved == null || keystroke.isAfter(saved));
    if (!_accepting) return _attemptId == null ? NotesStatus.idle : NotesStatus.closed;
    // A failure outranks the keystroke comparison.
    if (_failure == _Failure.terminal) return NotesStatus.failed;
    if (_failure == _Failure.retryable) return NotesStatus.retrying;
    if (unsaved || _inFlight > 0) return NotesStatus.saving;
    if (saved != null) return NotesStatus.saved;
    return NotesStatus.idle;
  }
}

enum _Failure { retryable, terminal }
