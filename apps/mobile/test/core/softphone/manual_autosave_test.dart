import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/softphone/manual_autosave.dart';
import 'package:magick_agency_agent/core/station/notes_autosave.dart' show NotesStore;
import 'package:magick_agency_agent/core/station/station_view.dart';

import '../station/memory_notes_store.dart';
import 'manual_calls.dart';

/// The soft-phone call's autosave: the debounce, what each PATCH carries, the
/// notes kept on the phone under `manual:<id>`, and which failures are retried.
void main() {
  late List<({String callId, ManualCallUpdateRequest request})> sent;
  late List<ManualCall> saved;
  late List<String> failed;
  late MemoryNotesStore store;
  late Object? Function() answer;
  late bool fieldsKnown;

  ManualAutosave make(FakeAsync async) {
    final clock = async.getClock(DateTime.utc(2026, 10, 30, 10));
    return ManualAutosave(
      save: (id, request) async {
        sent.add((callId: id, request: request));
        final a = answer();
        if (a is ApiError) throw a;
        return manualCall({'id': id, 'state': 'bridged', 'notes': request.notes});
      },
      request: (notes) => fieldsKnown
          ? ManualCallUpdateRequest(fields: const {'customer_name': 'Rahul'}, notes: notes)
          : ManualCallUpdateRequest(notes: notes),
      store: store,
      onChanged: () {},
      onSaved: saved.add,
      onFailed: (id, _) => failed.add(id),
      now: clock.now,
    );
  }

  setUp(() {
    sent = [];
    saved = [];
    failed = [];
    store = MemoryNotesStore();
    answer = () => null;
    fieldsKnown = true;
  });

  ApiHttpError refusal(String code, {int status = 409}) =>
      ApiHttpError(status: status, code: code, message: code, body: {'code': code, 'message': code}, requestId: null);

  test('sends 700 ms after the last keystroke, once, with what is on screen then', () {
    fakeAsync((async) {
      final a = make(async)..callChanged('mc-1', serverNotes: null, accepting: true);
      async.flushMicrotasks();
      a.editNotes('Cust');
      async.elapse(const Duration(milliseconds: 500));
      a.editNotes('Customer wants');
      async.elapse(const Duration(milliseconds: 699));
      expect(sent, isEmpty);
      async.elapse(const Duration(milliseconds: 1));
      async.flushMicrotasks();
      expect(sent, hasLength(1));
      expect(sent.single.request.toJson(), {
        'fields': {'customer_name': 'Rahul'},
        'notes': 'Customer wants',
      });
      expect(saved, hasLength(1));
      expect(a.view.status, NotesStatus.saved);
    });
  });

  test('a field edit arms the same save, and the body is built when it is SENT', () {
    fakeAsync((async) {
      fieldsKnown = false;
      final a = make(async)..callChanged('mc-1', serverNotes: 'From the server', accepting: true);
      async.flushMicrotasks();
      a.fieldsChanged();
      // The field set lands before the debounce fires: the save carries the fields.
      fieldsKnown = true;
      async.elapse(const Duration(milliseconds: 700));
      async.flushMicrotasks();
      expect(sent.single.request.toJson(), {
        'fields': {'customer_name': 'Rahul'},
        'notes': 'From the server',
      });
    });
  });

  test('leaves the notes out until they are known, so a save never blanks the server’s copy', () {
    fakeAsync((async) {
      final pendingRead = Completer<String?>();
      final slow = _SlowStore(pendingRead.future);
      final a = ManualAutosave(
        save: (id, request) async {
          sent.add((callId: id, request: request));
          return manualCall({'id': id});
        },
        request: (notes) => ManualCallUpdateRequest(fields: const {}, notes: notes),
        store: slow,
        onChanged: () {},
        onSaved: saved.add,
      )..callChanged('mc-1', accepting: true);
      a.fieldsChanged();
      async.elapse(const Duration(milliseconds: 700));
      async.flushMicrotasks();
      expect(sent.single.request.toJson().containsKey('notes'), isFalse);
      pendingRead.complete(null);
      async.flushMicrotasks();
    });
  });

  test('keeps unsent notes on the phone under manual:<id>, and a call back on screen takes them', () {
    fakeAsync((async) {
      answer = () => const ApiNetworkError('offline');
      final a = make(async)..callChanged('mc-1', serverNotes: null, accepting: true);
      async.flushMicrotasks();
      a.editNotes('Promised a callback');
      async.elapse(const Duration(milliseconds: 700));
      async.flushMicrotasks();
      expect(store.entries['manual:mc-1']?.notes, 'Promised a callback');
      expect(a.view.status, NotesStatus.retrying);
      a.dispose();

      // A restart: the call comes back with the server's (older) notes.
      final b = make(async)..callChanged('mc-1', serverNotes: 'Older', accepting: true);
      async.flushMicrotasks();
      expect(b.text, 'Promised a callback');
    });
  });

  test('persistNow puts the agent’s text in the store at once (the app leaving the foreground)', () {
    fakeAsync((async) {
      final a = make(async)..callChanged('mc-1', accepting: true);
      async.flushMicrotasks();
      a.editNotes('Half a sentence');
      unawaited(a.persistNow());
      async.flushMicrotasks();
      expect(store.entries['manual:mc-1']?.notes, 'Half a sentence');
      expect(sent, isEmpty);
    });
  });

  test('retries a failure that may pass, every 2.8 s while the call is on screen', () {
    fakeAsync((async) {
      var fails = 2;
      answer = () => fails-- > 0 ? const ApiNetworkError('offline') : null;
      final a = make(async)..callChanged('mc-1', accepting: true);
      async.flushMicrotasks();
      a.editNotes('Notes');
      async.elapse(const Duration(milliseconds: 700));
      async.flushMicrotasks();
      expect(sent, hasLength(1));
      async.elapse(const Duration(milliseconds: 2800));
      async.flushMicrotasks();
      expect(sent, hasLength(2));
      async.elapse(const Duration(milliseconds: 2800));
      async.flushMicrotasks();
      expect(sent, hasLength(3));
      expect(a.view.status, NotesStatus.saved);
      async.elapse(const Duration(seconds: 30));
      expect(sent, hasLength(3));
    });
  });

  test('does not retry a refusal that cannot get better', () {
    for (final code in ['call_settled', 'call_not_found', 'fields_invalid']) {
      fakeAsync((async) {
        sent.clear();
        answer = () => refusal(code);
        final a = make(async)..callChanged('mc-1', accepting: true);
        async.flushMicrotasks();
        a.editNotes('Notes');
        async.elapse(const Duration(milliseconds: 700));
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 30));
        expect(sent, hasLength(1), reason: code);
        expect(a.view.status, NotesStatus.failed, reason: code);
      });
    }
    expect(failed, hasLength(3));
  });

  test('a 403 is not retried; a 401 is, on the slow backoff (each retry refreshes the token), until it goes through',
      () {
    fakeAsync((async) {
      answer = () => refusal('forbidden', status: 403);
      final a = make(async)..callChanged('mc-1', accepting: true);
      async.flushMicrotasks();
      a.editNotes('Notes');
      async.elapse(const Duration(milliseconds: 700));
      async.elapse(const Duration(minutes: 2));
      expect(sent, hasLength(1), reason: 'the role does not allow it: asking again gets the same answer');
      expect(a.view.status, NotesStatus.failed);
    });
    fakeAsync((async) {
      sent.clear();
      var fails = 5;
      answer = () => fails-- > 0 ? const ApiUnauthorized() : null;
      final a = make(async)..callChanged('mc-1', accepting: true);
      async.flushMicrotasks();
      a.editNotes('Notes');
      async.elapse(const Duration(milliseconds: 700));
      expect(sent, hasLength(1));
      expect(a.view.status, NotesStatus.retrying, reason: 'an expired sign-in never drops the notes');
      // 4, 8, 16, 30, 30 s.
      for (final (wait, count) in [(4, 2), (8, 3), (16, 4), (30, 5)]) {
        async.elapse(Duration(seconds: wait) - const Duration(milliseconds: 100));
        expect(sent, hasLength(count - 1), reason: 'not before $wait s');
        async.elapse(const Duration(milliseconds: 100));
        expect(sent, hasLength(count));
      }
      async.elapse(const Duration(seconds: 30));
      expect(sent, hasLength(6));
      expect(a.view.status, NotesStatus.saved);
    });
  });

  test('cancelPending drops the armed save (the outcome carries the same notes)', () {
    fakeAsync((async) {
      final a = make(async)..callChanged('mc-1', accepting: true);
      async.flushMicrotasks();
      a.editNotes('Notes');
      expect(a.pending, isTrue);
      a.cancelPending();
      async.elapse(const Duration(seconds: 5));
      expect(sent, isEmpty);
      a.savedWithOutcome('mc-1', 'Notes');
      async.flushMicrotasks();
      expect(a.view.status, NotesStatus.saved);
      expect(store.entries['manual:mc-1']?.notes, 'Notes');
    });
  });

  test('a new call drops the old one’s timer and starts from its own notes; touched resets', () {
    fakeAsync((async) {
      final a = make(async)..callChanged('mc-1', accepting: true);
      async.flushMicrotasks();
      a.editNotes('For the first call');
      expect(a.touched, isTrue);
      a.callChanged('mc-2', serverNotes: 'Second call notes', accepting: true);
      async.flushMicrotasks();
      async.elapse(const Duration(seconds: 2));
      expect(sent, isEmpty);
      expect(a.text, 'Second call notes');
      expect(a.touched, isFalse);
      // The first call's typing was kept on the phone.
      expect(store.entries['manual:mc-1']?.notes, 'For the first call');
      a.callChanged(null, accepting: false);
      expect(a.text, '');
      expect(a.view.status, NotesStatus.idle);
      // Nothing to type into without a call.
      a.editNotes('ignored');
      expect(a.text, '');
    });
  });
}

class _SlowStore implements NotesStore {
  _SlowStore(this._read);
  final Future<String?> _read;

  @override
  Future<String?> read(String attemptId) => _read;

  @override
  Future<void> write(String attemptId, String notes, DateTime at) async {}

  @override
  Future<void> sweep(DateTime now, {Duration maxAge = const Duration(hours: 24)}) async {}
}
