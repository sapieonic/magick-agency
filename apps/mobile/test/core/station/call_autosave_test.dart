import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/station/call_autosave.dart';

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
}
