import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_state.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/station/station_view_mapper.dart';

import 'controller_harness.dart';
import 'fixtures.dart';

/// Contact assignment: the agent's own queue on a strict or preferred
/// campaign, from the bootstrap, the `ready` snapshot and the `queue` frame,
/// to the view the waiting screen reads.

final _nothing = QueueState(
  due: false,
  reason: QueueIdleReason.callbacksLater,
  nextDueAt: DateTime.utc(2026, 11, 4, 10, 30),
);
final _due = QueueState(due: true);

Map<String, Object?> _queueJson({bool due = false, String? reason = 'waiting_for_retry', String? next}) => {
      'due': due,
      'reason': due ? null : reason,
      'next_due_at': next,
    };

void main() {
  group('reducer', () {
    test('a queue action states the queue; the same queue again changes nothing', () {
      final s = stationReducer(StationState.initial, QueueAction(_nothing));
      expect(s.queue, _nothing);
      expect(identical(stationReducer(s, QueueAction(_nothing)), s), isTrue);
      expect(stationReducer(s, QueueAction(_due)).queue, _due);
    });

    test('the queue moves nothing else', () {
      final before = stationReducer(StationState.initial, AgentStateAction(agentState(AgentState.available)));
      final after = stationReducer(before, QueueAction(_nothing));
      expect(after.agentState, before.agentState);
      expect(after.agentStateSince, before.agentStateSince);
      expect(after.dialing, before.dialing);
      expect(after.live, isNull);
    });

    test('ready is a snapshot: it replaces the queue, and one without a queue clears it', () {
      final held = stationReducer(StationState.initial, QueueAction(_due));
      final frame = ReadyFrame(sessionId: 'sess-1', state: AgentState.available, queue: _nothing);
      expect(stationReducer(held, ReadyAction(frame)).queue, _nothing);
      expect(stationReducer(held, ReadyAction(ready())).queue, isNull, reason: 'a pool campaign has no queue');
    });
  });

  group('mapper', () {
    test('the next time is on this device’s clock; an unknown reason reads as other', () {
      final mapper = StationViewMapper();
      QueueView? viewOf(StationState s) => mapper
          .map(
            campaignId: 'camp-1',
            campaignName: 'Renewals',
            sessionId: 'sess-1',
            s: s,
            bootstrap: null,
            catalog: const [],
            breakReasons: const [],
            pendingBreakCode: null,
            audio: const AudioView(),
            notes: const NotesView(),
            busy: StationBusy.none,
            actionError: null,
            fatal: null,
            dispositionSavedCode: null,
            countdown: null,
            reconnectDeadline: null,
            reconnectWindow: null,
            dncOutcome: null,
            missedReleaseDismissed: false,
            awayPauseRequested: false,
          )
          .queue;

      expect(viewOf(StationState.initial), isNull);
      final s = stationReducer(StationState.initial, QueueAction(_nothing));
      final v = viewOf(s)!;
      expect(v, QueueView(due: false, reason: QueueIdle.callbacksLater, nextDueAt: DateTime.utc(2026, 11, 4, 10, 30)));
      expect(v.nothingDue, isTrue);
      // Memoised: the same queue is the same view instance.
      expect(identical(viewOf(s), v), isTrue);
      // The server runs 60 s ahead: the next time moves back by that much.
      final ahead = stationReducer(s, const PongAction(60000));
      expect(viewOf(ahead)!.nextDueAt, DateTime.utc(2026, 11, 4, 10, 29));

      final unknown = stationReducer(
        StationState.initial,
        QueueAction(QueueState(due: false, reason: QueueIdleReason.unknown, reasonRaw: 'supervisor_hold')),
      );
      expect(viewOf(unknown)!.reason, QueueIdle.other);
      expect(viewOf(stationReducer(StationState.initial, QueueAction(_due))), const QueueView(due: true));
    });

    test('every wire reason has a view reason', () {
      for (final r in QueueIdleReason.values) {
        final idle = StationViewMapper.queueIdleOf(r);
        expect(idle == QueueIdle.other, r == QueueIdleReason.unknown, reason: r.wire);
      }
      expect(StationViewMapper.queueIdleOf(null), QueueIdle.other);
    });
  });

  group('controller', () {
    test('the bootstrap’s queue shows at join, before the socket says anything', () {
      fakeAsync((async) {
        final app = App(async);
        app.routes['POST /proxy/agency/sessions'] = (_) => json(200, {
              ...bootstrapJson(),
              'assignment_mode': 'strict',
              'allow_agent_retry': true,
              'queue': _queueJson(reason: 'queue_empty'),
            });
        app.start();
        expect(app.view!.queue, const QueueView(due: false, reason: QueueIdle.queueEmpty));
        app.dispose();
      });
    });

    test('a pool campaign has no queue, and the waiting screen keeps its words', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        expect(app.view!.queue, isNull);
        app.dispose();
      });
    });

    test('ready states the queue at reconnect; a queue frame states every change', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available', extra: {'queue': _queueJson(next: '2026-11-01T10:00:00.000Z')});
        expect(
          app.view!.queue,
          QueueView(due: false, reason: QueueIdle.waitingForRetry, nextDueAt: DateTime.utc(2026, 11, 1, 10)),
        );

        app.frame({'event': 'queue', 'campaign_id': 'camp-1', ..._queueJson(due: true)});
        expect(app.view!.queue, const QueueView(due: true));
        expect(app.view!.queue!.nothingDue, isFalse);

        app.frame({
          'event': 'queue',
          'campaign_id': 'camp-1',
          ..._queueJson(reason: 'outside_calling_hours', next: '2026-11-02T03:30:00.000Z'),
        });
        expect(app.view!.queue!.reason, QueueIdle.outsideCallingHours);
        // Nothing else moved: the agent is still available and dialling.
        expect(app.view!.phase, AgentPhase.available);
        expect(app.view!.campaignDialing, isTrue);
        app.dispose();
      });
    });

    test('a queue frame for another campaign is ignored', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available', extra: {'queue': _queueJson(due: true)});
        app.frame({'event': 'queue', 'campaign_id': 'camp-other', ..._queueJson()});
        expect(app.view!.queue, const QueueView(due: true));
        app.dispose();
      });
    });

    test('a queue frame that does not read is dropped, never fatal', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available', extra: {'queue': _queueJson(due: true)});
        app.frame({'event': 'queue', 'campaign_id': 'camp-1', 'reason': 'queue_empty'});
        expect(app.view!.queue, const QueueView(due: true));
        expect(app.view!.fatal, isNull);
        app.dispose();
      });
    });
  });
}
