import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/station/call_autosave.dart';
import 'package:magick_agency_agent/core/station/station_view.dart' show NotesStatus;

import '../inbound/inbound_fixtures.dart';
import 'memory_notes_store.dart';

/// The inbound call's use of the shared call autosave (the soft phone's own rules are in
/// `manual_autosave_test.dart`): its store key, a request that needs the notes, and notes the
/// server came to hold reaching a field the agent has not typed in.
void main() {
  late List<String?> sent;
  late MemoryNotesStore store;

  CallAutosave<InboundCall, InboundCallUpdateRequest> make(FakeAsync async) {
    final clock = async.getClock(DateTime.utc(2026, 11, 2, 5, 31));
    return CallAutosave<InboundCall, InboundCallUpdateRequest>(
      save: (id, request) async {
        sent.add(request.notes);
        return inboundCall('inbound_call_connected', overrides: {'notes': request.notes});
      },
      request: (notes) => notes == null ? null : InboundCallUpdateRequest(notes: notes),
      store: store,
      onChanged: () {},
      onSaved: (_) {},
      keyPrefix: 'inbound',
      hopeless: (e) => e is ApiUnauthorized,
      now: clock.now,
    );
  }

  setUp(() {
    sent = [];
    store = MemoryNotesStore();
  });

  test('unsent text is kept under inbound:<id>, and restored over the server\'s on return', () {
    fakeAsync((async) {
      final a = make(async)..callChanged('ib-1', serverNotes: null, accepting: true);
      async.flushMicrotasks();
      a.editNotes('Wants a quote');
      async.elapse(const Duration(milliseconds: 700));
      expect(store.entries['inbound:ib-1']?.notes, 'Wants a quote');
      expect(sent, ['Wants a quote']);
      final b = make(async)..callChanged('ib-1', serverNotes: 'older', accepting: true);
      async.flushMicrotasks();
      expect(b.text, 'Wants a quote');
    });
  });

  test('restored unsent text survives later restatements of the same call (app restart)', () {
    fakeAsync((async) {
      // What a killed app leaves: the agent's text stored, its PATCH never landed, so the
      // server still holds 'abc'.
      store.entries['inbound:ib-1'] = (notes: 'abc def', at: DateTime.utc(2026, 11, 2, 5, 30));
      final b = make(async)..callChanged('ib-1', serverNotes: 'abc', accepting: true);
      async.flushMicrotasks();
      expect(b.text, 'abc def');
      // Every later station change re-reports the same row with the server's older copy.
      b.callChanged('ib-1', serverNotes: 'abc', accepting: true);
      b.callChanged('ib-1', serverNotes: 'abc', accepting: false);
      expect(b.text, 'abc def');
      // A copy the server CHANGES to still never replaces restored text no save has carried.
      b.callChanged('ib-1', serverNotes: 'from elsewhere', accepting: false);
      expect(b.text, 'abc def');
    });
  });

  test('notes the server came to hold reach an untouched field, never over the agent\'s typing', () {
    fakeAsync((async) {
      final a = make(async)..callChanged('ib-1', serverNotes: null, accepting: true);
      async.flushMicrotasks();
      a.callChanged('ib-1', serverNotes: 'From the web console', accepting: true);
      expect(a.text, 'From the web console');
      a.editNotes('Mine');
      a.callChanged('ib-1', serverNotes: 'Theirs', accepting: true);
      expect(a.text, 'Mine');
    });
  });

  group('the outcome carried the notes, or did not', () {
    test('refused after cancelPending: the last keystrokes go by the notes\' route, the status settles', () {
      fakeAsync((async) {
        final a = make(async)..callChanged('ib-1', serverNotes: '', accepting: true);
        async.flushMicrotasks();
        a.editNotes('wants a callback');
        async.elapse(const Duration(milliseconds: 300));
        a.cancelPending();
        async.elapse(const Duration(seconds: 2));
        expect(sent, isEmpty, reason: 'the outcome is carrying them');
        expect(a.view.status, NotesStatus.saving);
        a.outcomeRefused('ib-1');
        async.elapse(const Duration(milliseconds: 700));
        expect(sent, ['wants a callback']);
        expect(a.view.status, NotesStatus.saved);
      });
    });

    test('refused with nothing unsent, or for another call: nothing is sent', () {
      fakeAsync((async) {
        final a = make(async)..callChanged('ib-1', serverNotes: '', accepting: true);
        async.flushMicrotasks();
        a.outcomeRefused('ib-1');
        a.editNotes('noted');
        async.elapse(const Duration(milliseconds: 700));
        expect(sent, ['noted']);
        a.cancelPending();
        a.outcomeRefused('ib-1');
        a.outcomeRefused('ib-2');
        async.elapse(const Duration(seconds: 2));
        expect(sent, ['noted'], reason: 'the server already has them');
      });
    });

    test('flushNow sends what is unsent at once, and nothing when all is saved', () {
      fakeAsync((async) {
        final a = make(async)..callChanged('ib-1', serverNotes: '', accepting: true);
        async.flushMicrotasks();
        a.editNotes('last words');
        async.elapse(const Duration(milliseconds: 100));
        unawaited(a.flushNow(timeout: const Duration(seconds: 2)));
        async.flushMicrotasks();
        expect(sent, ['last words']);
        expect(a.pending, isFalse, reason: 'the debounce was spent on the flush');
        unawaited(a.flushNow(timeout: const Duration(seconds: 2)));
        async.elapse(const Duration(seconds: 1));
        expect(sent, ['last words']);
      });
    });
  });
}
