import 'package:agency_wire/agency_wire.dart';
import 'package:agent_audio/agent_audio.dart' as audio;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_host.dart';
import 'package:magick_agency_agent/core/station/station_copy.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import '../softphone/manual_calls.dart' as mc;
import 'controller_harness.dart';
import 'fixtures.dart';

/// The station core as the soft phone's session host: a soft-phone session on
/// the one socket, audio engine and on-duty service, and a campaign station
/// switched to the soft phone (SP7).

const _hangup = '/proxy/agency/softphone/calls/mc-1/hangup';
const _bootstrap = '/proxy/agency/softphone/bootstrap';

/// The `ready` a soft-phone session's socket sends.
void _ready(App app) =>
    app.frame({'event': 'ready', 'session_id': 'sess-sp', 'state': 'break', 'break_reason': 'soft_phone'});

/// A soft-phone session, open and ready.
App _softphone(FakeAsync async) {
  final app = App(async);
  expect(app.openSoftphone(), isA<SoftphoneOpened>());
  _ready(app);
  return app;
}

/// The call one step on, as the frame carries it.
Map<String, Object?> _at(int seconds, Map<String, Object?> over) =>
    mc.manualCallJson({'updated_at': '2026-10-30T10:00:${seconds.toString().padLeft(2, '0')}.000Z', ...over});

final _queued = mc.manualCallJson();
final _ringing = _at(2, {'state': 'ringing'});
final _answered = _at(4, {'state': 'answered', 'answered_at': '2026-10-30T10:00:04.000Z'});
final _bridged = _at(5, {
  'state': 'bridged',
  'answered_at': '2026-10-30T10:00:04.000Z',
  'bridged_at': '2026-10-30T10:00:05.000Z',
});
final _owed = _at(40, {
  'state': 'ended',
  'end_reason': 'remote_hangup',
  'answered_at': '2026-10-30T10:00:04.000Z',
  'bridged_at': '2026-10-30T10:00:05.000Z',
  'ended_at': '2026-10-30T10:00:40.000Z',
  'requires_disposition': true,
  'outcome_due_at': '2026-11-01T09:30:00.000Z',
});
final _settled = _at(50, {
  'state': 'ended',
  'end_reason': 'remote_hangup',
  'bridged_at': '2026-10-30T10:00:05.000Z',
  'ended_at': '2026-10-30T10:00:40.000Z',
  'disposition_code': 'resolved',
  'settled_at': '2026-10-30T10:00:50.000Z',
});

