import 'dart:async';
import 'dart:io' show SocketException;

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/core/station/station_copy.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'controller_harness.dart';

void main() {
  group('join', () {
    test('started: the bootstrap opens the socket, the on-duty service, the pre-warm and the wake lock', () {
      fakeAsync((async) {
        final app = App(async);
        expect(app.start(), isA<StationStarted>());
        final join = app.requests('POST', '/proxy/agency/sessions').single;
        expect(join.body, {'campaign_id': 'camp-1', 'client_kind': 'mobile'});
        expect(app.socket.url.toString(), 'wss://api.test/proxy/agency/station?token=boot&client=mobile&media=alaw8');
        expect(app.view!.link, StationLink.open);
        expect(app.view!.campaignName, 'Renewals');
        expect(app.view!.dispositions.map((d) => d.code), ['interested', 'callback', 'not_interested', 'do_not_call']);
        expect(app.view!.breakOptions.map((b) => b.label), ['Tea break', 'Lunch']);
        expect(app.engine.calls.take(2), ['fgs.start', 'prepare']);
        expect(app.wakeLock.on, isTrue);
        expect(app.tokens.forced, 1, reason: 'the ID token is warmed at join');
        expect(app.container.read(stationSignalsProvider), const StationSignals(onDuty: true, campaignId: 'camp-1'));
        app.dispose();
      });
    });

    test('a second start for the same campaign is the same station', () {
      fakeAsync((async) {
        final app = App(async)..start();
        expect(app.start(), isA<StationStarted>());
        expect(app.requests('POST', '/proxy/agency/sessions'), hasLength(1));
        app.dispose();
      });
    });

    test('409 session_on_other_campaign → StationElsewhere, leavable unless mid-call', () {
      fakeAsync((async) {
        final app = App(async);
        for (final (state, label, canLeave) in [('break', 'On break', true), ('on_call', 'On a call', false)]) {
          app.routes['POST /proxy/agency/sessions'] = (_) => json(409, {
                'error': 'Conflict',
                'code': 'session_on_other_campaign',
                'campaign_id': 'camp-9',
                'campaign_name': 'Q3 Winback',
                'state': state,
                'message': 'You are on Q3 Winback.',
              });
          final r = app.start() as StationElsewhere;
          expect(r.campaignId, 'camp-9');
          expect(r.campaignName, 'Q3 Winback');
          expect(r.stateLabel, label);
          expect(r.canLeave, canLeave);
          expect(app.view, isNull);
        }
        app.dispose();
      });
    });

    test('409 session_on_softphone → StationOnSoftphone with its account', () {
      fakeAsync((async) {
        final app = App(async);
        app.routes['POST /proxy/agency/sessions'] = (_) => json(409, {
              'error': 'Conflict',
              'code': 'session_on_softphone',
              'session_id': 'sp-1',
              'account_id': 'acc-2',
              'account_name': 'North',
              'message': 'Soft phone open.',
            });
        final r = app.start() as StationOnSoftphone;
        expect((r.sessionId, r.accountId, r.accountName), ('sp-1', 'acc-2', 'North'));
        app.dispose();
      });
    });

    test('403 not_staffed / feature_disabled / other → StationRefused in the server’s words, or ours', () {
      fakeAsync((async) {
        final app = App(async);
        final cases = [
          (403, {'code': 'not_staffed', 'message': 'You are not on this campaign.'}, 'You are not on this campaign.', 'not_staffed'),
          (403, {'code': 'not_staffed', 'message': ''}, notStaffedCopy, 'not_staffed'),
          (403, {'code': 'feature_disabled', 'message': 'The dialer is off.'}, 'The dialer is off.', 'feature_disabled'),
          (409, {'code': 'campaign_not_running', 'message': 'This campaign is paused.'}, 'This campaign is paused.', 'campaign_not_running'),
        ];
        for (final (status, body, message, code) in cases) {
          app.routes['POST /proxy/agency/sessions'] = (_) => json(status, {'error': 'Refused', ...body});
          final r = app.start() as StationRefused;
          expect(r.message, message);
          expect(r.code, code);
        }
        app.routes['POST /proxy/agency/sessions'] = (_) => throw const SocketException('offline');
        final offline = app.start() as StationRefused;
        expect(offline.message, contains('offline'));
        app.dispose();
      });
    });

    test('leaveOtherAndStart leaves the other session in ITS account, then joins here', () {
      fakeAsync((async) {
        final app = App(async);
        app.routes['POST /proxy/agency/sessions/other-1/leave'] = (_) => json(200, stateBody('offline'));
        const other = StationElsewhere(
          sessionId: 'other-1',
          campaignId: 'camp-9',
          campaignName: 'Q3 Winback',
          stateLabel: 'On break',
          canLeave: true,
          accountId: 'acc-2',
        );
        final r = app.run(app.controller.leaveOtherAndStart(other, 'camp-1', campaignName: 'Renewals'));
        expect(r, isA<StationStarted>());
        final leave = app.requests('POST', '/proxy/agency/sessions/other-1/leave').single;
        expect(leave.headers['x-account-id'], 'acc-2');
        expect(app.requests('POST', '/proxy/agency/sessions').single.headers['x-account-id'], 'acc-1');
        app.dispose();
      });
    });

    test('leaveOtherAndStart finds the session id by rejoining the other campaign, and stops if it is mid-call', () {
      fakeAsync((async) {
        final app = App(async);
        app.routes['POST /proxy/agency/sessions'] = (r) => (r.body! as Map)['campaign_id'] == 'camp-9'
            ? json(200, {...bootstrapJsonFor('camp-9'), 'state': 'on_call'})
            : json(200, bootstrapJsonFor('camp-1'));
        const other = StationElsewhere(sessionId: '', campaignId: 'camp-9', campaignName: 'Q3 Winback', stateLabel: 'On break', canLeave: true);
        final r = app.run(app.controller.leaveOtherAndStart(other, 'camp-1', campaignName: 'Renewals'));
        expect(r, isA<StationElsewhere>());
        expect((r as StationElsewhere).canLeave, isFalse);
        expect(r.sessionId, 'sess-camp-9');
        expect(app.sent.where((s) => s.path.endsWith('/leave')), isEmpty);
        app.dispose();
      });
    });

    test('leaveOtherAndStart refuses while a call is live there, and names the failed stage', () {
      fakeAsync((async) {
        final app = App(async);
        const live = StationElsewhere(sessionId: 'o', campaignId: 'camp-9', campaignName: 'Q3', stateLabel: 'On a call', canLeave: false);
        final refused = app.run(app.controller.leaveOtherAndStart(live, 'camp-1', campaignName: 'Renewals')) as StationRefused;
        expect(refused.message, startsWith('Finish what you’re doing on Q3'));
        app.routes['POST /proxy/agency/sessions/o/leave'] = (_) => json(409, {'code': 'agent_on_live_call', 'message': 'A call is live.'});
        const idle = StationElsewhere(sessionId: 'o', campaignId: 'camp-9', campaignName: 'Q3', stateLabel: 'On break', canLeave: true);
        final failed = app.run(app.controller.leaveOtherAndStart(idle, 'camp-1', campaignName: 'Renewals')) as StationRefused;
        expect(failed.message, 'Q3 is still open — A call is live.');
        app.dispose();
      });
    });

    test('closing the soft phone: refused while its call is unsettled, else closed and joined', () {
      fakeAsync((async) {
        final app = App(async);
        const sp = StationOnSoftphone(sessionId: 'sp-1', accountId: 'acc-2');
        app.routes['POST /proxy/agency/sessions/sp-1/leave'] = (_) => json(409, {'code': 'manual_call_live', 'message': 'x'});
        final StationLauncher launcher = app.controller;
        final pending = app.run(launcher.closeSoftphoneAndStart(sp, 'camp-1', campaignName: 'Renewals')) as StationRefused;
        expect(pending.message, softphoneCallPendingCopy);
        app.routes['POST /proxy/agency/sessions/sp-1/leave'] = (_) => json(200, stateBody('offline'));
        expect(app.run(app.controller.closeSoftphoneAndStart(sp, 'camp-1', campaignName: 'Renewals')), isA<StationStarted>());
        expect(app.requests('POST', '/proxy/agency/sessions/sp-1/leave').last.headers['x-account-id'], 'acc-2');
        app.dispose();
      });
    });
  });

  group('frames → view', () {
    test('a call from reserved to wrap-up, with times on this device’s clock', () {
      fakeAsync((async) {
        final app = App(async)..start();
        // The server runs 60 s ahead of this phone.
        app.socket.serverPong(serverOffsetMs: 60000);
        app.readyFrame('available');
        app.agentStateFrame('available', since: '2026-11-01T09:01:00.000Z');
        expect(app.view!.phase, AgentPhase.available);
        expect(app.view!.phaseSince, DateTime.utc(2026, 11, 1, 9));

        app.reserved('att-1');
        app.agentStateFrame('reserved');
        final call = app.view!.call!;
        expect(app.view!.callActive, isTrue);
        expect(call.displayName, 'Asha Rao');
        expect(call.heroFields.map((f) => f.label), ['Customer Name', 'City']);
        expect(call.heroesConfigured, isFalse);
        expect(call.isBridged, isFalse);
        expect(call.recording, isTrue);
        expect(app.container.read(stationSignalsProvider).callActive, isTrue);

        app.bridged('att-1', at: '2026-11-01T09:01:10.000Z');
        app.agentStateFrame('on_call');
        expect(app.view!.call!.bridgedAt, DateTime.utc(2026, 11, 1, 9, 0, 10));
        // The contact panel was not rebuilt for the timer change.
        expect(identical(app.view!.call!.heroFields, call.heroFields), isTrue);

        app.releasedFrame('att-1');
        app.agentStateFrame('wrapup');
        app.wrapupFrame('att-1', endsAt: '2026-11-01T09:02:00.000Z');
        final v = app.view!;
        expect(v.phase, AgentPhase.wrapup);
        expect(v.release!.headline, 'Wrap-up');
        expect(v.release!.detail, 'The customer hung up.');
        expect(v.call!.attemptId, 'att-1', reason: 'the panel stays up for the disposition');
        expect(v.wrapup!.endsAt, DateTime.utc(2026, 11, 1, 9, 1));
        expect(v.wrapup!.secondsTotal, 30);

        app.agentStateFrame('available');
        expect(app.view!.call, isNull);
        expect(app.view!.release, isNull);
        expect(app.view!.wrapup, isNull);
        app.dispose();
      });
    });

    test('an unchanged frame emits nothing; an unchanged slice keeps its identity', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        final before = app.views.length;
        final call = app.view!.call;
        app.socket.serverPong();
        app.socket.serverPong();
        expect(app.views.length, before);
        app.frame({'event': 'campaign_state', 'campaign_id': 'camp-1', 'status': 'paused', 'reason': 'paused_by_supervisor', 'dialing': false, 'message': 'Paused.'});
        expect(app.view!.campaignDialing, isFalse);
        expect(app.view!.campaignMessage, 'Paused.');
        expect(identical(app.view!.call, call), isTrue);
        app.dispose();
      });
    });

    test('a missed release is shown in plain words and can be dismissed', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available', extra: {
          'missed_release': {
            'attempt_id': 'att-0',
            'reason': 'remote_hangup',
            'requires_disposition': false,
            'message': 'The customer hung up.',
            'ended_at': '2026-11-01T08:59:00.000Z',
          },
        });
        expect(app.view!.missedRelease!.headline, 'While you were away: Wrap-up');
        app.controller.dismissMissedRelease();
        expect(app.view!.missedRelease, isNull);
        app.dispose();
      });
    });

    test('a mid-call drop shows the 8 s reconnect deadline; ready clears it', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.socket.serverClose(1006);
        expect(app.view!.link, StationLink.reconnecting);
        expect(app.view!.reconnectDeadline, app.now().add(const Duration(seconds: 8)));
        expect(app.view!.reconnectWindow, const Duration(seconds: 8));
        async.elapse(const Duration(milliseconds: 500));
        expect(app.mints, 1);
        app.readyFrame('on_call', extra: {
          'active_attempt': {...app.attemptJson('att-1'), 'bridged_at': '2026-11-01T09:00:10.000Z', 'state': 'bridged'},
        });
        expect(app.view!.reconnectDeadline, isNull);
        expect(app.view!.reconnectWindow, isNull);
        expect(app.view!.call!.isBridged, isTrue);
        app.dispose();
      });
    });

    test('4409: superseded; Use this phone instead mints a new token and takes the session back', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.socket.serverClose(4409);
        expect(app.view!.link, StationLink.superseded);
        app.run(app.controller.useThisDevice());
        async.flushMicrotasks();
        expect(app.mints, 1);
        expect(app.view!.link, StationLink.open);
        app.dispose();
      });
    });

    test('4404: session gone; Reconnect joins again', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.socket.serverClose(4404);
        expect(app.view!.link, StationLink.sessionGone);
        expect(app.container.read(stationSignalsProvider).onDuty, isFalse);
        app.run(app.controller.reconnect());
        async.flushMicrotasks();
        expect(app.requests('POST', '/proxy/agency/sessions'), hasLength(2));
        expect(app.view!.link, StationLink.open);
        app.dispose();
      });
    });

    test('weak connection after two missed pings', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.socket.serverPong();
        async.elapse(const Duration(seconds: 10));
        expect(app.view!.weakConnection, isFalse);
        async.elapse(const Duration(seconds: 10));
        expect(app.view!.weakConnection, isTrue);
        app.socket.serverPong();
        expect(app.view!.weakConnection, isFalse);
        app.dispose();
      });
    });
  });

  group('actions', () {
    test('single-flight: a double tap sends one request and shows busy until it lands', () {
      fakeAsync((async) {
        final app = App(async)..start();
        final gate = Completer<http.Response>();
        app.routes['POST /proxy/agency/sessions/sess-1/available'] = (_) => gate.future;
        unawaited(app.controller.goAvailable());
        unawaited(app.controller.goAvailable());
        async.flushMicrotasks();
        expect(app.requests('POST', '/proxy/agency/sessions/sess-1/available'), hasLength(1));
        expect(app.view!.busy, StationBusy.goingAvailable);
        gate.complete(json(200, stateBody('available')));
        async.flushMicrotasks();
        expect(app.view!.busy, StationBusy.none);
        // Going available pre-warms the audio again.
        expect(app.engine.calls.where((c) => c == 'prepare'), hasLength(2));
        app.dispose();
      });
    });

    test('a refused presence change shows the server’s sentence, or the console’s fallback', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST /proxy/agency/sessions/sess-1/available'] = (_) => json(409, {
              'code': 'attempt_not_dispositionable',
              'message': 'Submit a disposition for your last call before going available.',
            });
        app.run(app.controller.goAvailable());
        expect(app.view!.actionError, 'Submit a disposition for your last call before going available.');
        app.controller.dismissActionError();
        expect(app.view!.actionError, isNull);
        app.routes['POST /proxy/agency/sessions/sess-1/available'] = (_) => throw const SocketException('down');
        app.run(app.controller.goAvailable());
        expect(app.view!.actionError, presenceFailedCopy);
        app.dispose();
      });
    });

    test('ending a break shows its own busy state', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.agentStateFrame('break', breakReason: 'tea');
        final gate = Completer<http.Response>();
        app.routes['POST /proxy/agency/sessions/sess-1/available'] = (_) => gate.future;
        unawaited(app.controller.endBreak());
        async.flushMicrotasks();
        expect(app.view!.busy, StationBusy.endingBreak);
        gate.complete(json(200, stateBody('available')));
        async.flushMicrotasks();
        expect(app.view!.busy, StationBusy.none);
        app.dispose();
      });
    });

    test('lists keep their identity while their contents do not change', () {
      fakeAsync((async) {
        final app = App(async)..start();
        final dispositions = app.view!.dispositions;
        final breaks = app.view!.breakOptions;
        app.onCall('att-1');
        app.controller.updateNotes('typing');
        expect(identical(app.view!.dispositions, dispositions), isTrue);
        expect(identical(app.view!.breakOptions, breaks), isTrue);
        app.dispose();
      });
    });

    test('a break asked for mid-call is queued, shown, and can be cancelled', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.routes['POST /proxy/agency/sessions/sess-1/break'] =
            (_) => json(200, stateBody('on_call', breakReason: 'tea', pending: 'break'));
        app.run(app.controller.takeBreak('tea'));
        expect(app.requests('POST', '/proxy/agency/sessions/sess-1/break').single.body, {'reason': 'tea'});
        expect(app.view!.queuedBreak, const BreakInfo(code: 'tea', label: 'Tea break'));
        app.routes['POST /proxy/agency/sessions/sess-1/break/cancel'] = (_) => json(200, stateBody('on_call'));
        app.run(app.controller.cancelQueuedBreak());
        expect(app.view!.queuedBreak, isNull);
        app.dispose();
      });
    });

    test('a break reason the campaign dropped re-syncs the menu from allowed_codes', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST /proxy/agency/sessions/sess-1/break'] = (_) => json(400, {
              'code': 'unknown_break_reason',
              'message': 'Unknown break reason.',
              'allowed_codes': ['lunch', 'training'],
            });
        app.run(app.controller.takeBreak('tea'));
        expect(app.view!.actionError, breakRejectedCopy);
        expect(app.view!.breakOptions.map((b) => b.label), ['Lunch', 'Training']);
        app.dispose();
      });
    });

    test('cancelling a break that already started says so', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST /proxy/agency/sessions/sess-1/break/cancel'] = (_) => json(409, {'code': 'break_already_applied', 'message': 'x'});
        app.run(app.controller.cancelQueuedBreak());
        expect(app.view!.actionError, breakAlreadyStartedCopy);
        app.dispose();
      });
    });

    test('hang up goes over HTTP; a refusal is explained', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.routes['POST /proxy/agency/attempts/att-1/hangup'] = (_) => json(409, {'code': 'attempt_not_live', 'message': 'x'});
        app.run(app.controller.hangUp());
        expect(app.requests('POST', '/proxy/agency/attempts/att-1/hangup'), hasLength(1));
        expect(app.view!.actionError, startsWith('We can’t reach this call'));
        app.dispose();
      });
    });

    test('DNC: campaign scope, only on a live call, failures in words', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.run(app.controller.markDnc());
        expect(app.view!.actionError, dncNeedsCallCopy);
        app.onCall('att-1');
        app.routes['POST /proxy/agency/attempts/att-1/dnc'] = (_) => json(200, {
              'campaign_id': 'camp-1',
              'attempt_id': 'att-1',
              'contact_id': 'c-att-1',
              'phone_e164': '+919876543210',
              'contact_state': 'suppressed',
              'dnc_recorded': true,
            });
        app.run(app.controller.markDnc(reason: 'asked'));
        expect(app.requests('POST', '/proxy/agency/attempts/att-1/dnc').single.body, {'scope': 'campaign', 'reason': 'asked'});
        expect(app.view!.actionError, isNull);
        expect(app.view!.dncOutcome,
            '+919876543210 won’t be dialed again by this campaign. It’s on this campaign’s Do Not Call list.');
        app.routes['POST /proxy/agency/attempts/att-1/dnc'] = (_) => json(403, {'code': 'not_your_attempt', 'message': 'x'});
        app.run(app.controller.markDnc());
        expect(app.view!.actionError, 'This call has moved on — it isn’t yours to mark any more.');
        expect(app.view!.dncOutcome, isNull);
        app.dispose();
      });
    });

    test('the DNC outcome line goes with the call it was about', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.routes['POST /proxy/agency/attempts/att-1/dnc'] = (_) => json(200, {
              'campaign_id': 'camp-1',
              'attempt_id': 'att-1',
              'contact_id': 'c-att-1',
              'phone_e164': '+919876543210',
              'contact_state': 'suppressed',
              'dnc_recorded': false,
            });
        app.run(app.controller.markDnc());
        expect(app.view!.dncOutcome, contains('We’re still adding it'));
        app.releasedFrame('att-1', requiresDisposition: false);
        app.agentStateFrame('available');
        app.reserved('att-2');
        expect(app.view!.dncOutcome, isNull);
        app.dispose();
      });
    });

    group('disposition', () {
      test('validation runs first and sends nothing when the form is incomplete', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.inWrapup('att-1');
          app.run(app.controller.submitDisposition('not_interested'));
          expect(app.view!.actionError, 'This disposition needs a note.');
          app.run(app.controller.submitDisposition('callback'));
          expect(app.view!.actionError, 'This disposition needs a callback time.');
          app.run(app.controller.submitDisposition('callback', callbackAt: app.now().subtract(const Duration(minutes: 1))));
          expect(app.view!.actionError, 'That time has already passed. Pick when we should call back.');
          app.run(app.controller.submitDisposition('nope'));
          expect(app.view!.actionError, 'Pick a disposition to save this call.');
          expect(app.sent.where((s) => s.path.endsWith('/disposition')), isEmpty);
          app.dispose();
        });
      });

      test('saved: marks the call, sends the notes typed so far, clears them from the device', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.inWrapup('att-1');
          app.controller.updateNotes('Wants a quote');
          app.routes['POST /proxy/agency/attempts/att-1/disposition'] = (_) => json(200, {
                'campaign_id': 'camp-1',
                'attempt_id': 'att-1',
                'contact_id': 'c-att-1',
                'disposition_code': 'interested',
                'contact_state': 'completed',
                'agent_state': 'wrapup',
              });
          app.run(app.controller.submitDisposition('interested'));
          expect(app.requests('POST', '/proxy/agency/attempts/att-1/disposition').single.body,
              {'disposition_code': 'interested', 'notes': 'Wants a quote'});
          expect(app.view!.dispositionSaved, 'interested');
          expect(app.view!.wrapup!.dispositionSubmitted, isTrue);
          // A second tap does nothing.
          app.run(app.controller.submitDisposition('interested'));
          expect(app.requests('POST', '/proxy/agency/attempts/att-1/disposition'), hasLength(1));
          async.elapse(const Duration(seconds: 3));
          expect(app.requests('POST', '/proxy/agency/attempts/att-1/notes'), isEmpty,
              reason: 'the disposition carried the notes; the pending autosave is dropped');
          expect(app.store.entries, isEmpty);
          app.dispose();
        });
      });

      test('unknown_disposition_code re-syncs the catalog from allowed_codes', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.inWrapup('att-1');
          app.routes['POST /proxy/agency/attempts/att-1/disposition'] = (_) => json(400, {
                'code': 'unknown_disposition_code',
                'message': 'Unknown code.',
                'allowed_codes': ['interested', 'wrong_number'],
              });
          app.run(app.controller.submitDisposition('interested'));
          expect(app.view!.actionError, catalogChangedCopy);
          expect(app.view!.dispositions.map((d) => d.label), ['Interested', 'Wrong number']);
          app.dispose();
        });
      });

      test('already dispositioned names what is recorded, never the raw code', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.inWrapup('att-1');
          app.routes['POST /proxy/agency/attempts/att-1/disposition'] =
              (_) => json(409, {'code': 'already_dispositioned', 'message': 'x', 'disposition_code': 'do_not_call'});
          app.run(app.controller.submitDisposition('interested'));
          expect(app.view!.actionError, 'This call is already recorded as Do not call.');
          app.dispose();
        });
      });
    });

    group('notes autosave', () {
      test('saving → saved after a 2 s pause, and the device copy is cleared once the server has it', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.onCall('att-1');
          app.routes['POST /proxy/agency/attempts/att-1/notes'] = (r) => json(200, {
                'attempt_id': 'att-1',
                'notes': (r.body! as Map)['notes'],
                'updated_at': '2026-11-01T09:00:30.000Z',
              });
          app.controller.updateNotes('Asked');
          app.controller.updateNotes('Asked about EMI');
          expect(app.view!.notes, const NotesView(text: 'Asked about EMI', status: NotesStatus.saving));
          async.elapse(const Duration(milliseconds: 1999));
          expect(app.requests('POST', '/proxy/agency/attempts/att-1/notes'), isEmpty);
          async.elapse(const Duration(milliseconds: 1));
          async.flushMicrotasks();
          expect(app.requests('POST', '/proxy/agency/attempts/att-1/notes').single.body, {'notes': 'Asked about EMI'});
          expect(app.view!.notes.status, NotesStatus.saved);
          expect(app.view!.notes.savedAt, app.now());
          expect(app.store.entries, isEmpty);
          app.dispose();
        });
      });

      test('a network failure retries, and the text stays on the device until it lands', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.onCall('att-1');
          var fail = true;
          app.routes['POST /proxy/agency/attempts/att-1/notes'] = (r) {
            if (fail) throw const SocketException('down');
            return json(200, {'attempt_id': 'att-1', 'notes': 'x', 'updated_at': '2026-11-01T09:00:30.000Z'});
          };
          app.controller.updateNotes('x');
          async.elapse(const Duration(seconds: 2));
          expect(app.view!.notes.status, NotesStatus.retrying);
          expect(app.store.entries['att-1']?.notes, 'x');
          fail = false;
          async.elapse(const Duration(seconds: 3));
          expect(app.view!.notes.status, NotesStatus.saved);
          expect(app.store.entries, isEmpty);
          app.dispose();
        });
      });

      test('a refusal is a failure, and a supervisor’s edit shows as changed elsewhere', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.onCall('att-1');
          app.routes['POST /proxy/agency/attempts/att-1/notes'] = (_) => json(400, {'code': 'attempt_not_dispositionable', 'message': 'x'});
          app.controller.updateNotes('x');
          async.elapse(const Duration(seconds: 2));
          expect(app.view!.notes.status, NotesStatus.failed);
          app.routes['POST /proxy/agency/attempts/att-1/notes'] =
              (_) => json(200, {'attempt_id': 'att-1', 'notes': 'supervisor text', 'updated_at': '2026-11-01T09:00:30.000Z'});
          app.controller.updateNotes('xy');
          async.elapse(const Duration(seconds: 2));
          expect(app.view!.notes.changedElsewhere, isTrue);
          app.dispose();
        });
      });

      test('a new call flushes the last call’s pending notes to THAT call', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.onCall('att-1');
          for (final id in ['att-1', 'att-2']) {
            app.routes['POST /proxy/agency/attempts/$id/notes'] =
                (r) => json(200, {'attempt_id': id, 'notes': (r.body! as Map)['notes'], 'updated_at': '2026-11-01T09:00:30.000Z'});
          }
          app.controller.updateNotes('about call one');
          async.elapse(const Duration(milliseconds: 500));
          app.releasedFrame('att-1', requiresDisposition: false);
          app.agentStateFrame('available');
          app.reserved('att-2');
          expect(app.requests('POST', '/proxy/agency/attempts/att-1/notes').single.body, {'notes': 'about call one'});
          expect(app.requests('POST', '/proxy/agency/attempts/att-2/notes'), isEmpty);
          expect(app.view!.notes.text, '');
          app.dispose();
        });
      });
    });

    test('leave: off duty, audio released, on-duty service stopped, wake lock off', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST /proxy/agency/sessions/sess-1/leave'] = (_) => json(200, stateBody('offline'));
        app.run(app.controller.leave());
        async.flushMicrotasks();
        expect(app.view, isNull);
        expect(app.engine.calls, containsAllInOrder(['release', 'fgs.stop']));
        expect(app.wakeLock.on, isFalse);
        expect(app.socket.closedWith, 1000);
        expect(app.container.read(stationSignalsProvider), const StationSignals());
        expect(async.pendingTimers.where((t) => t.duration > Duration.zero), isEmpty);
        app.dispose();
      });
    });

    test('a refused leave stays on duty and says why', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST /proxy/agency/sessions/sess-1/leave'] =
            (_) => json(409, {'code': 'agent_on_live_call', 'message': 'Finish the call first.'});
        app.run(app.controller.leave());
        expect(app.view!.actionError, 'Finish the call first.');
        app.dispose();
      });
    });
  });

  test('an expired sign-in is reported to the app gate, and the call carries on', () {
    fakeAsync((async) {
      final app = App(async)..start();
      app.onCall('att-1');
      app.tokens.signedOut = true;
      app.run(app.controller.hangUp());
      expect(app.unauthorized, hasLength(1));
      expect(app.view!.actionError, isNotNull);
      expect(app.view!.call, isNotNull);
      expect(app.view!.link, StationLink.open);
      app.dispose();
    });
  });

  test('disposing the container cancels every station timer', () {
    fakeAsync((async) {
      final app = App(async)..start();
      app.onCall('att-1');
      app.controller.updateNotes('pending');
      app.dispose();
      expect(async.pendingTimers.where((t) => t.duration > Duration.zero), isEmpty);
    });
  });
}

Map<String, Object?> bootstrapJsonFor(String campaignId) => {
      ...bootstrapJsonBase,
      'session_id': 'sess-$campaignId',
      'campaign_id': campaignId,
    };

final bootstrapJsonBase = bootstrapJsonOf();

Map<String, Object?> bootstrapJsonOf() => {
      'campaign_name': 'X',
      'agent_user_id': 'u-1',
      'state': 'offline',
      'campaign_status': 'running',
      'station_ws_url': '/proxy/agency/station?token=t',
      'disposition_catalog': <Object?>[],
      'wrapup_seconds': 30,
      'wrapup_auto_return': true,
      'record_calls': false,
      'break_reasons': <Object?>[],
      'context_display': <String, Object?>{},
      'intervals': {'heartbeat_ms': 10000, 'heartbeat_grace_ms': 10000, 'reservation_lease_ms': 10000, 'countdown_ms': 3000},
    };
