import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/floor_assist.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import '../inbound/inbound_fixtures.dart' show contractSample;
import 'controller_harness.dart';

const helpPath = '/proxy/agency/sessions/sess-1/help';

/// The agent station redesign's wire additions (stream F, AS18) through the real station core:
/// the contract's own samples (`session.json` `bootstrap_agent_station`, `station.json`
/// `reserved_call_later`) in the server's order, and the same frames from a server older than
/// them, which must change nothing.
void main() {
  /// The agent-station bootstrap on the harness's session and campaign.
  Map<String, Object?> agentStationBootstrap() => {
        ...contractSample('session.json', 'bootstrap_agent_station'),
        'session_id': 'sess-1',
        'campaign_id': 'camp-1',
        'station_ws_url': '/proxy/agency/station?token=boot',
      };

  Map<String, Object?> reservedCallLater() {
    final frame = contractSample('station.json', 'reserved_call_later');
    (frame['attempt']! as Map<String, Object?>)['campaign_id'] = 'camp-1';
    return frame;
  }

  test('the bootstrap\'s script, masked number and tile pictures reach the view', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, agentStationBootstrap());
      app.start();
      final v = app.view!;
      expect(v.maskPhone, isTrue);
      expect(v.script?.opening, 'Namaste {name}, I am {agent_name} calling from {campaign_name}.');
      expect(v.script?.steps, hasLength(3));
      expect({for (final d in v.dispositions) d.code: d.icon}, containsPair('will_pay', TilePicture.rupee));
      expect({for (final d in v.dispositions) d.code: d.icon}, containsPair('do_not_call', TilePicture.stop));
      expect({for (final b in v.breakOptions) b.code: b.icon}, containsPair('tea', TilePicture.tea));
      app.dispose();
    });
  });

  test('a booked call-later and the typed facts ride on the reserved frame, and stay on the call', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, agentStationBootstrap());
      app.start();
      final attempt = reservedCallLater()['attempt']! as Map<String, Object?>;
      app.frame(reservedCallLater());
      var call = app.view!.call!;
      expect(call.callback, CallLaterTag(dueAt: DateTime.utc(2026, 11, 20, 9, 30), bookedByMe: true));
      expect(call.facts?.name, 'Sunita Patil');
      expect(call.facts?.place, 'Nashik');
      final due = call.facts!.tiles.firstWhere((t) => t.amountDue);
      expect([due.kind, due.raw, due.parsed], [FactKind.money, '₹12,500.00', '12500.00']);
      expect(call.facts!.tiles.firstWhere((t) => t.dueDate).parsed, '2026-11-20');
      app.bridged(attempt['attempt_id']! as String);
      call = app.view!.call!;
      expect(call.isBridged, isTrue);
      expect(call.callback?.bookedByMe, isTrue, reason: 'the bridged call keeps them');
      expect(call.facts?.tiles, hasLength(4));
      app.dispose();
    });
  });

  test('from a server older than the fields: no script, the number in full, no pictures, no tag, no facts', () {
    fakeAsync((async) {
      final app = App(async)..start();
      expect(app.view!.script, isNull);
      expect(app.view!.maskPhone, isFalse);
      expect(app.view!.dispositions.every((d) => d.icon == null), isTrue);
      expect(app.view!.breakOptions.every((b) => b.icon == null), isTrue);
      app.reserved('a1');
      expect(app.view!.call!.callback, isNull);
      expect(app.view!.call!.facts, isNull);
      app.dispose();
    });
  });

  test('an older server\'s help_not_on_call off a call: Need help is offered on calls only for the rest of the session', () {
    fakeAsync((async) {
      final app = App(async)..start();
      app.readyFrame('available');
      expect(app.view!.help.onlyOnCall, isFalse);
      app.routes['POST $helpPath'] = (_) => json(409, {'error': 'Conflict', 'code': 'help_not_on_call', 'message': 'x'});
      app.run(app.controller.raiseHelp());
      expect(app.view!.help.onlyOnCall, isTrue);
      expect(app.view!.help.error, FloorAssistCopy.notOnCall);
      // Dismissing the refusal keeps the rule.
      app.controller.dismissHelpNotice();
      expect(app.view!.help.onlyOnCall, isTrue);
      app.dispose();
    });
  });

  test('another refusal off a call does not narrow it', () {
    fakeAsync((async) {
      final app = App(async)..start();
      app.readyFrame('available');
      app.routes['POST $helpPath'] = (_) => json(500, {'error': 'Internal Server Error', 'message': ''});
      app.run(app.controller.raiseHelp());
      expect(app.view!.help.onlyOnCall, isFalse);
      app.dispose();
    });
  });
}
