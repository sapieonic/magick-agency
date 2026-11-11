import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/core/softphone/call_fields.dart' show fieldRequiredCopy;
import 'package:magick_agency_agent/core/softphone/refusal_copy.dart';
import 'package:magick_agency_agent/core/softphone/softphone_controller.dart' show resumeRereadAfter;
import 'package:magick_agency_agent/core/softphone/softphone_copy.dart';
import 'package:magick_agency_agent/core/softphone/softphone_host.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_copy.dart' show catalogChangedCopy;
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/preflight/preflight_checks.dart' show MicPermission;

import '../station/controller_harness.dart' show json;
import 'fake_softphone_host.dart';
import 'manual_calls.dart';

/// The soft-phone core against a fake session host, one group per rule of the
/// port (the plan's rules 1–16), then the Phone tab's availability and its
/// screen states. HTTP is the real `SoftphoneApi` over a scripted client, so
/// what each request carries (or leaves out) is what the server would see.
void main() {
  const callsPath = '/proxy/agency/softphone/calls';
  const tag = {'campaign_id': 'camp-1', 'campaign_name': 'Home Loan Renewals'};

  ManualCall ringing([Map<String, Object?> over = const {}]) =>
      manualCall({'state': 'ringing', 'updated_at': '2026-10-30T10:00:05.000Z', ...over});
  ManualCall bridged([Map<String, Object?> over = const {}]) => manualCall({
    'state': 'bridged',
    'answered_at': '2026-10-30T10:00:10.000Z',
    'bridged_at': '2026-10-30T10:00:11.000Z',
    'updated_at': '2026-10-30T10:00:11.000Z',
    ...over,
  });
  Map<String, Object?> owedJson([Map<String, Object?> over = const {}]) => manualCallJson({
    'state': 'ended',
    'outcome': 'connected',
    'end_reason': 'remote_hangup',
    'requires_disposition': true,
    'answered_at': '2026-10-30T10:00:10.000Z',
    'bridged_at': '2026-10-30T10:00:11.000Z',
    'ended_at': '2026-10-30T10:02:00.000Z',
    'outcome_due_at': '2026-10-30T10:32:00.000Z',
    'updated_at': '2026-10-30T10:02:00.000Z',
    'fields': {'customer_name': 'Asha Rao', 'reason': 'Rate query'},
    ...over,
  });
  ManualCall owed([Map<String, Object?> over = const {}]) => ManualCall.fromJson(owedJson(over));
  Map<String, Object?> settledJson(ManualCall call, {String? code}) => owedJson({
    'id': call.id,
    'tag': call.tag == null ? null : {'campaign_id': call.tag!.campaignId, 'campaign_name': call.tag!.campaignName},
    'disposition_code': code,
    'settled_at': '2026-10-30T10:03:00.000Z',
    'updated_at': '2026-10-30T10:03:00.000Z',
  });
  Map<String, Object?> listRow(String id, Map<String, Object?> over) => {
    ...owedJson({'id': id, 'settled_at': '2026-10-30T09:00:00.000Z', 'disposition_code': 'resolved', ...over}),
    'analysis_status': null,
  };
  Map<String, Object?> sessionSummary({
    String kind = 'softphone',
    String account = 'a1',
    bool onSoftphone = true,
    String state = 'break',
    String? campaignId,
    String? campaignName,
  }) => {
    'session_id': kind == 'softphone' ? 'sess-sp' : 'sess-1',
    'account_id': account,
    'kind': kind,
    'campaign_id': campaignId,
    'campaign_name': campaignName,
    'state': state,
    'break_reason': onSoftphone ? 'soft_phone' : null,
    'on_softphone': onSoftphone,
    'pending_state': null,
    'pending_break_reason': null,
  };

  const bootstrapPath = 'GET /proxy/agency/softphone/bootstrap';
  // A second campaign the agent may log to.
  final camp2 = {
    ...campaignJson,
    'campaign_id': 'camp-2',
    'campaign_name': 'Gold Loan Top-ups',
    'caller_ids': ['+912248902220'],
  };
  final dncRefusal = {
    'error': 'Conflict',
    'code': 'dnc_listed',
    'message': 'Listed',
    'entry': {'id': 'dnc-1', 'scope': 'account', 'reason': 'Asked not to be called', 'created_at': '2026-10-12T09:00:00.000Z'},
  };
  // The account's field set with a required field added since the first read.
  final fieldsWithLoanId = [
    ...(bootstrapJson()['call_fields']! as List<Object?>),
    {'key': 'loan_id', 'label': 'Loan ID', 'type': 'text', 'required': true},
  ];

  // ─── Rule 1 ───────────────────────────────────────────────────────────────

  group('rule 1: one dial in flight, never retried', () {
    softphoneTest('two presses in the same frame place one call', (h) {
      h.openWith();
      h.reply('POST $callsPath', manualCallJson(), status: 201);
      fire(h.actions.dial());
      fire(h.actions.dial());
      expect(h.view.placing, isTrue);
      expect(h.view.canDial, isFalse);
      h.pump();
      expect(h.dials, hasLength(1));
      expect(h.dials.single.json, {
        'session_id': 'sess-sp',
        'to': '9820461733',
        'caller_id': '+912248908888',
        'campaign_id': null,
      });
      expect(h.host.adopted.single.id, 'mc-1');
      expect(h.view.phase, SoftphonePhase.dialing);
      expect(h.view.placing, isFalse);
    });

    softphoneTest('a dial that never answers is not sent again: the phone re-reads where it stands', (h) {
      h.openWith();
      h.routes['POST $callsPath'] = (_) => Completer<http.Response>().future;
      final before = h.bootstraps.length;
      fire(h.actions.dial());
      h.pump();
      h.async.elapse(const Duration(seconds: 19));
      expect(h.view.placing, isTrue);
      h.async.elapse(const Duration(seconds: 1));
      h.pump();
      expect(h.view.placing, isFalse);
      expect(h.view.dialError, softphoneDialUnconfirmedCopy);
      expect(h.bootstraps.length, before + 1);
      h.async.elapse(const Duration(minutes: 2));
      expect(h.dials, hasLength(1));
    });

    softphoneTest('an offline dial says it may have been placed, and is not retried either', (h) {
      h.openWith();
      h.routes['POST $callsPath'] = (_) => throw http.ClientException('offline');
      h.run(h.actions.dial());
      expect(h.view.dialError, softphoneDialUnconfirmedCopy);
      h.async.elapse(const Duration(minutes: 1));
      expect(h.dials, hasLength(1));
    });
  });

  group('rule 1b: the number is the one dialled until the server answers', () {
    softphoneTest('the pad takes no input while the dial is in flight', (h) {
      h.openWith();
      final answer = Completer<http.Response>();
      h.routes['POST $callsPath'] = (_) => answer.future;
      fire(h.actions.dial());
      h.pump();
      expect(h.view.placing, isTrue);
      expect(h.view.dialPadEnabled, isFalse);
      h.actions.backspace();
      h.actions.pressKey('4');
      h.actions.setNumber('9820461744');
      h.actions.pasteNumber('+91 98204 61755');
      h.actions.clearNumber();
      expect(h.view.number, '9820461733');
      answer.complete(json(409, dncRefusal));
      h.pump();
      expect(h.view.dialPadEnabled, isTrue);
    });

    softphoneTest('Call anyway redials the number the server refused, and the prompt names it', (h) {
      h.openWith();
      final replies = [json(409, dncRefusal), json(201, manualCallJson())];
      h.routes['POST $callsPath'] = (_) => replies.removeAt(0);
      h.run(h.actions.dial());
      // The pad is the agent's again behind the prompt; an edit there is not what was refused.
      h.actions.backspace();
      h.actions.pressKey('4');
      expect({for (final f in h.view.overridePrompt!.facts) f.label: f.value}['Number'], '+91 98204 61733');
      h.run(h.actions.confirmOverride('Customer asked us to call back'));
      expect(h.dials.map((d) => d.json['to']), ['9820461733', '9820461733']);
    });
  });

  // ─── Rule 2 ───────────────────────────────────────────────────────────────

  group('rule 2: redial fills the pad and never dials', () {
    softphoneTest('number, tag (while taggable) and caller ID, and Call takes focus', (h) {
      h.reply('GET $callsPath', {
        'rows': [
          listRow('mc-7', {'tag': tag, 'caller_id': '+912248901121'}),
          listRow('mc-8', {
            'tag': {'campaign_id': 'camp-gone', 'campaign_name': 'Old drive'},
            'destination_e164': '+919999900000',
          }),
        ],
        'next_cursor': null,
        'limit': 8,
      });
      h.openWith(number: '');
      h.run(h.actions.reloadRecent());
      expect(h.view.recent.map((r) => r.id), ['mc-7', 'mc-8']);
      expect(h.view.recent.first.loggedTo, 'Home Loan Renewals');

      h.actions.redial('mc-7');
      expect(h.view.number, '+919820461733');
      expect(h.view.tagCampaignId, 'camp-1');
      expect(h.view.callerId, '+912248901121');
      expect(h.view.focusCallToken, 1);
      h.pump();
      expect(h.dials, isEmpty);

      // A campaign no longer taggable: the call is redialled untagged.
      h.actions.redial('mc-8');
      expect(h.view.tagCampaignId, isNull);
      expect(h.view.focusCallToken, 2);
    });

    softphoneTest('an open override prompt goes: "Call anyway" never dials the refused number under the redial’s setup',
        (h) {
      h.reply('GET $callsPath', {
        'rows': [listRow('mc-7', {'tag': tag, 'destination_e164': '+919822001144'})],
        'next_cursor': null,
        'limit': 8,
      });
      h.openWith();
      h.run(h.actions.reloadRecent());
      h.reply('POST $callsPath', dncRefusal, status: 409);
      h.run(h.actions.dial());
      expect(h.view.overridePrompt, isNotNull);
      h.actions.redial('mc-7');
      expect(h.view.overridePrompt, isNull);
      expect(h.view.number, '+919822001144');
      h.run(h.actions.confirmOverride('Customer asked us to call back'));
      expect(h.dials, hasLength(1));
    });

    softphoneTest('does nothing while a call is on screen', (h) {
      h.reply('GET $callsPath', {
        'rows': [listRow('mc-7', {})],
        'next_cursor': null,
        'limit': 8,
      });
      h.run(h.actions.reloadRecent());
      h.openWith(call: ringing({'id': 'mc-9', 'destination_e164': '+919000000001'}));
      h.actions.redial('mc-7');
      expect(h.view.number, '+919000000001');
      expect(h.view.focusCallToken, 0);
      expect(h.view.recent.single.canRedial, isFalse);
    });
  });

  // ─── A Missed call's Call back ─────────────────────────────────────────────

  group('Call back (a Missed call) fills the pad like redial, and never dials', () {
    softphoneTest('number, the matched campaign as Log to, and Call takes focus', (h) {
      h.openWith(number: '');
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      expect(h.view.number, '+918765432109');
      expect(h.view.tagCampaignId, 'camp-1');
      expect(h.view.focusCallToken, 1);
      expect(h.view.canDial, isTrue);
      h.pump();
      expect(h.dials, isEmpty);
    });

    softphoneTest('a campaign the agent may not log to leaves Log to as it was', (h) {
      h.openWith(number: '');
      h.actions.callBack('+918765432109', campaignId: 'camp-not-mine');
      expect(h.view.number, '+918765432109');
      expect(h.view.tagCampaignId, isNull);
      expect(h.view.focusCallToken, 1);
    });

    softphoneTest('asked before the soft phone is open, it waits and fills the pad once it is', (h) {
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      expect(h.view.number, '');
      expect(h.view.focusCallToken, 0);
      h.host.view = hostView();
      h.pump();
      expect(h.view.number, '+918765432109');
      expect(h.view.tagCampaignId, 'camp-1');
      expect(h.view.focusCallToken, 1);
      expect(h.dials, isEmpty);
    });

    softphoneTest('a call on screen keeps it: the number waits, and the call’s own stays', (h) {
      h.openWith(call: ringing({'id': 'mc-9', 'destination_e164': '+919000000001'}));
      h.actions.callBack('+918765432109');
      expect(h.view.number, '+919000000001');
      expect(h.view.focusCallToken, 0);
      expect(h.dials, isEmpty);
    });

    softphoneTest('in finish mode nothing is filled', (h) {
      h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'softphone_enabled': false}));
      h.openWith(number: '');
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      expect(h.view.finishOnly, isTrue);
      expect(h.view.number, '');
      expect(h.view.focusCallToken, 0);
    });

    softphoneTest(
      'a campaign station on the soft phone (SP7) takes it, its matched campaign over the station’s own tag',
      (h) {
        h.host.view = campaignHost();
        h.pump();
        expect(h.view.tagCampaignId, 'camp-1', reason: 'the station’s preset');
        h.actions.callBack('+918765432109', campaignId: 'camp-2');
        expect(h.view.number, '+918765432109');
        expect(h.view.tagCampaignId, 'camp-2');
        expect(h.view.callerId, '+912248902220', reason: 'the caller IDs follow the tag');
        expect(h.view.focusCallToken, 1);

        // No matched campaign: the station's tag is not touched.
        h.actions.setTag('camp-1');
        h.actions.callBack('+919822001144');
        expect(h.view.number, '+919822001144');
        expect(h.view.tagCampaignId, 'camp-1');
        h.pump();
        expect(h.dials, isEmpty);
      },
      before: (h) => h.routes[bootstrapPath] = (_) => json(200, bootstrapJson({'taggable_campaigns': [campaignJson, camp2]})),
    );

    softphoneTest('a number waiting behind a call fills the pad once that call settles', (h) {
      h.openWith(call: ringing({'id': 'mc-9', 'destination_e164': '+919000000001'}));
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      expect(h.view.number, '+919000000001');
      // A long call: time behind it does not count against the wait.
      h.async.elapse(const Duration(minutes: 7));
      h.host.frame(owed({'id': 'mc-9', 'destination_e164': '+919000000001'}));
      h.pump();
      expect(h.view.number, '+919000000001', reason: 'owing its outcome still holds the screen');
      h.host.view = copyHost(h.host.view!, clearCall: true);
      h.pump();
      expect(h.view.number, '+918765432109');
      expect(h.view.tagCampaignId, 'camp-1');
      expect(h.view.focusCallToken, 1);
      expect(h.dials, isEmpty);
    });

    softphoneTest('a workspace switch drops the waiting number', (h) {
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      h.run(h.gate.switchAccount(pune));
      h.pump();
      h.host.view = hostView(accountId: 'a2');
      h.pump();
      expect(h.view.number, '');
      expect(h.view.focusCallToken, 0);
    });

    softphoneTest('waiting for the soft phone, it lapses after five minutes', (h) {
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      h.async.elapse(callBackWaitsFor - const Duration(seconds: 1));
      h.host.view = hostView();
      h.pump();
      expect(h.view.number, '+918765432109', reason: 'just inside the wait');
      h.actions.clearNumber();

      h.host.view = null;
      h.pump();
      h.actions.callBack('+919822001144');
      h.async.elapse(callBackWaitsFor);
      h.host.view = hostView(sessionId: 'sess-sp-2');
      h.pump();
      expect(h.view.number, '', reason: 'a much later session’s pad is not filled');
      expect(h.view.focusCallToken, 1);
    });

    softphoneTest('it is for the first session to open after it: a later one never gets it', (h) {
      // Asked with no session: the first to open is the one it waits for.
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      h.host.view = hostView(call: ringing({'id': 'mc-9', 'destination_e164': '+919000000001'}));
      h.pump();
      expect(h.view.number, '+919000000001');
      h.host.view = null; // that session closes (another device took it, a restart) with the number still waiting
      h.pump();
      h.host.view = hostView(sessionId: 'sess-sp-2');
      h.pump();
      expect(h.view.number, '');
      expect(h.view.tagCampaignId, isNull, reason: '"Log to" is not set out of nowhere either');

      // Asked on a station not yet switched to the soft phone: that station's.
      h.host.view = null;
      h.pump();
      h.host.view = campaignHost(onSoftphone: false);
      h.pump();
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      h.host.view = null;
      h.pump();
      h.host.view = hostView(sessionId: 'sess-sp-3');
      h.pump();
      expect(h.view.number, '');
      expect(h.view.focusCallToken, 0);
    });

    softphoneTest('a session another device takes drops it', (h) {
      h.host.view = campaignHost(onSoftphone: false);
      h.pump();
      h.actions.callBack('+918765432109');
      h.host.view = copyHost(h.host.view!, link: StationLink.superseded);
      h.pump();
      h.host.view = campaignHost();
      h.pump();
      expect(h.view.number, '');
    });

    softphoneTest(
      'with the soft phone open on another device it is not kept',
      (h) {
        expect(h.view.screen, const SoftphoneScreenOtherDevice(canClose: true));
        h.actions.callBack('+918765432109', campaignId: 'camp-1');
        expect(h.view.callBackWaiting, CallBackWaiting.notKept);
        h.run(h.actions.open()); // "Use it on this phone"
        expect(h.view.screen, const SoftphoneScreenActive());
        expect(h.view.number, '');
        expect(h.view.focusCallToken, 0);
      },
      before: (h) => h.routes[bootstrapPath] = (_) => json(200, bootstrapJson({'session': sessionSummary()})),
    );

    softphoneTest('pressed while a dial is in flight: that dial\'s refusal stays, and the number waits for it', (h) {
      h.openWith();
      final answer = Completer<http.Response>();
      h.routes['POST $callsPath'] = (_) => answer.future;
      fire(h.actions.dial());
      h.pump();
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      expect(h.view.callBackWaiting, CallBackWaiting.afterCall);
      answer.complete(json(409, {'error': 'Conflict', 'code': 'contact_assigned_elsewhere', 'message': 'no'}));
      h.pump();
      final refused = h.view.dialError;
      expect(refused, isNotNull);
      expect(h.view.number, '9820461733', reason: 'the refused number stays with its refusal');
      expect(h.view.callBackWaiting, CallBackWaiting.afterCall);
      h.pump();
      expect(h.view.dialError, refused, reason: 'never erased by the waiting number');
      // Time spent on the refusal does not count against the wait.
      h.async.elapse(const Duration(minutes: 6));
      h.pump();
      expect(h.view.dialError, refused);
      h.actions.dismissDialError();
      expect(h.view.number, '+918765432109');
      expect(h.view.tagCampaignId, 'camp-1');
      expect(h.view.focusCallToken, 1);
      expect(h.view.callBackWaiting, CallBackWaiting.none);
      expect(h.dials, hasLength(1), reason: 'only the agent\'s own dial');
    });

    softphoneTest('a dial refused for DNC while it waited: the override prompt stays until the agent closes it', (h) {
      h.openWith();
      final answer = Completer<http.Response>();
      h.routes['POST $callsPath'] = (_) => answer.future;
      fire(h.actions.dial());
      h.pump();
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      answer.complete(json(409, dncRefusal));
      h.pump();
      expect(h.view.overridePrompt, isNotNull, reason: 'the agent\'s own refusal, to answer');
      expect(h.view.number, '9820461733');
      h.actions.cancelOverride();
      expect(h.view.overridePrompt, isNull);
      expect(h.view.number, '+918765432109');
    });

    softphoneTest('a dial that went through while it waited: on the pad once that call settles', (h) {
      h.openWith();
      final answer = Completer<http.Response>();
      h.routes['POST $callsPath'] = (_) => answer.future;
      fire(h.actions.dial());
      h.pump();
      h.actions.callBack('+918765432109');
      answer.complete(json(201, manualCallJson()));
      h.pump();
      expect(h.view.callId, isNotNull);
      expect(h.view.callBackWaiting, CallBackWaiting.afterCall);
      h.host.view = copyHost(h.host.view!, clearCall: true);
      h.pump();
      expect(h.view.number, '+918765432109');
    });

    softphoneTest('where it stands, on the view: the soft phone\'s one decision', (h) {
      // Not open here yet.
      h.actions.callBack('+918765432109');
      expect(h.view.callBackWaiting, CallBackWaiting.onceOpen);
      // Open here, its setup for this session not read yet: in a moment.
      final bootstrap = Completer<http.Response>();
      h.routes[bootstrapPath] = (_) => bootstrap.future;
      h.host.view = hostView(sessionId: 'sess-sp-2');
      h.pump();
      expect(h.view.screen, isA<SoftphoneScreenActive>());
      expect(h.view.callBackWaiting, CallBackWaiting.setup);
      expect(h.view.number, '');
      bootstrap.complete(json(200, bootstrapJson()));
      h.pump();
      expect(h.view.number, '+918765432109');
      expect(h.view.callBackWaiting, CallBackWaiting.none);
      // Behind a call.
      h.host.view = copyHost(h.host.view!, call: ringing({'id': 'mc-9'}));
      h.pump();
      h.actions.callBack('+919822001144');
      expect(h.view.callBackWaiting, CallBackWaiting.afterCall);
    });

    softphoneTest(
      'a campaign station not switched to the soft phone: waits for the switch',
      (h) {
        h.host.view = campaignHost(onSoftphone: false);
        h.pump();
        h.actions.callBack('+918765432109');
        expect(h.view.callBackWaiting, CallBackWaiting.onceOpen);
      },
    );

    softphoneTest('an open override prompt goes: "Call anyway" never dials the old number under the new tag', (h) {
      h.openWith();
      h.reply('POST $callsPath', dncRefusal, status: 409);
      h.run(h.actions.dial());
      expect(h.view.overridePrompt, isNotNull);
      h.actions.callBack('+918765432109', campaignId: 'camp-1');
      expect(h.view.overridePrompt, isNull);
      expect(h.view.number, '+918765432109');
      h.run(h.actions.confirmOverride('Customer asked us to call back'));
      expect(h.dials, hasLength(1));
    });
  });

  // ─── Rule 3 ───────────────────────────────────────────────────────────────

  group('rule 3: setup locks once placed; the caller ID follows the tag', () {
    softphoneTest('default caller: the tag’s first, else the untagged default while listed', (h) {
      h.openWith();
      expect(h.view.setupEditable, isTrue);
      expect(h.view.callerId, '+912248908888');
      expect(h.view.callerIds.map((c) => c.value), ['+912248909999', '+912248908888']);
      h.actions.setTag('camp-1');
      expect(h.view.callerId, '+912248901120');
      h.actions.setCallerId('+912248901121');
      expect(h.view.callerId, '+912248901121');
      // Changing the tag clears the caller draft: a pick from the old set would be refused.
      h.actions.setTag(null);
      expect(h.view.callerId, '+912248908888');
      h.actions.setTag('camp-1');
      expect(h.view.callerId, '+912248901120');
      expect(h.view.recording, isTrue);
      expect(h.view.campaigns.single.analysisProfileName, 'Renewals v3');
    });

    softphoneTest('a placed call fixes the tag and the caller ID', (h) {
      h.openWith(call: ringing({'tag': tag, 'caller_id': '+912248901121'}));
      expect(h.view.setupEditable, isFalse);
      expect(h.view.tagCampaignId, 'camp-1');
      expect(h.view.callerIds.map((c) => c.value), ['+912248901121']);
      h.actions.setTag(null);
      h.actions.setCallerId('+912248901120');
      expect(h.view.tagCampaignId, 'camp-1');
      expect(h.view.callerId, '+912248901121');
    });

    softphoneTest('a closed window says the call may need a reason', (h) {
      h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(
        200,
        bootstrapJson({
          'taggable_campaigns': [
            {...campaignJson, 'calling_window_open': false},
          ],
        }),
      );
      h.run(h.actions.retry());
      expect(h.view.campaigns.single.windowOpen, isFalse);
      expect(h.view.campaigns.single.windowNote, softphoneWindowClosedCopy);
    });
  });

  // ─── Rule 4 ───────────────────────────────────────────────────────────────

  group('rule 4: the catalog the outcome is saved against', () {
    softphoneTest('untagged → the soft phone’s own; tagged → the campaign’s', (h) {
      h.openWith(call: owed());
      expect(h.view.outcomes.map((o) => o.code), ['resolved', 'wrong_number', 'callback']);
      h.host.frame(owed({'id': 'mc-2', 'tag': tag, 'created_at': '2026-10-30T10:05:00.000Z', 'updated_at': '2026-10-30T10:06:00.000Z'}));
      h.pump();
      expect(h.view.outcomes.map((o) => o.code), ['interested', 'callback', 'documents', 'do_not_call']);
    });

    softphoneTest('a campaign no longer taggable keeps its own outcomes through call_campaign', (h) {
      h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(
        200,
        bootstrapJson({
          'taggable_campaigns': <Object?>[],
          'call_campaign': {...campaignJson, 'status': 'completed'},
        }),
      );
      h.run(h.actions.retry());
      h.openWith(call: owed({'tag': tag}));
      expect(h.view.outcomes.first.code, 'interested');
    });

    softphoneTest('disposition_invalid re-syncs the pad from allowed_codes', (h) {
      h.openWith(call: owed());
      h.refuse('POST $callsPath/mc-1/disposition', 'disposition_invalid', status: 422, extra: {
        'allowed_codes': ['resolved', 'promised_to_pay'],
      });
      h.actions.selectOutcome('wrong_number');
      h.run(h.actions.saveOutcome());
      expect(h.view.outcomes.map((o) => o.code), ['resolved', 'promised_to_pay']);
      expect(h.view.outcomes.last.label, 'Promised to pay');
      expect(h.view.padRejection, catalogChangedCopy);
    });

    softphoneTest('a refused outcome sends the last keystrokes by the notes’ own route', (h) {
      h.reply('PATCH $callsPath/mc-1', manualCallJson({'state': 'ended'}));
      h.openWith(call: owed());
      h.refuse('POST $callsPath/mc-1/disposition', 'disposition_invalid', status: 422, extra: {
        'allowed_codes': ['resolved', 'promised_to_pay'],
      });
      h.actions.setNotes('Wants a quote');
      h.async.elapse(const Duration(milliseconds: 300));
      h.actions.selectOutcome('wrong_number');
      h.run(h.actions.saveOutcome());
      expect(h.patches('mc-1'), isEmpty, reason: 'the outcome carried them, then was refused');
      h.async.elapse(const Duration(milliseconds: 700));
      h.pump();
      expect(h.patches('mc-1').single.json['notes'], 'Wants a quote');
    });
  });

  // ─── Rule 5 ───────────────────────────────────────────────────────────────

  group('rule 5: DNC and calling-hours overrides', () {
    final dncBody = {
      'error': 'Conflict',
      'code': 'dnc_listed',
      'message': 'Listed',
      'entry': {'id': 'dnc-1', 'scope': 'account', 'reason': 'Asked not to be called', 'created_at': '2026-10-12T09:00:00.000Z'},
    };
    final hoursBody = {
      'error': 'Conflict',
      'code': 'outside_calling_hours',
      'message': 'Outside',
      'window': {
        'start': '09:00',
        'end': '20:00',
        'days': [1, 2, 3, 4, 5],
        'timezone': 'Asia/Kolkata',
      },
      'timezone_source': 'campaign_default',
      'next_open_at': '2026-11-02T03:30:00.000Z',
    };

    softphoneTest('a second refusal of the other kind keeps the first note', (h) {
      h.openWith();
      final replies = [json(409, dncBody), json(409, hoursBody), json(201, manualCallJson())];
      h.routes['POST $callsPath'] = (_) => replies.removeAt(0);

      h.run(h.actions.dial());
      final dnc = h.view.overridePrompt!;
      expect(dnc.kind, SoftphoneOverrideKind.dnc);
      expect({for (final f in dnc.facts) f.label: f.value}['Number'], '+91 98204 61733');
      expect(dnc.facts.firstWhere((f) => f.label == 'Listed for').value, 'This account');

      // Under 10 characters: nothing is sent.
      h.run(h.actions.confirmOverride('too short'));
      expect(h.dials, hasLength(1));
      expect(h.view.overridePrompt!.error, isNotNull);

      h.run(h.actions.confirmOverride('  Customer asked us to call back  '));
      expect(h.dials[1].json['overrides'], {'dnc_note': 'Customer asked us to call back'});
      final hours = h.view.overridePrompt!;
      expect(hours.kind, SoftphoneOverrideKind.hours);
      expect(hours.title, 'This campaign is outside its calling hours');

      h.run(h.actions.confirmOverride('They asked for a call now'));
      expect(h.dials[2].json['overrides'], {
        'dnc_note': 'Customer asked us to call back',
        'hours_note': 'They asked for a call now',
      });
      expect(h.view.overridePrompt, isNull);
      expect(h.view.phase, SoftphonePhase.dialing);
    });

    softphoneTest('"Don\'t call" closes the prompt and dials nothing', (h) {
      h.openWith();
      h.reply('POST $callsPath', dncBody, status: 409);
      h.run(h.actions.dial());
      h.actions.cancelOverride();
      expect(h.view.overridePrompt, isNull);
      h.pump();
      expect(h.dials, hasLength(1));
    });

    softphoneTest('override_note_invalid lands on the prompt while it is open, else on the pad', (h) {
      h.openWith();
      final replies = [json(409, dncBody), json(400, {'error': 'Bad Request', 'code': 'override_note_invalid', 'message': 'Say more.'})];
      h.routes['POST $callsPath'] = (_) => replies.removeAt(0);
      h.run(h.actions.dial());
      h.run(h.actions.confirmOverride('A long enough reason'));
      expect(h.view.overridePrompt!.error, 'Say more.');
      expect(h.view.dialError, isNull);

      h.actions.cancelOverride();
      h.refuse('POST $callsPath', 'override_note_invalid', status: 400);
      h.run(h.actions.dial());
      expect(h.view.dialError, softphoneRefusalCopy[SoftphoneErrorCode.overrideNoteInvalid]);
    });
  });

  softphoneTest('rule 5b: "Opens again" counts down on this phone’s clock', (h) {
    // The server's clock is 10 minutes ahead of this phone's.
    h.host.view = hostView(clockOffsetMs: 10 * 60 * 1000);
    h.pump();
    h.actions.setNumber('9820461733');
    h.reply('POST $callsPath', {
      'error': 'Conflict',
      'code': 'outside_calling_hours',
      'message': 'Outside',
      'window': {
        'start': '09:00',
        'end': '20:00',
        'days': [1, 2, 3, 4, 5],
        'timezone': 'Asia/Kolkata',
      },
      'timezone_source': 'campaign_default',
      'next_open_at': '2026-10-30T11:00:30.000Z',
    }, status: 409);
    h.run(h.actions.dial());
    final opens = h.view.overridePrompt!.facts.firstWhere((f) => f.label == 'Opens again').value;
    expect(opens, 'In 50 min — Fri 30 Oct, 16:20 your time');
  });

  // ─── Rule 6 ───────────────────────────────────────────────────────────────

  group('rule 6: the other refusals', () {
    softphoneTest('outcome_pending shows the call it names', (h) {
      h.openWith();
      h.refuse('POST $callsPath', 'outcome_pending', extra: {'call': owedJson({'id': 'mc-old'})});
      h.run(h.actions.dial());
      expect(h.host.adopted.single.id, 'mc-old');
      expect(h.view.phase, SoftphonePhase.outcome);
      expect(h.view.dialError, softphoneRefusalCopy[SoftphoneErrorCode.outcomePending]);
    });

    softphoneTest('contact_in_flight names the campaign calling the customer', (h) {
      h.openWith();
      h.actions.setTag('camp-1');
      h.refuse('POST $callsPath', 'contact_in_flight', extra: {'campaign_id': 'camp-1', 'contact_id': 'c-1'});
      h.run(h.actions.dial());
      expect(
        h.view.dialError,
        'Home Loan Renewals is calling this customer right now. Wait for that call to finish, then try again.',
      );
    });

    softphoneTest('contact_assigned_elsewhere (a strict campaign’s contact of another agent) says so, and offers no override', (h) {
      h.openWith();
      h.actions.setTag('camp-1');
      h.refuse('POST $callsPath', 'contact_assigned_elsewhere');
      h.run(h.actions.dial());
      expect(h.view.dialError, 'This number belongs to another agent on this campaign.');
      expect(h.view.overridePrompt, isNull);
    });

    softphoneTest('fields_invalid marks the fields it names', (h) {
      h.openWith();
      h.actions.setFieldValue('customer_name', 'Asha');
      h.refuse('POST $callsPath', 'fields_invalid', status: 400, extra: {
        'details': [
          {'path': 'fields.reason', 'message': 'Pick one of the options.'},
        ],
      });
      h.run(h.actions.dial());
      expect(h.dials.single.json['fields'], {'customer_name': 'Asha'});
      expect(h.view.fields.firstWhere((f) => f.key == 'reason').error, 'Pick one of the options.');
      expect(h.view.dialError, softphoneRefusalCopy[SoftphoneErrorCode.fieldsInvalid]);
    });

    softphoneTest('softphone_disabled: finish mode, an announcement, and a fresh bootstrap', (h) {
      h.openWith();
      h.refuse('POST $callsPath', 'softphone_disabled', status: 403);
      final before = h.bootstraps.length;
      h.run(h.actions.dial());
      expect(h.view.finishOnly, isTrue);
      expect(h.view.startAllowed, isFalse);
      expect(h.view.announcement, softphoneFinishIdleCopy[SoftphoneSurface.phone]);
      expect(h.bootstraps.length, before + 1);
      expect(h.availability.startAllowed, isFalse);
    });

    softphoneTest('caller_id_not_allowed and campaign_not_taggable re-read what may be dialled', (h) {
      h.openWith();
      for (final code in ['caller_id_not_allowed', 'campaign_not_taggable']) {
        h.refuse('POST $callsPath', code, status: 422);
        final before = h.bootstraps.length;
        h.run(h.actions.dial());
        expect(h.view.dialError, isNotNull, reason: code);
        expect(h.bootstraps.length, before + 1, reason: code);
      }
    });
  });

  // ─── Rule 7 ───────────────────────────────────────────────────────────────

  group('rule 7: call fields', () {
    softphoneTest(
      'no fields are sent until the field set is known: notes alone, then both',
      (h) {
        final call = bridged({'fields': {'customer_name': 'Asha'}});
        h.openWith(call: call);
        h.actions.setNotes('Wants a rate cut');
        h.async.elapse(const Duration(milliseconds: 700));
        h.pump();
        expect(h.patches('mc-1').single.json, {'notes': 'Wants a rate cut'});

        h.routes['GET /proxy/agency/softphone/bootstrap'] =
            (_) => json(200, bootstrapJson({'session': sessionSummary(), 'call': callBody(call, {'fields': call.fields})}));
        h.run(h.actions.retry());
        // The field set arrived after the call: the form takes the call's values.
        expect(h.view.fields.firstWhere((f) => f.key == 'customer_name').value, 'Asha');
        h.actions.setNotes('Wants a rate cut today');
        h.async.elapse(const Duration(milliseconds: 700));
        h.pump();
        expect(h.patches('mc-1').last.json, {
          'fields': {'customer_name': 'Asha'},
          'notes': 'Wants a rate cut today',
        });
      },
      before: (h) {
        h.routes['GET /proxy/agency/softphone/bootstrap'] =
            (_) => json(503, {'error': 'Service Unavailable', 'message': 'down'});
        h.reply('PATCH $callsPath/mc-1', manualCallJson({'state': 'bridged'}));
      },
    );

    softphoneTest(
      'a field typed before the set arrived is the agent’s and is kept',
      (h) {
        final call = bridged({'fields': {'customer_name': 'Asha'}});
        h.openWith(call: call);
        h.actions.setFieldValue('customer_name', 'Asha Rao');
        h.routes['GET /proxy/agency/softphone/bootstrap'] =
            (_) => json(200, bootstrapJson({'session': sessionSummary(), 'call': callBody(call, {'fields': call.fields})}));
        h.run(h.actions.retry());
        expect(h.view.fields.firstWhere((f) => f.key == 'customer_name').value, 'Asha Rao');
      },
      before: (h) {
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(503, {'message': 'down'});
        h.reply('PATCH $callsPath/mc-1', manualCallJson({'state': 'bridged'}));
      },
    );

    softphoneTest('a call arriving takes the server’s values, and edits autosave 700 ms after the last', (h) {
      h.reply('PATCH $callsPath/mc-1', manualCallJson({'state': 'bridged'}));
      h.openWith(call: bridged({'fields': {'customer_name': 'Asha', 'follow_up': true}}));
      expect(h.view.fields.map((f) => f.value), ['Asha', null, true]);
      h.actions.setFieldValue('reason', 'Documents');
      h.async.elapse(const Duration(milliseconds: 400));
      h.actions.setFieldValue('customer_name', ' Asha Rao ');
      h.async.elapse(const Duration(milliseconds: 699));
      expect(h.patches('mc-1'), isEmpty);
      h.async.elapse(const Duration(milliseconds: 1));
      h.pump();
      expect(h.patches('mc-1').single.json['fields'], {'customer_name': 'Asha Rao', 'reason': 'Documents', 'follow_up': true});
    });
  });

  group('rule 7b: a field the phone does not know re-reads the field set', () {
    softphoneTest('on saving the outcome', (h) {
      h.openWith(call: owed());
      h.refuse('POST $callsPath/mc-1/disposition', 'fields_invalid', status: 400, extra: {
        'details': [
          {'path': 'fields.loan_id', 'message': 'is required'},
        ],
      });
      h.routes[bootstrapPath] = (_) => json(200, bootstrapJson({'call_fields': fieldsWithLoanId}));
      final before = h.bootstraps.length;
      h.actions.selectOutcome('resolved');
      h.run(h.actions.saveOutcome());
      expect(h.view.padRejection, softphoneRefusalCopy[SoftphoneErrorCode.fieldsInvalid]);
      expect(h.bootstraps.length, before + 1);
      expect(h.view.fields.firstWhere((f) => f.key == 'loan_id').error, 'is required');
    });

    softphoneTest('on an autosave', (h) {
      h.openWith(call: bridged());
      h.refuse('PATCH $callsPath/mc-1', 'fields_invalid', status: 400, extra: {
        'details': [
          {'path': 'fields.loan_id', 'message': 'is required'},
        ],
      });
      h.routes[bootstrapPath] = (_) => json(200, bootstrapJson({'call_fields': fieldsWithLoanId}));
      final before = h.bootstraps.length;
      h.actions.setFieldValue('customer_name', 'Asha');
      h.async.elapse(const Duration(milliseconds: 700));
      h.pump();
      expect(h.patches('mc-1'), isNotEmpty);
      expect(h.bootstraps.length, before + 1);
      expect(h.view.fields.firstWhere((f) => f.key == 'loan_id').error, 'is required');
    });

    softphoneTest('not when every field it names is known', (h) {
      h.openWith(call: owed());
      h.refuse('POST $callsPath/mc-1/disposition', 'fields_invalid', status: 400, extra: {
        'details': [
          {'path': 'fields.reason', 'message': 'Pick one of the options.'},
        ],
      });
      final before = h.bootstraps.length;
      h.actions.selectOutcome('resolved');
      h.run(h.actions.saveOutcome());
      expect(h.bootstraps.length, before);
    });
  });

  // ─── Rule 8 ───────────────────────────────────────────────────────────────

  group('rule 8: notes on the outcome', () {
    softphoneTest('notes the agent cleared go as \'\', and the pending autosave is cancelled', (h) {
      h.openWith(call: owed({'notes': 'Old note'}));
      // A slow save: the autosave the edit armed would fall due while it is in flight.
      final answer = Completer<http.Response>();
      h.routes['POST $callsPath/mc-1/disposition'] = (_) => answer.future;
      expect(h.view.notes.text, 'Old note');
      h.actions.setNotes('');
      h.actions.selectOutcome('resolved');
      fire(h.actions.saveOutcome());
      h.pump();
      final body = h.requests('POST', '$callsPath/mc-1/disposition').single.json;
      expect(body.containsKey('notes'), isTrue);
      expect(body['notes'], '');
      h.async.elapse(const Duration(seconds: 5));
      h.pump();
      expect(h.patches('mc-1'), isEmpty);
      answer.complete(json(200, {'call': settledJson(owed(), code: 'resolved')}));
      h.pump();
      expect(h.view.phase, SoftphonePhase.ready);
      h.async.elapse(const Duration(seconds: 5));
      expect(h.patches('mc-1'), isEmpty);
    });

    softphoneTest('notes never touched (and none on the call) are left out', (h) {
      h.openWith(call: owed());
      h.reply('POST $callsPath/mc-1/disposition', {'call': settledJson(owed(), code: 'resolved')});
      h.actions.selectOutcome('resolved');
      h.run(h.actions.saveOutcome());
      final body = h.requests('POST', '$callsPath/mc-1/disposition').single.json;
      expect(body.containsKey('notes'), isFalse);
      expect(body['code'], 'resolved');
      expect(body['fields'], {'customer_name': 'Asha Rao', 'reason': 'Rate query'});
    });

    softphoneTest('typed notes go trimmed', (h) {
      h.openWith(call: owed());
      h.reply('POST $callsPath/mc-1/disposition', {'call': settledJson(owed(), code: 'resolved')});
      h.actions.setNotes('  Will renew next week ');
      h.actions.selectOutcome('resolved');
      h.run(h.actions.saveOutcome());
      expect(h.requests('POST', '$callsPath/mc-1/disposition').single.json['notes'], 'Will renew next week');
    });
  });

  // ─── Rule 9 ───────────────────────────────────────────────────────────────

  group('rule 9: saving the outcome', () {
    softphoneTest('blocked until the call ends', (h) {
      h.openWith(call: bridged({'fields': {'customer_name': 'Asha Rao', 'reason': 'Documents'}}));
      h.actions.selectOutcome('resolved');
      expect(h.view.saveBlockAt(h.now()), SoftphoneSaveBlock.callLive);
      h.run(h.actions.saveOutcome());
      expect(h.requests('POST', '$callsPath/mc-1/disposition'), isEmpty);
      expect(h.view.announcement, softphoneSaveBlockCopy[SoftphoneSaveBlock.callLive]);
    });

    softphoneTest('blocked while a required field is empty, and the fields say which', (h) {
      h.openWith(call: owed({'fields': <String, Object?>{}}));
      h.actions.selectOutcome('resolved');
      expect(h.view.requiredFieldsMissing, isTrue);
      h.run(h.actions.saveOutcome());
      expect(h.requests('POST', '$callsPath/mc-1/disposition'), isEmpty);
      expect(h.view.fields.firstWhere((f) => f.key == 'customer_name').error, fieldRequiredCopy);
      expect(h.view.announcement, softphoneSaveBlockCopy[SoftphoneSaveBlock.fieldsRequired]);
    });

    softphoneTest('a callback outcome needs a time in the future', (h) {
      h.openWith(call: owed());
      h.reply('POST $callsPath/mc-1/disposition', {'call': settledJson(owed(), code: 'callback')});
      h.actions.selectOutcome('callback');
      expect(h.view.saveBlockAt(h.now()), SoftphoneSaveBlock.callbackRequired);
      final at = DateTime.utc(2026, 10, 31, 5);
      h.actions.setCallback(at);
      h.run(h.actions.saveOutcome());
      expect(h.requests('POST', '$callsPath/mc-1/disposition').single.json['callback_at'], '2026-10-31T05:00:00.000Z');
    });

    softphoneTest('saved: the call settles, Ready returns and the recent calls reload', (h) {
      h.openWith(call: owed());
      h.reply('POST $callsPath/mc-1/disposition', {'call': settledJson(owed(), code: 'resolved')});
      final before = h.requests('GET', callsPath).length;
      h.actions.selectOutcome('resolved');
      h.run(h.actions.saveOutcome());
      expect(h.view.announcement, softphoneOutcomeSavedCopy);
      expect(h.view.phase, SoftphonePhase.ready);
      expect(h.view.number, '');
      expect(h.requests('GET', callsPath).length, before + 1);
    });

    softphoneTest('call_settled (saved elsewhere) re-reads the bootstrap', (h) {
      h.openWith(call: owed());
      h.refuse('POST $callsPath/mc-1/disposition', 'call_settled');
      final before = h.bootstraps.length;
      h.actions.selectOutcome('resolved');
      h.run(h.actions.saveOutcome());
      expect(h.view.announcement, contains(softphoneRefusalCopy[SoftphoneErrorCode.callSettled]!));
      expect(h.bootstraps.length, before + 1);
      // The bootstrap has no call any more: the held copy is retired and Ready returns.
      expect(h.view.phase, SoftphonePhase.ready);
    });
  });

  // ─── Rule 10 ──────────────────────────────────────────────────────────────

  softphoneTest('rule 10: the outcome countdown is on this phone’s clock', (h) {
    h.host.view = hostView(call: owed(), clockOffsetMs: 2000);
    h.pump();
    expect(h.view.outcomeDueAt, DateTime.utc(2026, 10, 30, 10, 31, 58));
    expect(h.view.outcomeTimeLeft(h.now()), const Duration(minutes: 31, seconds: 28));
    expect(softphoneOutcomeCountdownCopy(const Duration(minutes: 4, seconds: 5)), 'Without one, it closes in 4:05.');
  });

  // ─── Rule 11 ──────────────────────────────────────────────────────────────

  group('rule 11: finish mode', () {
    void off(SoftphoneHarness h) =>
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'softphone_enabled': false}));

    softphoneTest('everything that starts work does nothing', (h) {
      h.reply('GET $callsPath', {
        'rows': [listRow('mc-7', {})],
        'next_cursor': null,
        'limit': 8,
      });
      h.host.view = hostView();
      h.pump();
      h.run(h.actions.reloadRecent());
      expect(h.view.finishOnly, isTrue);
      expect(h.view.finishNotice(SoftphoneSurface.phone), softphoneFinishIdleCopy[SoftphoneSurface.phone]);
      h.actions.setNumber('9820461733');
      h.actions.pressKey('9');
      h.actions.pasteNumber('+91 98204 61733');
      h.actions.redial('mc-7');
      expect(h.view.number, '');
      expect(h.view.dialPadEnabled, isFalse);
      expect(h.view.recent.single.canRedial, isFalse);
      h.run(h.actions.dial());
      expect(h.dials, isEmpty);
      expect(h.view.dialUnavailableReason, softphoneFinishIdleCopy[SoftphoneSurface.phone]);
    }, before: off);

    softphoneTest('hang-up, notes and the outcome still work', (h) {
      h.reply('POST $callsPath/mc-1/hangup', manualCallJson({'state': 'ringing'}));
      h.reply('POST $callsPath/mc-1/disposition', {'call': settledJson(owed(), code: 'resolved')});
      h.host.view = hostView(call: ringing());
      h.pump();
      expect(h.view.finishNotice(SoftphoneSurface.phone), softphoneFinishCallCopy);
      h.run(h.actions.hangUp());
      expect(h.requests('POST', '$callsPath/mc-1/hangup'), hasLength(1));

      h.host.frame(owed({'updated_at': '2026-10-30T10:02:30.000Z'}));
      h.pump();
      h.actions.setNotes('Customer will call back');
      expect(h.view.notes.text, 'Customer will call back');
      h.actions.setFieldValue('customer_name', 'Asha Rao');
      h.actions.setFieldValue('reason', 'Documents');
      expect(h.view.fields.first.value, 'Asha Rao');
      h.actions.selectOutcome('resolved');
      h.run(h.actions.saveOutcome());
      expect(h.requests('POST', '$callsPath/mc-1/disposition'), hasLength(1));
    }, before: off);
  });

  group('rule 11b: the override prompt and finish mode', () {
    softphoneTest('finish mode arriving closes an open prompt, and Call anyway dials nothing', (h) {
      h.openWith();
      h.reply('POST $callsPath', dncRefusal, status: 409);
      h.run(h.actions.dial());
      expect(h.view.overridePrompt, isNotNull);

      // A reconnect re-reads the bootstrap: the soft phone is off now.
      h.routes[bootstrapPath] = (_) => json(200, bootstrapJson({'softphone_enabled': false}));
      h.host.view = copyHost(h.host.view!, link: StationLink.reconnecting, everOpened: true);
      h.pump();
      h.host.view = copyHost(h.host.view!, link: StationLink.open);
      h.pump();
      expect(h.view.finishOnly, isTrue);
      expect(h.view.overridePrompt, isNull);
      h.reply('POST $callsPath', manualCallJson(), status: 201);
      h.run(h.actions.confirmOverride('Customer asked us to call back'));
      expect(h.dials, hasLength(1));
    });

    softphoneTest('Call anyway waits like Call does: nothing is dialled while the socket is away', (h) {
      h.openWith();
      h.reply('POST $callsPath', dncRefusal, status: 409);
      h.run(h.actions.dial());
      h.host.view = copyHost(h.host.view!, link: StationLink.reconnecting, everOpened: true);
      h.pump();
      expect(h.view.overridePrompt, isNotNull);
      h.reply('POST $callsPath', manualCallJson(), status: 201);
      h.run(h.actions.confirmOverride('Customer asked us to call back'));
      expect(h.dials, hasLength(1));
    });
  });

  // ─── Rule 12 ──────────────────────────────────────────────────────────────

  group('rule 12: a reconnect re-reads the bootstrap', () {
    softphoneTest('the first open does not; a reconnect does, and retires a call that settled meanwhile', (h) {
      final call = bridged();
      h.host.view = hostView(link: StationLink.connecting, everOpened: false, call: call);
      h.pump();
      final reads = h.bootstraps.length;
      h.host.view = copyHost(h.host.view!, link: StationLink.open);
      h.pump();
      expect(h.bootstraps.length, reads);

      h.host.view = copyHost(h.host.view!, link: StationLink.reconnecting, everOpened: true);
      h.pump();
      h.host.view = copyHost(h.host.view!, link: StationLink.open);
      h.pump();
      expect(h.bootstraps.length, reads + 1);
      expect(h.host.retired, [call.versionKey]);
      expect(h.view.phase, SoftphonePhase.ready);
    });

    softphoneTest('a newer frame that arrives while the bootstrap is read survives it', (h) {
      final call = bridged();
      h.host.view = hostView(call: call, link: StationLink.reconnecting);
      h.pump();
      final answer = Completer<http.Response>();
      h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => answer.future;
      h.host.view = copyHost(h.host.view!, link: StationLink.open);
      h.pump();
      h.host.frame(advance(call, 30, {'state': 'ended', 'requires_disposition': true, 'outcome': 'connected'}));
      h.pump();
      answer.complete(json(200, bootstrapJson()));
      h.pump();
      expect(h.host.retired, [call.versionKey]);
      expect(h.view.phase, SoftphonePhase.outcome);
    });

    softphoneTest('a call the bootstrap still holds is adopted', (h) {
      h.host.view = hostView(link: StationLink.reconnecting);
      h.pump();
      h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'call': owedJson()}));
      h.host.view = copyHost(h.host.view!, link: StationLink.open);
      h.pump();
      expect(h.host.adopted.single.id, 'mc-1');
      expect(h.view.phase, SoftphonePhase.outcome);
    });
  });

  softphoneTest('rule 12b: a failed hang-up from CallKit or the notification shows as the soft phone’s own', (h) {
    const failure = 'We couldn’t end the call — you may still be connected. Check your connection.';
    h.openWith(call: bridged());
    expect(h.view.hangupFailure, isNull);
    h.host.view = copyHost(h.host.view!, hangupFailure: failure);
    h.pump();
    expect(h.view.hangupFailure, failure);
    h.host.view = copyHost(h.host.view!, clearHangupFailure: true);
    h.pump();
    expect(h.view.hangupFailure, isNull);

    // The soft phone's own failure (its hang-up button) is the one shown when both are.
    h.reply('POST $callsPath/mc-1/hangup', {'error': 'Internal Server Error', 'message': 'down'}, status: 500);
    h.run(h.actions.hangUp());
    final own = h.view.hangupFailure;
    expect(own, isNotNull);
    h.host.view = copyHost(h.host.view!, hangupFailure: failure);
    h.pump();
    expect(h.view.hangupFailure, own);
  });

  // ─── Rule 12c ─────────────────────────────────────────────────────────────

  group('rule 12c: the SP3 ringing warning follows the call’s can_cancel_ringing', () {
    softphoneTest('a carrier that cannot cancel, or a call that does not say, warns while ringing', (h) {
      h.openWith(call: ringing({'can_cancel_ringing': false}));
      expect(h.view.warnRingingHangUp, isTrue);
      // A newer copy without the key (the ringing copy is at +5 s).
      h.host.frame(advance(h.host.view!.call!, 6, {'state': 'ringing'}));
      h.pump();
      expect(h.host.view!.call!.canCancelRinging, isNull);
      expect(h.view.warnRingingHangUp, isTrue, reason: 'absent is not true: fail closed, as the console');
    });

    softphoneTest('a carrier that cancels a ringing call: no warning, and none once answered', (h) {
      final call = ringing({'can_cancel_ringing': true});
      h.openWith(call: call);
      expect(h.view.phase, SoftphonePhase.ringing);
      expect(h.view.warnRingingHangUp, isFalse);
      expect(h.view.canHangUp, isTrue);
      h.host.frame(
        advance(call, 10, {
          'state': 'bridged',
          'answered_at': '2026-10-30T10:00:10.000Z',
          'bridged_at': '2026-10-30T10:00:10.000Z',
          'can_cancel_ringing': false,
        }),
      );
      h.pump();
      expect(h.view.phase, SoftphonePhase.onCall);
      expect(h.view.warnRingingHangUp, isFalse, reason: 'only while ringing');
    });
  });

  // ─── Rule 13 ──────────────────────────────────────────────────────────────

  group('rule 13: Mute', () {
    softphoneTest('while ringing it mutes the ring, never the microphone', (h) {
      h.openWith(call: ringing());
      expect(h.view.muteTarget, SoftphoneMuteTarget.ring);
      h.run(h.actions.toggleMute());
      expect(h.host.log, contains('ringMuted:true'));
      expect(h.host.log.where((l) => l.startsWith('micMuted')), isEmpty);
      expect(h.view.muted, isTrue);
      expect(h.view.micMuted, isFalse);
    });

    softphoneTest('on the call it is the microphone', (h) {
      h.openWith(call: bridged());
      expect(h.view.muteTarget, SoftphoneMuteTarget.mic);
      h.run(h.actions.toggleMute());
      expect(h.host.log, contains('micMuted:true'));
      expect(h.view.muted, isTrue);
    });

    softphoneTest('answering with the microphone muted is announced', (h) {
      final call = ringing();
      h.host.view = hostView(call: call, audio: const AudioView(muted: true));
      h.pump();
      expect(h.view.announcement, isEmpty);
      h.host.frame(advance(call, 10, {'state': 'answered', 'answered_at': '2026-10-30T10:00:10.000Z'}));
      h.pump();
      expect(h.view.announcement, softphoneMutedAtAnswerCopy);
      expect(h.view.announcementSeq, 1);
    });
  });

  // ─── Rule 14 ──────────────────────────────────────────────────────────────

  group('rule 14: Mark DNC and recent calls', () {
    softphoneTest('a tagged call is marked for its campaign', (h) {
      h.openWith(call: bridged({'tag': tag}));
      expect(h.view.dncScopeLabel, 'for Home Loan Renewals');
      h.reply('POST $callsPath/mc-1/dnc', {
        'call_id': 'mc-1',
        'phone_e164': '+919820461733',
        'scope': 'campaign',
        'dnc_recorded': true,
        'contact_state': null,
      });
      h.run(h.actions.markDnc(callId: 'mc-1', reason: 'Asked'));
      expect(h.requests('POST', '$callsPath/mc-1/dnc').single.json, {'reason': 'Asked'});
      expect(h.view.dncOutcome, '+91 98204 61733 is on the Do Not Call list for Home Loan Renewals.');
      expect(h.view.announcement, h.view.dncOutcome);
    });

    softphoneTest('an untagged call for the account; another call on screen marks nothing', (h) {
      h.openWith(call: bridged());
      expect(h.view.dncScopeLabel, 'for this account');
      h.run(h.actions.markDnc(callId: 'mc-other'));
      expect(h.requests('POST', '$callsPath/mc-1/dnc'), isEmpty);
    });

    softphoneTest('recent calls are the agent’s own last 8, reloaded when a call settles', (h) {
      final first = h.requests('GET', callsPath).single;
      expect(first.query, {'agent_user_id': 'u-1', 'limit': '8'});
      final call = bridged();
      h.openWith(call: call);
      h.host.frame(ManualCall.fromJson(settledJson(call)));
      h.pump();
      expect(h.requests('GET', callsPath), hasLength(2));
      expect(h.view.phase, SoftphonePhase.ready);
    });
  });

  // ─── Rule 15 ──────────────────────────────────────────────────────────────

  group('rule 15: the station’s campaign is the preset tag (SP7)', () {
    softphoneTest('when the bootstrap says it is taggable', (h) {
      h.host.view = campaignHost();
      h.pump();
      expect(h.view.tagCampaignId, 'camp-1');
      expect(h.view.callerId, '+912248901120');
    });

    softphoneTest('not when it is not', (h) {
      h.host.view = campaignHost(campaignId: 'camp-elsewhere');
      h.pump();
      expect(h.view.tagCampaignId, isNull);
    });
  });

  group('rule 15b: a new session reads the bootstrap again, and starts from a clean setup', () {
    softphoneTest(
      'a station that starts after the bootstrap was read: a campaign staffed since is the preset',
      (h) {
        h.routes[bootstrapPath] = (_) => json(200, bootstrapJson());
        final before = h.bootstraps.length;
        h.host.view = campaignHost();
        h.pump();
        expect(h.bootstraps.length, before + 1);
        expect(h.view.tagCampaignId, 'camp-1');
      },
      before: (h) => h.routes[bootstrapPath] = (_) => json(200, bootstrapJson({'taggable_campaigns': <Object?>[]})),
    );

    softphoneTest('switching the station to the soft phone reads it again, and presets from that answer', (h) {
      h.routes[bootstrapPath] = (_) => json(200, bootstrapJson({'taggable_campaigns': <Object?>[]}));
      h.host.view = campaignHost(onSoftphone: false);
      h.pump();
      h.routes[bootstrapPath] = (_) => json(200, bootstrapJson());
      final before = h.bootstraps.length;
      h.host.view = campaignHost();
      h.pump();
      expect(h.bootstraps.length, before + 1);
      expect(h.view.tagCampaignId, 'camp-1');
    });

    softphoneTest('a Phone-tab session after a station starts untagged, on the default caller ID', (h) {
      h.host.view = campaignHost();
      h.pump();
      expect(h.view.tagCampaignId, 'camp-1');
      h.host.view = null;
      h.pump();
      h.host.view = hostView();
      h.pump();
      expect(h.view.tagCampaignId, isNull);
      expect(h.view.callerId, '+912248908888');
    });

    softphoneTest('a caller ID picked in one session is not carried into the next', (h) {
      h.openWith();
      h.actions.setCallerId('+912248909999');
      expect(h.view.callerId, '+912248909999');
      h.host.view = null;
      h.pump();
      h.host.view = hostView(sessionId: 'sess-sp-2');
      h.pump();
      expect(h.view.callerId, '+912248908888');
    });
  });

  // ─── Rule 16 ──────────────────────────────────────────────────────────────

  group('rule 16: an existing session resumes by itself', () {
    softphoneTest(
      'a soft-phone session this phone hosted is reopened',
      (h) {
        expect(h.host.count('open'), 1);
        expect(h.view.screen, const SoftphoneScreenActive());
      },
      before: (h) {
        h.rememberHosted('sess-sp');
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(
          200,
          bootstrapJson({'softphone_enabled': false, 'session': sessionSummary()}),
        );
      },
    );

    softphoneTest(
      'a campaign session this phone hosted, on the soft phone with an unsettled call, has its station started',
      (h) {
        expect(h.launcher.started, ['camp-1']);
        expect(h.host.count('open'), 0);
      },
      before: (h) {
        h.rememberHosted('sess-1');
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(
          200,
          bootstrapJson({
            'session': sessionSummary(kind: 'campaign', campaignId: 'camp-1', campaignName: 'Home Loan Renewals'),
            'call': owedJson({'session_id': 'sess-1'}),
          }),
        );
      },
    );

    softphoneTest('nothing to resume: Open is the agent’s', (h) {
      expect(h.host.count('open'), 0);
      expect(h.launcher.started, isEmpty);
      expect(h.view.screen, const SoftphoneScreenClosed());
      h.run(h.actions.open());
      expect(h.host.count('open'), 1);
      expect(h.view.screen, const SoftphoneScreenActive());
    });

    softphoneTest(
      'in the background it waits for the app to come back',
      (h) {
        expect(h.host.count('open'), 0);
        h.lifecycle.show();
        h.pump();
        expect(h.host.count('open'), 1);
      },
      foreground: false,
      before: (h) {
        h.rememberHosted('sess-sp');
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'session': sessionSummary()}));
      },
    );

    softphoneTest(
      'put off in the background, it asks the server again on return: a session closed meanwhile is not reopened',
      (h) {
        expect(h.host.count('open'), 0);
        // While away, the session is closed elsewhere (the web, the reaper).
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson());
        h.async.elapse(const Duration(hours: 2));
        final before = h.bootstraps.length;
        h.lifecycle.show();
        h.pump();
        expect(h.bootstraps.length, before + 1);
        expect(h.host.count('open'), 0);
        expect(h.view.screen, const SoftphoneScreenClosed());
      },
      foreground: false,
      before: (h) {
        h.rememberHosted('sess-sp');
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'session': sessionSummary()}));
      },
    );

    softphoneTest(
      'once per workspace: a session this phone stops hosting is not reopened behind the agent',
      (h) {
        expect(h.host.count('open'), 1);
        h.host.view = null;
        h.pump();
        expect(h.host.count('open'), 1);
        expect(h.view.screen, const SoftphoneScreenOtherDevice(canClose: true));
      },
      before: (h) {
        h.rememberHosted('sess-sp');
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'session': sessionSummary()}));
      },
    );
  });

  group('rule 16b: a session this phone did not host is the agent’s to take', () {
    softphoneTest(
      'a soft-phone session open elsewhere waits for "Use it on this phone"',
      (h) {
        expect(h.host.count('open'), 0);
        expect(h.view.screen, const SoftphoneScreenOtherDevice(canClose: true));
        h.lifecycle.show();
        h.async.elapse(resumeRereadAfter);
        h.lifecycle.show();
        h.pump();
        expect(h.host.count('open'), 0);

        h.run(h.actions.open());
        expect(h.host.count('open'), 1);
        expect(h.view.screen, const SoftphoneScreenActive());
        expect(h.hostedHere(), 'sess-sp');
      },
      before: (h) =>
          h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'session': sessionSummary()})),
    );

    softphoneTest(
      'another session than the one this phone hosted is not resumed either',
      (h) {
        expect(h.host.count('open'), 0);
        expect(h.view.screen, const SoftphoneScreenOtherDevice(canClose: true));
      },
      before: (h) {
        h.rememberHosted('sess-old');
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'session': sessionSummary()}));
      },
    );

    softphoneTest(
      'with a call unfinished there: no Close',
      (h) {
        expect(h.view.screen, const SoftphoneScreenOtherDevice());
        h.run(h.actions.close());
        expect(h.host.count('close'), 0);
        expect(h.host.count('open'), 0);
      },
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(
        200,
        bootstrapJson({'session': sessionSummary(), 'call': owedJson({'session_id': 'sess-sp'})}),
      ),
    );

    softphoneTest(
      '"Close it" closes it where it is, and opens nothing here',
      (h) {
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson());
        h.run(h.actions.close());
        expect(h.host.lastClose, (sessionId: 'sess-sp', accountId: 'a1'));
        expect(h.host.count('open'), 0);
        expect(h.view.screen, const SoftphoneScreenClosed());
      },
      before: (h) =>
          h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'session': sessionSummary()})),
    );

    softphoneTest(
      '"Close it" refused because a call started there meanwhile: Close goes, and says why',
      (h) {
        h.host.closeResult = const SoftphoneCloseCallPending();
        h.run(h.actions.close());
        expect(h.view.screen, const SoftphoneScreenOtherDevice());
        expect(h.view.sessionError, softphoneLeaveBlockedCopy);
      },
      before: (h) =>
          h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'session': sessionSummary()})),
    );

    softphoneTest(
      'a campaign station on the soft phone elsewhere is not started until asked',
      (h) {
        expect(h.launcher.started, isEmpty);
        expect(
          h.view.screen,
          const SoftphoneScreenOtherDevice(campaignId: 'camp-1', campaignName: 'Home Loan Renewals'),
        );
        h.run(h.actions.open());
        expect(h.launcher.started, ['camp-1']);
        expect(h.host.count('open'), 0);
      },
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(
        200,
        bootstrapJson({
          'session': sessionSummary(kind: 'campaign', campaignId: 'camp-1', campaignName: 'Home Loan Renewals'),
          'call': owedJson({'session_id': 'sess-1'}),
        }),
      ),
    );

    softphoneTest('the phone remembers the session it hosts, until another device takes it or it ends', (h) {
      expect(h.hostedHere(), isNull);
      h.host.view = hostView();
      h.pump();
      expect(h.hostedHere(), 'sess-sp');
      h.host.view = copyHost(h.host.view!, link: StationLink.superseded);
      h.pump();
      expect(h.hostedHere(), isNull);
      h.host.view = copyHost(h.host.view!, link: StationLink.open);
      h.pump();
      expect(h.hostedHere(), 'sess-sp');
      h.host.view = null;
      h.pump();
      expect(h.hostedHere(), isNull);
      h.host.view = campaignHost(onSoftphone: false);
      h.pump();
      expect(h.hostedHere(), 'sess-1');
    });
  });

  // ─── Availability ─────────────────────────────────────────────────────────

  group('the Phone tab’s availability', () {
    softphoneTest(
      '403 (no dial permission) is hidden',
      (h) {
        expect(h.availability, const SoftphoneAvailability(loaded: true));
        expect(h.view.screen, const SoftphoneScreenOff());
        expect(h.requests('GET', callsPath), isEmpty);
      },
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] =
          (_) => json(403, {'error': 'Forbidden', 'message': 'Not allowed'}),
    );

    softphoneTest('on: visible, and new calls may start', (h) {
      expect(h.availability, const SoftphoneAvailability(visible: true, startAllowed: true, loaded: true));
    });

    softphoneTest(
      'no answer yet is hidden',
      (h) => expect(h.availability, SoftphoneAvailability.hidden),
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => Completer<http.Response>().future,
    );

    softphoneTest(
      'off with nothing to finish is hidden',
      (h) => expect(h.availability.visible, isFalse),
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] =
          (_) => json(200, bootstrapJson({'softphone_enabled': false})),
    );

    softphoneTest(
      'off with a session to finish stays visible, in finish mode',
      (h) => expect(h.availability, const SoftphoneAvailability(visible: true, loaded: true)),
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(
        200,
        bootstrapJson({'softphone_enabled': false, 'session': sessionSummary(account: 'a2')}),
      ),
    );

    softphoneTest(
      'the host holding a soft-phone session, or a station on the soft phone, shows it whatever the bootstrap said',
      (h) {
        h.host.view = hostView();
        h.pump();
        expect(h.availability.visible, isTrue);
        h.host.view = campaignHost();
        h.pump();
        expect(h.availability.visible, isTrue);
        h.host.view = campaignHost(onSoftphone: false);
        h.pump();
        expect(h.availability.visible, isFalse);
      },
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(403, {'message': 'no'}),
    );

    softphoneTest('re-read on a workspace change, in the new account', (h) {
      final before = h.bootstraps.length;
      h.run(h.gate.switchAccount(pune));
      expect(h.bootstraps.length, before + 1);
      expect(h.bootstraps.last.account, 'a2');
    });

    softphoneTest('re-read on return to the app at most every 5 minutes', (h) {
      final before = h.bootstraps.length;
      h.async.elapse(const Duration(minutes: 1));
      h.lifecycle.show();
      h.pump();
      expect(h.bootstraps.length, before);
      h.async.elapse(resumeRereadAfter);
      h.lifecycle.show();
      h.pump();
      expect(h.bootstraps.length, before + 1);
    });

    softphoneTest('re-read after the station closes', (h) {
      h.host.view = campaignHost(onSoftphone: false);
      h.pump();
      final before = h.bootstraps.length;
      h.host.view = null;
      h.pump();
      expect(h.bootstraps.length, before + 1);
    });

    softphoneTest('the app leaving the foreground keeps unsent notes on the phone', (h) {
      h.openWith(call: bridged());
      h.actions.setNotes('Half a sentence');
      h.lifecycle.hide();
      h.pump();
      expect(h.store.entries['manual:mc-1']?.notes, 'Half a sentence');
    });
  });

  // ─── Screen states ────────────────────────────────────────────────────────

  group('the Phone tab’s screen', () {
    Map<String, Object?> onCampaignRefusal(String account, {String? accountName}) => {
      'session_id': 'sess-1',
      'campaign_id': 'camp-1',
      'campaign_name': 'Home Loan Renewals',
      'state': 'on_call',
      'account_id': account,
      'account_name': accountName,
      'message': 'Live on a campaign',
    };

    softphoneTest('live on a campaign in an account the agent has: name it and offer the switch', (h) {
      h.host.openResult = SoftphoneOpenOnCampaign(SoftphoneSessionOnCampaignRefusal.fromJson(onCampaignRefusal('a2')));
      h.run(h.actions.open());
      final s = h.view.screen as SoftphoneScreenOnCampaign;
      expect(s.campaignName, 'Home Loan Renewals');
      expect(s.stateLabel, 'On a call');
      expect(s.accountName, 'Pune');
      expect(s.sameAccount, isFalse);
      expect(s.hostedHere, isFalse);
      expect(s.canSwitchAccount, isTrue);
      expect(h.run(h.actions.switchToSoftphone()), isFalse);

      final before = h.bootstraps.length;
      h.run(h.actions.requestAccountSwitch('a2'));
      expect(h.gate.switches, [pune]);
      expect(h.bootstraps.length, before + 1);
    });

    softphoneTest('live on a campaign in an account the agent does not have: no switch to offer', (h) {
      h.host.openResult = SoftphoneOpenOnCampaign(
        SoftphoneSessionOnCampaignRefusal.fromJson(onCampaignRefusal('a9', accountName: 'Kochi')),
      );
      h.run(h.actions.open());
      final s = h.view.screen as SoftphoneScreenOnCampaign;
      expect(s.accountName, 'Kochi');
      expect(s.canSwitchAccount, isFalse);
      h.run(h.actions.requestAccountSwitch('a9'));
      expect(h.gate.switches, isEmpty);
    });

    softphoneTest('the same account, not on this phone: switch it, then open its station here', (h) {
      h.host.openResult = SoftphoneOpenOnCampaign(SoftphoneSessionOnCampaignRefusal.fromJson(onCampaignRefusal('a1')));
      h.reply('POST /proxy/agency/sessions/sess-1/softphone', {
        'campaign_id': 'camp-1',
        'session_id': 'sess-1',
        'kind': 'campaign',
        'state': 'on_call',
        'since': '2026-10-30T10:00:00.000Z',
        'pending_state': 'break',
        'break_reason': 'soft_phone',
      });
      h.run(h.actions.open());
      expect((h.view.screen as SoftphoneScreenOnCampaign).sameAccount, isTrue);
      expect(h.run(h.actions.switchToSoftphone()), isTrue);
      expect(h.requests('POST', '/proxy/agency/sessions/sess-1/softphone'), hasLength(1));
      expect(h.launcher.started, ['camp-1']);
    });

    softphoneTest('a station hosted here: the switch is the host’s', (h) {
      h.host.view = campaignHost(onSoftphone: false);
      h.pump();
      final s = h.view.screen as SoftphoneScreenOnCampaign;
      expect(s.hostedHere, isTrue);
      expect(s.stateLabel, 'Available');
      expect(h.run(h.actions.switchToSoftphone()), isTrue);
      expect(h.host.count('switch'), 1);
      h.host.switchResult = const SoftphoneSwitchRefused('Couldn’t change your status just now; nothing changed. Try again.');
      expect(h.run(h.actions.switchToSoftphone()), isFalse);
      expect(h.view.sessionError, contains('nothing changed'));
    });

    softphoneTest('a station hosted here already on the soft phone: nothing to switch, only the station', (h) {
      h.host.view = campaignHost();
      h.pump();
      final s = h.view.screen as SoftphoneScreenOnCampaign;
      expect(s.hostedHere, isTrue);
      expect(s.onSoftphone, isTrue);
      expect(h.run(h.actions.switchToSoftphone()), isFalse);
      expect(h.host.count('switch'), 0);
    });

    softphoneTest(
      'in finish mode a station hosted here is not switched to the soft phone',
      (h) {
        h.host.view = campaignHost(onSoftphone: false);
        h.pump();
        expect(h.view.startAllowed, isFalse);
        expect(h.run(h.actions.switchToSoftphone()), isFalse);
        expect(h.host.count('switch'), 0);
      },
      before: (h) => h.routes[bootstrapPath] = (_) => json(200, bootstrapJson({'softphone_enabled': false})),
    );

    softphoneTest('open elsewhere: closing it is blocked while its call is unfinished', (h) {
      h.host.openResult = const SoftphoneOpenElsewhere(SessionOnSoftphoneRefusal(sessionId: 'sess-x', accountId: 'a2'));
      h.run(h.actions.open());
      expect(h.view.screen, const SoftphoneScreenElsewhere(accountId: 'a2', accountName: 'Pune', canSwitchAccount: true));
      h.host.closeResult = const SoftphoneCloseCallPending();
      h.run(h.actions.closeElsewhereAndOpen());
      expect(h.host.lastClose, (sessionId: 'sess-x', accountId: 'a2'));
      expect((h.view.screen as SoftphoneScreenElsewhere).callPending, isTrue);
      expect(h.host.count('open'), 1);

      h.host.closeResult = const SoftphoneClosed();
      h.host.openResult = const SoftphoneOpened(sessionId: 'sess-sp', created: true);
      h.run(h.actions.closeElsewhereAndOpen());
      expect(h.host.count('open'), 2);
      expect(h.view.screen, const SoftphoneScreenActive());
    });

    softphoneTest(
      'off here and open in another account: stranded, with its owed call read where it lives',
      (h) {
        final s = h.view.screen as SoftphoneScreenOffStranded;
        expect(s.accountId, 'a2');
        expect(s.accountName, 'Pune');
        expect(s.callOwed, isTrue);
        h.run(h.actions.closeStranded());
        expect(h.host.lastClose, (sessionId: 'sess-sp', accountId: 'a2'));
      },
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] = (req) => json(
        200,
        req.account == 'a2'
            ? bootstrapJson({'softphone_enabled': false, 'session': sessionSummary(account: 'a2'), 'call': owedJson()})
            : bootstrapJson({'softphone_enabled': false, 'session': sessionSummary(account: 'a2')}),
      ),
    );

    softphoneTest('off with nothing here: not available', (h) {
      expect(h.view.screen, const SoftphoneScreenOff());
    }, before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson({'softphone_enabled': false})));

    softphoneTest(
      'a bootstrap that fails is an error with Retry',
      (h) {
        expect(h.view.screen, isA<SoftphoneScreenError>());
        h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson());
        h.run(h.actions.retry());
        expect(h.view.screen, const SoftphoneScreenClosed());
      },
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(500, {'message': ''}),
    );

    softphoneTest('Close refuses while a call is on screen, and closes the session otherwise', (h) {
      h.openWith(call: bridged());
      expect(h.view.canClose, isFalse);
      expect(h.view.closeBlockedReason, softphoneLeaveBlockedCopy);
      h.run(h.actions.close());
      expect(h.host.count('close'), 0);
      expect(h.view.sessionError, softphoneLeaveBlockedCopy);

      h.host.frame(ManualCall.fromJson(settledJson(bridged())));
      h.pump();
      final before = h.bootstraps.length;
      h.run(h.actions.close());
      expect(h.host.count('close'), 1);
      expect(h.view.screen, const SoftphoneScreenClosed());
      expect(h.bootstraps.length, before + 1);
    });

    softphoneTest('Return to campaign is refused while a call is on screen, and re-reads on manual_call_live', (h) {
      h.host.view = campaignHost(call: owed({'session_id': 'sess-1'}));
      h.pump();
      expect(h.view.canReturn, isFalse);
      h.run(h.actions.returnToCampaign());
      expect(h.host.count('return'), 0);

      h.host.view = campaignHost();
      h.pump();
      h.host.returnResult = const SoftphoneSwitchRefused('Finish this call and save its outcome first.', code: SoftphoneErrorCode.manualCallLive);
      final before = h.bootstraps.length;
      h.run(h.actions.returnToCampaign());
      expect(h.host.count('return'), 1);
      expect(h.view.sessionError, 'Finish this call and save its outcome first.');
      expect(h.bootstraps.length, before + 1);
    });
  });

  group('what the screens read during a call', () {
    softphoneTest('the number and the caller ID are the call’s', (h) {
      h.openWith(call: ringing({'caller_id': '+912248901121'}));
      expect(h.view.number, '+919820461733');
      expect(h.view.numberDisplay, '+91 98204 61733');
      expect(h.view.callerId, '+912248901121');
      expect(h.view.callerIds.single.label, '+91 22489 01121');
    });

    softphoneTest('a call logged to a campaign no longer taggable still finds it in Log to', (h) {
      h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(
        200,
        bootstrapJson({'call_campaign': {...campaignJson, 'campaign_id': 'camp-old', 'campaign_name': 'Diwali drive', 'status': 'completed'}}),
      );
      h.run(h.actions.retry());
      h.openWith(call: owed({'tag': {'campaign_id': 'camp-old', 'campaign_name': 'Diwali drive'}}));
      expect(h.view.tagCampaignId, 'camp-old');
      expect(h.view.campaigns.map((c) => c.campaignId), ['camp-1', 'camp-old']);
      expect(h.view.campaigns.last.name, 'Diwali drive (completed)');
      // Its own outcomes, through call_campaign.
      expect(h.view.outcomes.first.code, 'interested');

      // Not described at all: the call's own tag, by name.
      h.host.frame(owed({
        'id': 'mc-2',
        'tag': {'campaign_id': 'camp-x', 'campaign_name': 'Gone'},
        'created_at': '2026-10-30T10:05:00.000Z',
        'updated_at': '2026-10-30T10:06:00.000Z',
      }));
      h.pump();
      expect(h.view.campaigns.last.campaignId, 'camp-x');
      expect(h.view.campaigns.last.name, 'Gone');

      // Back to Ready: only what may be tagged.
      h.host.frame(ManualCall.fromJson({...settledJson(owed({'id': 'mc-2'})), 'updated_at': '2026-10-30T10:07:00.000Z'}));
      h.pump();
      expect(h.view.campaigns.map((c) => c.campaignId), ['camp-1']);
    });

    softphoneTest(
      'no fields until the field set has loaded',
      (h) {
        h.openWith(call: bridged({'fields': {'customer_name': 'Asha'}}));
        expect(h.view.fields, isEmpty);
      },
      before: (h) => h.routes['GET /proxy/agency/softphone/bootstrap'] = (_) => Completer<http.Response>().future,
    );

    softphoneTest(
      'a microphone refused for good blocks Open, until it is allowed again',
      (h) {
        expect(h.view.screen, const SoftphoneScreenClosed(microphoneBlocked: true));
        h.mic.mic = MicPermission.granted;
        h.lifecycle.show();
        h.pump();
        expect(h.view.screen, const SoftphoneScreenClosed());
      },
      before: (h) => h.mic.mic = MicPermission.permanentlyDenied,
    );

    softphoneTest('a plain refusal is the screen’s to handle: Open is still offered', (h) {
      h.mic.mic = MicPermission.denied;
      h.lifecycle.show();
      h.pump();
      expect(h.mic.reads, 2);
      expect(h.view.screen, const SoftphoneScreenClosed());
    });
  });

  softphoneTest('the matched contact’s name reaches the host for CallKit', (h) {
    h.openWith(
      call: bridged({
        'tag': tag,
        'contact': {
          'contact_id': 'c-1',
          'state': 'in_progress',
          'claimed': true,
          'context': {'Name': 'Rahul Verma', 'Loan account': 'HL-2231'},
          'prior_attempts': <Object?>[],
        },
      }),
    );
    expect(h.host.displayNames['mc-1'], 'Rahul Verma');
    expect(h.view.contact!.displayName, 'Rahul Verma');
    expect(h.view.rail.label, 'On call with Rahul Verma');
  });
}