void main() {
  group('open, rehydrate and close', () {
    test('open: the session, its socket, the "Soft phone" notification and audio; no campaign view', () {
      fakeAsync((async) {
        final app = _softphone(async);
        expect(app.requests('POST', '/proxy/agency/softphone/sessions'), hasLength(1));
        expect(app.socket.url.toString(), 'wss://api.test/proxy/agency/station?token=sp&client=mobile&media=alaw8');
        expect(app.mints, 0, reason: 'the URL carries its token');
        expect(app.view, isNull, reason: 'a soft-phone session has no campaign view');
        final host = app.hostView!;
        expect(host.sessionId, 'sess-sp');
        expect(host.kind, SessionKind.softphone);
        expect(host.accountId, 'acc-1');
        expect(host.link, StationLink.open);
        expect(host.everOpened, isTrue);
        expect(host.onSoftphone, isTrue);
        expect(host.call, isNull);
        expect(app.engine.calls.take(2), ['fgs.start', 'prepare']);
        expect(app.engine.notification!.title, 'Soft phone');
        expect(app.engine.notification!.text, 'Ready to dial');
        expect(app.engine.notification!.call, isNull);
        expect(app.wakeLock.on, isFalse, reason: 'an idle soft phone lets the screen sleep');
        app.dispose();
      });
    });

    test('a URL that carries no token: one is minted before connecting', () {
      fakeAsync((async) {
        final app = App(async);
        app.routes['POST /proxy/agency/softphone/sessions'] =
            (_) => json(200, softphoneSessionJson(stationWsUrl: '/proxy/agency/station/sess-sp'));
        app.openSoftphone();
        expect(app.mints, 1);
        expect(app.socket.url.queryParameters['token'], 'mint1');
        app.dispose();
      });
    });

    test('opening again while open is the same session; a rehydrate after a restart reconnects to it', () {
      fakeAsync((async) {
        final app = _softphone(async);
        final again = app.openSoftphone() as SoftphoneOpened;
        expect(again.sessionId, 'sess-sp');
        expect(app.requests('POST', '/proxy/agency/softphone/sessions'), hasLength(1));
        app.dispose();
      });
    });

    test('refusals: on a campaign, open elsewhere, switched off, or a fault worth retrying', () {
      fakeAsync((async) {
        final app = App(async);
        const path = 'POST /proxy/agency/softphone/sessions';
        app.routes[path] = (_) => json(409, {
              'code': 'session_on_campaign',
              'message': 'You are live on Renewals.',
              'session_id': 'sess-1',
              'campaign_id': 'camp-1',
              'campaign_name': 'Renewals',
              'state': 'available',
              'account_id': 'acc-2',
              'account_name': 'North',
            });
        final onCampaign = app.openSoftphone() as SoftphoneOpenOnCampaign;
        expect(onCampaign.refusal.accountId, 'acc-2');
        app.routes[path] = (_) => json(409, {
              'code': 'session_on_softphone',
              'message': 'Open in North.',
              'session_id': 'sp-9',
              'account_id': 'acc-2',
              'account_name': 'North',
            });
        final elsewhere = app.openSoftphone() as SoftphoneOpenElsewhere;
        expect((elsewhere.refusal.sessionId, elsewhere.refusal.accountId), ('sp-9', 'acc-2'));
        app.routes[path] = (_) => json(403, {'code': 'softphone_disabled', 'message': 'Off.'});
        expect(app.openSoftphone(), isA<SoftphoneOpenDisabled>());
        app.routes[path] = (_) => json(503, {'message': 'Down for a moment.'});
        final refused = app.openSoftphone() as SoftphoneOpenRefused;
        expect(refused.retryable, isTrue);
        expect(refused.message, 'Down for a moment.');
        expect(app.hostView, isNull);
        expect(app.engine.calls, isEmpty, reason: 'nothing opened');
        app.dispose();
      });
    });

    test('close: the bootstrap is read in the session’s account first; no call, so it is left and torn down here', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.routes['GET $_bootstrap'] = (_) => json(200, mc.bootstrapJson({
              'session': {
                'session_id': 'sess-sp',
                'account_id': 'acc-1',
                'kind': 'softphone',
                'state': 'break',
                'break_reason': 'soft_phone',
                'on_softphone': true,
              },
            }));
        app.routes['POST /proxy/agency/sessions/sess-sp/leave'] = (_) => json(200, stateBody('offline'));
        expect(app.run(app.controller.closeSoftphone()), isA<SoftphoneClosed>());
        expect(app.requests('GET', _bootstrap).single.headers['x-account-id'], 'acc-1');
        expect(app.requests('POST', '/proxy/agency/sessions/sess-sp/leave'), hasLength(1));
        async.flushMicrotasks();
        expect(app.hostView, isNull);
        expect(app.signals, const StationSignals());
        expect(app.engine.calls.last, 'fgs.stop');
        app.dispose();
      });
    });

    test('close refuses while the call owes its outcome: nothing is left, and the call is held', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.routes['GET $_bootstrap'] = (_) => json(200, mc.bootstrapJson({'call': _owed}));
        final r = app.run(app.controller.closeSoftphone()) as SoftphoneCloseCallPending;
        expect(r.call!.id, 'mc-1');
        expect(app.requests('POST', '/proxy/agency/sessions/sess-sp/leave'), isEmpty);
        expect(app.hostView!.outcomeOwed, isTrue);
        expect(app.signals.outcomeOwed, isTrue);
        app.dispose();
      });
    });

    test('close with the bootstrap unreadable still refuses over the call this phone holds', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.manualCallFrame(_owed);
        app.routes['GET $_bootstrap'] = (_) => json(503, {'message': 'down'});
        expect(app.run(app.controller.closeSoftphone()), isA<SoftphoneCloseCallPending>());
        expect(app.requests('POST', '/proxy/agency/sessions/sess-sp/leave'), isEmpty);
        app.dispose();
      });
    });
  });

  group('joining a campaign with the soft phone open (closeSoftphoneAndStart)', () {
    test('refused while the call there owes its outcome, read in the session’s own account; nothing is closed', () {
      fakeAsync((async) {
        final app = App(async);
        app.routes['GET $_bootstrap'] = (r) => json(200, mc.bootstrapJson({
              'session': {
                'session_id': 'sp-1',
                'account_id': 'acc-2',
                'kind': 'softphone',
                'state': 'break',
                'break_reason': 'soft_phone',
                'on_softphone': true,
              },
              'call': {..._owed, 'session_id': 'sp-1'},
            }));
        const sp = StationOnSoftphone(sessionId: 'sp-1', accountId: 'acc-2');
        final r = app.run(app.controller.closeSoftphoneAndStart(sp, 'camp-1', campaignName: 'Renewals')) as StationRefused;
        expect(r.message, softphoneCallPendingCopy);
        expect(app.requests('GET', _bootstrap).single.headers['x-account-id'], 'acc-2');
        expect(app.requests('POST', '/proxy/agency/sessions/sp-1/leave'), isEmpty, reason: 'leave would let the outcome lapse');
        expect(app.requests('POST', '/proxy/agency/sessions'), isEmpty);
        app.dispose();
      });
    });

    test('the bootstrap names the session in a sibling account: re-read and left there, then joined', () {
      fakeAsync((async) {
        final app = App(async);
        app.routes['GET $_bootstrap'] = (r) => json(200, mc.bootstrapJson({
              'session': {
                'session_id': 'sp-1',
                'account_id': 'acc-2',
                'kind': 'softphone',
                'state': 'break',
                'break_reason': 'soft_phone',
                'on_softphone': true,
              },
            }));
        app.routes['POST /proxy/agency/sessions/sp-1/leave'] = (_) => json(200, stateBody('offline'));
        // A refusal from an older server that named no account.
        const sp = StationOnSoftphone(sessionId: 'sp-1');
        expect(app.run(app.controller.closeSoftphoneAndStart(sp, 'camp-1', campaignName: 'Renewals')), isA<StationStarted>());
        expect(app.requests('GET', _bootstrap).map((r) => r.headers['x-account-id']), ['acc-1', 'acc-2']);
        expect(app.requests('POST', '/proxy/agency/sessions/sp-1/leave').single.headers['x-account-id'], 'acc-2');
        app.dispose();
      });
    });

    test('the soft phone this phone hosts is closed here too, then the station opens', () {
      fakeAsync((async) {
        final app = _softphone(async);
        final spSocket = app.socket;
        app.routes['GET $_bootstrap'] = (_) => json(200, mc.bootstrapJson());
        app.routes['POST /proxy/agency/sessions/sess-sp/leave'] = (_) => json(200, stateBody('offline'));
        const sp = StationOnSoftphone(sessionId: 'sess-sp', accountId: 'acc-1');
        expect(app.run(app.controller.closeSoftphoneAndStart(sp, 'camp-1', campaignName: 'Renewals')), isA<StationStarted>());
        async.flushMicrotasks();
        expect(spSocket.closed, isTrue);
        expect(app.view!.campaignId, 'camp-1');
        expect(app.hostView!.kind, SessionKind.campaign);
        expect(app.signals.sessionKind, StationSessionKind.campaign);
        app.dispose();
      });
    });
  });

  group('signals and the host view', () {
    test('idle, live, owed and settled soft-phone calls', () {
      fakeAsync((async) {
        final app = _softphone(async);
        expect(app.signals, const StationSignals(onDuty: true, onBreak: true, sessionKind: StationSessionKind.softphone));
        expect(app.signals.holdsStation, isFalse, reason: 'an idle soft phone never holds the tabs');
        expect(app.signals.home, StationHome.phone);

        app.manualCallFrame(_ringing);
        expect(app.signals.callActive, isTrue);
        expect(app.hostView!.callLive, isTrue);
        app.manualCallFrame(_owed);
        expect((app.signals.callActive, app.signals.outcomeOwed), (false, true));
        app.manualCallFrame(_settled);
        expect((app.signals.callActive, app.signals.outcomeOwed), (false, false));
        expect(app.hostView!.call!.isSettled, isTrue, reason: 'kept, so the soft phone sees it settle');
        app.dispose();
      });
    });

    test('a manual_call frame whose row does not read changes nothing', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.manualCallFrame({'id': 'mc-1', 'state': 'ringing'});
        expect(app.hostView!.call, isNull);
        expect(app.hostView!.link, StationLink.open);
        app.dispose();
      });
    });

    test('a campaign station on the soft phone: its home stays the station, and a call there holds it', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('break', breakReason: 'soft_phone');
        expect(app.signals.onSoftphone, isTrue);
        expect(app.signals.sessionKind, StationSessionKind.campaign);
        expect(app.signals.home, StationHome.station);
        expect(app.hostView!.onSoftphone, isTrue);
        expect(app.hostView!.campaignId, 'camp-1');
        expect(app.engine.notification!.text, 'Ready to dial');
        expect(app.engine.notification!.title, 'On duty · Renewals');
        app.manualCallFrame({..._bridged, 'session_id': 'sess-1'});
        expect(app.signals.callActive, isTrue);
        expect(app.engine.notification!.text, 'On a call');
        expect(app.engine.notification!.call, isNotNull, reason: 'Mute and Hang up while the call is on');
        app.dispose();
      });
    });

    test('adopted HTTP copies merge with the frames; a copy of another session’s call is not held', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.controller.adoptManualCall(mc.manualCall(_queued));
        expect(app.hostView!.call!.state, AttemptState.queued);
        app.manualCallFrame(_ringing);
        app.controller.adoptManualCall(mc.manualCall(_queued));
        expect(app.hostView!.call!.state, AttemptState.ringing, reason: 'an older answer never rolls the call back');
        app.controller.adoptManualCall(mc.manualCall({..._bridged, 'id': 'mc-9', 'session_id': 'other'}));
        expect(app.hostView!.call!.id, 'mc-1');
        // The bootstrap said "no call" for the copy held when it was asked.
        final key = app.hostView!.call!.versionKey;
        app.manualCallFrame(_answered);
        app.controller.retireManualCall(key);
        expect(app.hostView!.call!.state, AttemptState.answered, reason: 'a newer frame is kept');
        app.controller.retireManualCall(app.hostView!.call!.versionKey);
        expect(app.hostView!.call, isNull);
        app.dispose();
      });
    });
  });

  group('audio', () {
    test('armed when placed, ringback only while ringing, uplink only from bridged_at, CallKit told how it ended', () {
      fakeAsync((async) {
        final app = _softphone(async);
        final base = app.engine.lifecycle.length;
        app.manualCallFrame(_queued);
        expect(app.engine.lifecycle.skip(base), ['startCall', 'arm']);
        expect(app.engine.startedCalls.single.callId, 'mc-1');
        app.manualCallFrame(_ringing);
        expect(app.engine.ringback, isTrue);
        expect(app.engine.notification!.text, 'Calling…');
        app.manualCallFrame(_answered);
        expect(app.engine.ringback, isFalse);
        expect(app.engine.calls, isNot(contains('uplink')), reason: 'answered is not audio both ways');
        app.manualCallFrame(_bridged);
        expect(app.engine.lifecycle.skip(base), ['startCall', 'arm', 'ringback.on', 'ringback.off', 'uplink', 'connected']);
        expect(app.engine.notification!.text, 'On a call');
        app.manualCallFrame({..._owed, 'end_reason': 'agent_hangup'});
        expect(app.engine.endedCalls.single, (callId: 'mc-1', reason: audio.CallEndReason.local));
        expect(app.engine.notification!.text, 'Outcome needed');
        app.dispose();
      });
    });

    test('Mute ring silences the ringback for this call only; the next call rings again', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.manualCallFrame(_ringing);
        expect(app.engine.ringback, isTrue);
        app.controller.setRingMuted(true);
        async.flushMicrotasks();
        expect(app.engine.ringback, isFalse);
        expect(app.hostView!.ringMuted, isTrue);
        expect(app.engine.muted, isFalse, reason: 'the ring, not the microphone');
        app.manualCallFrame(_at(20, {'state': 'ended', 'end_reason': 'no_answer', 'settled_at': '2026-10-30T10:00:20.000Z'}));
        app.manualCallFrame(mc.manualCallJson({
          'id': 'mc-2',
          'state': 'ringing',
          'created_at': '2026-10-30T10:01:00.000Z',
          'updated_at': '2026-10-30T10:01:02.000Z',
        }));
        expect(app.hostView!.ringMuted, isFalse);
        expect(app.engine.ringback, isTrue);
        app.dispose();
      });
    });

    test('a campaign attempt wins over a stale manual copy', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('break', extra: {'break_reason': 'soft_phone'});
        app.manualCallFrame({..._ringing, 'session_id': 'sess-1'});
        app.readyFrame('available');
        app.reserved('att-1');
        expect(app.engine.startedCalls.last.callId, 'att-1');
        expect(app.engine.ringback, isFalse);
        app.dispose();
      });
    });
  });

  group('system hang-up (CallKit, the notification)', () {
    test('ends the soft-phone call at once, with no hold to confirm', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.routes['POST $_hangup'] = (_) => json(200, _bridged);
        app.manualCallFrame(_bridged);
        app.engine.emitEvent(const audio.CallSystemAction(
          kind: audio.CallActionKind.end,
          source: audio.CallActionSource.notification,
        ));
        async.flushMicrotasks();
        expect(app.requests('POST', _hangup), hasLength(1));
        expect(app.requests('POST', _hangup).single.headers['x-account-id'], 'acc-1');
        app.dispose();
      });
    });

    test('with nothing on the line, nothing is hung up', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.manualCallFrame(_owed);
        app.run(app.controller.hangUp());
        expect(app.requests('POST', _hangup), isEmpty);
        app.dispose();
      });
    });
  });

  group('leaving the app', () {
    test('an idle soft phone: no device_away ever, even before its first ready; pings stop', () {
      fakeAsync((async) {
        final app = App(async);
        app.openSoftphone();
        // No `ready` yet: the state reads offline, which would pause a campaign station.
        app.lifecycle.hide();
        async.flushMicrotasks();
        _ready(app);
        final pings = app.socket.pings.length;
        async.elapse(const Duration(seconds: 60));
        expect(app.sent.where((r) => r.path.endsWith('/break')), isEmpty);
        expect(app.socket.pings.length, pings, reason: 'nothing needs the socket while idle and away');
        expect(app.notifier.calls.where((c) => c != 'cancel'), isEmpty);
        app.dispose();
      });
    });

    test('mid-call in the background: app pings go on and a dropped socket is retried at once', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.manualCallFrame(_bridged);
        app.lifecycle.hide();
        async.flushMicrotasks();
        final pings = app.socket.pings.length;
        async.elapse(const Duration(seconds: 30));
        expect(app.socket.pings.length, greaterThan(pings));
        expect(app.sent.where((r) => r.path.endsWith('/break')), isEmpty);
        app.socket.serverClose(1006);
        async.elapse(const Duration(seconds: 2));
        expect(app.connector.attempts, 2, reason: 'retried without waiting for the app to come back');
        app.dispose();
      });
    });

    test('an owed outcome in the background: "Save the outcome by …", cleared on return; pings go on', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.manualCallFrame(_owed);
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.notifier.calls.last, 'wrapup:2026-11-01T09:30:00.000Z');
        final pings = app.socket.pings.length;
        async.elapse(const Duration(seconds: 30));
        expect(app.socket.pings.length, greaterThan(pings));
        app.lifecycle.show();
        expect(app.notifier.calls.last, 'cancel');
        app.dispose();
      });
    });

    test('the wake lock: on only while a call is live or owed', () {
      fakeAsync((async) {
        final app = _softphone(async);
        expect(app.wakeLock.on, isFalse);
        app.manualCallFrame(_ringing);
        expect(app.wakeLock.on, isTrue);
        app.manualCallFrame(_owed);
        expect(app.wakeLock.on, isTrue);
        app.manualCallFrame(_settled);
        expect(app.wakeLock.on, isFalse);
        app.dispose();
      });
    });
  });

  group('a dropped socket mid-call', () {
    test('while ringing there is no countdown (the server ends it at once)', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.manualCallFrame(_ringing);
        app.socket.serverClose(1006);
        expect(app.hostView!.link, StationLink.reconnecting);
        expect(app.hostView!.reconnectDeadline, isNull);
        app.dispose();
      });
    });

    test('once answered, the 8 s the server holds it', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.manualCallFrame(_answered);
        app.socket.serverClose(1006);
        expect(app.hostView!.reconnectDeadline, app.now().add(const Duration(seconds: 8)));
        _ready(app);
        expect(app.hostView!.reconnectDeadline, isNull);
        app.dispose();
      });
    });
  });

  group('switch, cancel and return (SP7)', () {
    const switchPath = '/proxy/agency/sessions/sess-1/softphone';
    const returnPath = '/proxy/agency/sessions/sess-1/softphone/return';

    test('switch applied now, then back to the campaign', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.routes['POST $switchPath'] = (_) => json(200, stateBody('break', breakReason: 'soft_phone'));
        expect(app.run(app.controller.switchToSoftphone()), isA<SoftphoneSwitchApplied>());
        app.agentStateFrame('break', breakReason: 'soft_phone');
        expect(app.hostView!.onSoftphone, isTrue);
        app.routes['POST $returnPath'] = (_) => json(200, stateBody('available'));
        expect(app.run(app.controller.returnToCampaign()), isA<SoftphoneSwitchApplied>());
        expect(app.requests('POST', returnPath), hasLength(1));
        app.dispose();
      });
    });

    test('switch mid-call is queued, shown, and can be withdrawn', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.routes['POST $switchPath'] =
            (_) => json(200, stateBody('on_call', breakReason: 'soft_phone', pending: 'break'));
        expect(app.run(app.controller.switchToSoftphone()), isA<SoftphoneSwitchQueued>());
        expect(app.hostView!.switchQueued, isTrue);
        expect(app.view!.queuedBreak!.label, 'Soft phone');
        app.routes['POST /proxy/agency/sessions/sess-1/break/cancel'] = (_) => json(200, stateBody('on_call'));
        expect(app.run(app.controller.cancelSwitch()), isA<SoftphoneSwitchApplied>());
        expect(app.hostView!.switchQueued, isFalse);
        app.dispose();
      });
    });

    test('return refused manual_call_live: the call that blocks it is held; dial_failed says the status did not change', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('break', extra: {'break_reason': 'soft_phone'});
        app.routes['POST $returnPath'] = (_) => json(409, {
              'code': 'manual_call_live',
              'message': 'A soft-phone call is live.',
              'call': {..._owed, 'session_id': 'sess-1'},
            });
        final refused = app.run(app.controller.returnToCampaign()) as SoftphoneSwitchRefused;
        expect(refused.code, SoftphoneErrorCode.manualCallLive);
        expect(refused.message, softphoneManualCallLiveCopy);
        expect(refused.call!.id, 'mc-1');
        expect(app.hostView!.outcomeOwed, isTrue);
        expect(app.signals.outcomeOwed, isTrue);

        app.routes['POST $returnPath'] = (_) => json(503, {'code': 'dial_failed', 'message': 'Nothing was dialled.'});
        final failed = app.run(app.controller.returnToCampaign()) as SoftphoneSwitchRefused;
        expect(failed.code, SoftphoneErrorCode.dialFailed);
        expect(failed.message, softphoneStatusFailedCopy);
        app.dispose();
      });
    });

    test('a soft-phone session has no campaign to switch from or return to', () {
      fakeAsync((async) {
        final app = _softphone(async);
        expect(app.run(app.controller.switchToSoftphone()), isA<SoftphoneSwitchRefused>());
        expect(app.run(app.controller.returnToCampaign()), isA<SoftphoneSwitchRefused>());
        expect(app.sent.where((r) => r.path.contains('/softphone/return')), isEmpty);
        app.dispose();
      });
    });
  });

  group('the session ends or moves (4404, 4409)', () {
    test('4404: off duty here; Reconnect opens the soft phone again', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.socket.serverClose(4404);
        async.flushMicrotasks();
        expect(app.hostView!.link, StationLink.sessionGone);
        expect(app.signals, const StationSignals());
        expect(app.engine.calls.last, 'fgs.stop');
        app.run(app.controller.reconnect());
        async.flushMicrotasks();
        expect(app.requests('POST', '/proxy/agency/softphone/sessions'), hasLength(2));
        expect(app.requests('POST', '/proxy/agency/sessions'), isEmpty, reason: 'never a campaign join');
        expect(app.hostView!.link, StationLink.open);
        app.dispose();
      });
    });

    test('4409 mid-call: nothing held here, nothing hung up from here; Use this phone takes it back', () {
      fakeAsync((async) {
        final app = _softphone(async);
        app.routes['POST $_hangup'] = (_) => json(200, _bridged);
        app.manualCallFrame(_bridged);
        app.socket.serverClose(4409);
        async.flushMicrotasks();
        expect(app.hostView!.link, StationLink.superseded);
        expect(app.signals, const StationSignals());
        app.run(app.controller.hangUp());
        app.run(app.controller.hangUpManual());
        expect(app.requests('POST', _hangup), isEmpty);
        app.run(app.controller.useThisDevice());
        async.flushMicrotasks();
        expect(app.hostView!.link, StationLink.open);
        expect(app.signals.callActive, isTrue);
        app.dispose();
      });
    });
  });
}
