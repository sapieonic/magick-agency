// The agent station redesign's wire additions (docs/agent-station.md): every
// new field is optional, and a value this build cannot read is read as absent
// (AS18), never a failed bootstrap or frame.

import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

Map<String, Object?> copy(Map<String, Object?> j) => jsonDecode(jsonEncode(j)) as Map<String, Object?>;

void main() {
  group('tile icons (BE-13)', () {
    test('the bootstrap sample decodes each icon, and none where it sets none', () {
      final b = SessionBootstrap.fromJson(fixture('session.json', 'bootstrap_agent_station'));
      expect(b.dispositionCatalog.map((d) => d.icon).toList(), [
        TileIcon.rupee,
        TileIcon.clock,
        TileIcon.phoneMissed,
        TileIcon.thumbsDown,
        TileIcon.wrongNumber,
        TileIcon.stop,
        null,
      ]);
      expect(b.breakReasons.map((r) => r.icon).toList(), [TileIcon.tea, TileIcon.lunch, null]);
    });

    test('an icon this build does not know is none, and the catalog still decodes', () {
      final j = copy(fixture('session.json', 'bootstrap_agent_station'));
      final catalog = (j['disposition_catalog']! as List<Object?>).cast<Map<String, Object?>>();
      catalog[0]['icon'] = 'sparkle_added_later';
      catalog[1]['icon'] = 42;
      final breaks = (j['break_reasons']! as List<Object?>).cast<Map<String, Object?>>();
      breaks[0]['icon'] = {'not': 'a string'};
      final b = SessionBootstrap.fromJson(j);
      expect(b.dispositionCatalog[0].icon, isNull);
      expect(b.dispositionCatalog[0].code, 'will_pay');
      expect(b.dispositionCatalog[1].icon, isNull);
      expect(b.breakReasons[0].icon, isNull);
      expect(b.breakReasons[0].limitMinutes, 15);
    });

    test('tryFromWire reads only the listed icons', () {
      for (final icon in TileIcon.values.where((i) => !i.isUnknown)) {
        expect(TileIcon.tryFromWire(icon.wire), icon);
      }
      for (final bad in <Object?>['', 'Rupee', 'sparkle', null, 1, true]) {
        expect(TileIcon.tryFromWire(bad), isNull, reason: '$bad');
      }
    });
  });

  group('the bootstrap: script (BE-8) and number display (AS9)', () {
    test('the agent station sample carries a masked number and the script', () {
      final b = SessionBootstrap.fromJson(fixture('session.json', 'bootstrap_agent_station'));
      expect(b.phoneDisplay, PhoneDisplay.masked);
      expect(b.masksPhone, isTrue);
      expect(b.script!.opening, 'Namaste {name}, I am {agent_name} calling from {campaign_name}.');
      expect(b.script!.steps, hasLength(3));
      expect(b.script!.steps.first, const AgentScriptStep('Tell them the amount due: {amount_due}, due on {due_date}.'));
    });

    test('an older server (no fields) reads as the full number and no script', () {
      final b = SessionBootstrap.fromJson(fixture('session.json', 'bootstrap_first_join'));
      expect(b.phoneDisplay, PhoneDisplay.full);
      expect(b.phoneDisplayRaw, 'full');
      expect(b.masksPhone, isFalse);
      expect(b.script, isNull);
    });

    test('a display this build does not know reads as full, keeping the raw value', () {
      final j = copy(fixture('session.json', 'bootstrap_agent_station'))..['phone_display'] = 'last_four';
      final b = SessionBootstrap.fromJson(j);
      expect(b.phoneDisplay, PhoneDisplay.full);
      expect(b.phoneDisplayRaw, 'last_four');
      expect(b.masksPhone, isFalse);
    });

    test('an empty or unreadable script is no script; an unreadable step is skipped', () {
      expect(AgentScript.tryFromJson(<String, Object?>{}), isNull);
      expect(AgentScript.tryFromJson({'opening': '  ', 'steps': <Object?>[]}), isNull);
      expect(AgentScript.tryFromJson('a script'), isNull);
      final s = AgentScript.tryFromJson({
        'steps': [
          {'text': 'Ask when they can pay.'},
          {'text': 7},
          'not a step',
          {'text': ''},
        ],
      })!;
      expect(s.opening, isNull);
      expect(s.steps, [const AgentScriptStep('Ask when they can pay.')]);
      final j = copy(fixture('session.json', 'bootstrap_agent_station'))..['script'] = {'steps': 'many'};
      expect(SessionBootstrap.fromJson(j).script, isNull);
    });

    test('placeholders are filled, a missing value is nothing, an unknown word stays', () {
      String? valueOf(ScriptPlaceholder p) => switch (p) {
        ScriptPlaceholder.name => 'Sunita',
        ScriptPlaceholder.amountDue => '₹12,500',
        _ => null,
      };
      expect(
        fillScriptPlaceholders('Namaste {name}, {amount_due} due on {due_date}. {mood}', valueOf),
        'Namaste Sunita, ₹12,500 due on . {mood}',
      );
      expect(fillScriptPlaceholders('No placeholders here.', valueOf), 'No placeholders here.');
    });

    test('the context display carries the roles and types, and an older one reads as none', () {
      final d = SessionBootstrap.fromJson(fixture('session.json', 'bootstrap_agent_station')).contextDisplay;
      expect(d.roles, const ContextRoles(name: 'Customer Name', place: 'City', amountDue: 'Amount Due', dueDate: 'Due Date'));
      expect(d.roles!.columnFor(ContextRole.amountDue), 'Amount Due');
      expect(d.types, {'Amount Due': ContextFieldType.money, 'Due Date': ContextFieldType.date, 'EMI': ContextFieldType.money});
      final old = SessionBootstrap.fromJson(fixture('session.json', 'bootstrap_first_join')).contextDisplay;
      expect(old.roles, isNull);
      expect(old.types, isNull);
      final odd = ContextDisplay.fromJson({
        'roles': {'name': 3, 'place': 'City'},
        'types': {'A': 'money', 'B': 7, 'C': 'percent'},
      });
      expect(odd.roles, const ContextRoles(place: 'City'));
      expect(odd.types, {'A': ContextFieldType.money, 'C': ContextFieldType.unknown});
    });
  });

  group('the panel: a booked call-later (BE-4) and typed facts (BE-6)', () {
    test('the call-later sample carries the tag and the parsed tiles', () {
      final f = StationFrame.decode(fixtureText('station.json', 'reserved_call_later')) as ReservedFrame;
      final a = f.attempt;
      expect(
        a.callback,
        AttemptCallback(dueAt: DateTime.utc(2026, 11, 20, 9, 30), bookedByMe: true, source: AttemptCallbackSource.outcome),
      );
      expect(a.facts!.name, 'Sunita Patil');
      expect(a.facts!.place, 'Nashik');
      expect(a.facts!.amountDue, '12500.00');
      expect(a.facts!.dueDate, '2026-11-20');
      expect(a.facts!.tileFor(FactTileRole.amountDue)!.raw, '₹12,500.00');
      expect(a.facts!.tiles.first.display, 'Sunita Patil');
      expect(a.facts!.tiles.map((t) => t.type).toSet(), {
        ContextFieldType.text,
        ContextFieldType.money,
        ContextFieldType.date,
      });
    });

    test('an older panel has neither', () {
      final f = StationFrame.decode(fixtureText('station.json', 'reserved_promise')) as ReservedFrame;
      expect(f.attempt.callback, isNull);
      expect(f.attempt.facts, isNull);
    });

    test('an unreadable tag or facts is none, and the frame still decodes', () {
      final j = copy(fixture('station.json', 'reserved_call_later'));
      final attempt = j['attempt']! as Map<String, Object?>;
      attempt['callback'] = {'due_at': 'tomorrow', 'booked_by_me': true, 'source': 'outcome'};
      attempt['facts'] = {'tiles': 'four'};
      final f = StationFrame.decode(jsonEncode(j));
      expect(f, isA<ReservedFrame>());
      final a = (f as ReservedFrame).attempt;
      expect(a.callback, isNull);
      expect(a.facts, isNull);
      expect(a.contactId, 'e5d4c3b2-0a9f-4e8d-9c7b-6a5f4e3d2c1b');
    });

    test('a source this build does not know keeps the tag, as unknown', () {
      final c = AttemptCallback.tryFromJson({'due_at': '2026-11-20T09:30:00.000Z', 'booked_by_me': false, 'source': 'whatsapp'})!;
      expect(c.source, AttemptCallbackSource.unknown);
      expect(c.sourceRaw, 'whatsapp');
    });

    test('a resumed call carries both through ready.active_attempt', () {
      final j = copy(fixture('station.json', 'reserved_call_later'));
      final attempt = (j['attempt']! as Map<String, Object?>)
        ..['bridged_at'] = '2026-11-20T09:31:02.000Z'
        ..['state'] = 'bridged';
      final ready = StationFrame.decode(
        jsonEncode({'event': 'ready', 'session_id': 's-1', 'state': 'on_call', 'active_attempt': attempt}),
      ) as ReadyFrame;
      expect(ready.activeAttempt!.callback!.bookedByMe, isTrue);
      expect(ready.activeAttempt!.facts!.amountDue, '12500.00');
    });
  });

  group('Need help in every state (BE-9)', () {
    test('ready and the raise answer carry the state at raise; an older one has none', () {
      final ready = StationFrame.decode(fixtureText('station.json', 'ready_help_open_ready')) as ReadyFrame;
      expect(ready.help!.stateAtRaise, AgentState.available);
      expect(ready.help!.callId, isNull);
      final onBreak = HelpResponse.fromJson(fixture('floor-assist.json', 'help_response_raised_on_break'));
      expect(onBreak.help!.stateAtRaise, AgentState.onBreak);
      final old = HelpResponse.fromJson(fixture('floor-assist.json', 'help_response_raised'));
      expect(old.help!.stateAtRaise, isNull);
      final odd = SessionHelp.fromJson({'raised_at': '2026-11-20T05:41:07.204Z', 'call_id': null, 'state_at_raise': 5});
      expect(odd.stateAtRaise, isNull);
    });
  });

  group('My day (BE-1 to BE-3)', () {
    test('decodes the day with its target and call-laters', () {
      final d = MyDay.fromJson(fixture('reads.json', 'my_day'));
      expect(d.calls, 42);
      expect(d.dialed, 131);
      expect(d.willPay, 12);
      expect(d.target, MyDayTarget(metric: MyDayTargetMetric.calls, value: 120));
      expect(d.callLater.rows, hasLength(3));
      expect(d.callLater.rows.first.overdue, isTrue);
      expect(d.callLater.rows[1].customerName, isNull);
      expect(d.callLater.comesToMe, isTrue);
      expect(d.callLater.leftTodayGoesTo, CallLaterLeftGoesTo.waitsForMe);
      expect(d.dayStart, DateTime.utc(2026, 11, 19, 18, 30));
    });

    test('a pool campaign with no target and no promise outcome', () {
      final d = MyDay.fromJson(fixture('reads.json', 'my_day_pool_no_target'));
      expect(d.target, isNull);
      expect(d.willPay, isNull);
      expect(d.callLater.rows, isEmpty);
      expect(d.callLater.comesToMe, isFalse);
      expect(d.callLater.leftTodayGoesTo, CallLaterLeftGoesTo.pool);
    });

    test('the query names the campaign only', () {
      expect(const MyDayQuery(campaignId: 'c-1').toQuery(), {'campaign_id': 'c-1'});
    });
  });
}
