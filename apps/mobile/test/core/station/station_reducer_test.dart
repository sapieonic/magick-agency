import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_state.dart';

import 'fixtures.dart';

/// The station's transitions without a socket: a case-for-case port of the
/// console's `agencyStationReducer.test.ts`, plus the two mobile additions.

final _attempt = attempt('att-1');
final _next = attempt('att-2');
final _released = released('att-1');
final _bridgedAt = DateTime.utc(2026, 8, 11, 10, 0, 4);
final _s1 = DateTime.utc(2026, 8, 11, 10, 0, 1);
final _s2 = DateTime.utc(2026, 8, 11, 10, 0, 2);
final _s3 = DateTime.utc(2026, 8, 11, 10, 0, 3);

final _anchor = WrapupAnchor(
  attemptId: 'att-1',
  deadline: DateTime.utc(2026, 8, 11, 10, 1),
  total: const Duration(seconds: 30),
  requiresDisposition: true,
  heldReason: null,
  autoReturn: true,
);

StationState run(List<StationAction> actions, [StationState from = StationState.initial]) =>
    actions.fold(from, stationReducer);

/// On a bridged call.
StationState onCall() => run([
      ReservedAction(_attempt),
      BridgedAction('att-1', _bridgedAt),
      AgentStateAction(agentState(AgentState.onCall, since: _s1)),
    ]);

/// In a wrap-up that requires a disposition, panel retained.
StationState inWrapup() => run(
      [
        ReleasedAction(_released, at: DateTime.utc(2026, 8, 11, 10, 0, 5), retain: _attempt),
        AgentStateAction(agentState(AgentState.wrapup, since: _s2)),
        WrapupAction(_anchor),
      ],
      onCall(),
    );

void main() {
  group('stationReducer: the groups move together', () {
    test('reserved replaces the panel and clears everything about the last call', () {
      final from = stationReducer(inWrapup(), ReadyAction(ready(state: AgentState.wrapup, missed: missedRelease('old'))));
      final s = run([ReservedAction(_next)], from);
      expect(s.live, LiveAttempt(attempt: _next));
      expect(s.retainedAttempt, isNull);
      expect(s.wrapup, isNull);
      expect(s.release, isNull);
      expect(s.releasedAt, isNull);
      expect(s.missedRelease, isNull);
    });

    test('bridged opens the call only for the attempt that is live', () {
      final ringing = run([ReservedAction(_attempt)]);
      final other = stationReducer(ringing, BridgedAction('att-9', _bridgedAt));
      // Not merely equal: the same object, so a stray frame costs no rebuild.
      expect(identical(other, ringing), isTrue);
      expect(stationReducer(ringing, BridgedAction('att-1', _bridgedAt)).live?.bridgedAt, _bridgedAt);
    });

    test('released clears live, stamps the release, and retains the panel when owed a disposition', () {
      final at = DateTime.utc(2026, 8, 11, 10, 0, 5);
      final s = run([ReleasedAction(_released, at: at, retain: _attempt)], onCall());
      expect(s.live, isNull);
      expect(identical(s.release, _released), isTrue);
      expect(s.releasedAt, at);
      expect(identical(s.retainedAttempt, _attempt), isTrue);
    });

    test('released retains nothing when no disposition is owed, or the retained attempt is another', () {
      final at = DateTime.utc(2026);
      final none = run([ReleasedAction(released('att-1', requiresDisposition: false), at: at, retain: _attempt)], onCall());
      expect(none.retainedAttempt, isNull);
      final mismatched = run([ReleasedAction(_released, at: at, retain: _next)], onCall());
      expect(mismatched.retainedAttempt, isNull);
    });
  });

  group('stationReducer: agent_state is the authority for wrap-up ending', () {
    test('leaving wrap-up clears the anchor, the retained panel and the release', () {
      final s = run([AgentStateAction(agentState(AgentState.available, since: _s3))], inWrapup());
      expect(s.agentState, AgentState.available);
      expect(s.agentStateSince, _s3);
      expect(s.wrapup, isNull);
      expect(s.retainedAttempt, isNull);
      // A wrap-up happened, so its release copy has already been shown.
      expect(s.release, isNull);
      expect(s.releasedAt, isNull);
    });

    test('keeps a release no wrap-up ever explained (on_call → available)', () {
      final at = DateTime.utc(2026, 1, 1, 0, 0, 7);
      final releasedState = run([ReleasedAction(_released, at: at, retain: _attempt)], onCall());
      final s = run([AgentStateAction(agentState(AgentState.available, since: _s3))], releasedState);
      expect(identical(s.release, _released), isTrue);
      expect(s.releasedAt, at);
      expect(s.retainedAttempt, isNull);
    });

    test('reads "the state before this frame" from the state as of the last action, mid-batch', () {
      final s = run(
        [
          ReleasedAction(_released, at: DateTime.utc(2026), retain: _attempt),
          AgentStateAction(agentState(AgentState.wrapup, since: _s2)),
          AgentStateAction(agentState(AgentState.available, since: _s3)),
        ],
        onCall(),
      );
      expect(s.release, isNull);
    });
  });

  group('stationReducer: ready is a snapshot, not a set of additions', () {
    test('clears a live attempt the API no longer holds', () {
      final s = stationReducer(onCall(), ReadyAction(ready()));
      expect(s.live, isNull);
      expect(s.agentState, AgentState.available);
    });

    test('rehydrates a live attempt with its bridged_at', () {
      final s = stationReducer(
        StationState.initial,
        ReadyAction(ready(state: AgentState.onCall, active: activeAttempt('att-1', bridgedAt: _bridgedAt))),
      );
      expect(s.live?.bridgedAt, _bridgedAt);
      expect(s.live?.attemptId, 'att-1');
    });

    test('a wrap-up that lapsed while away closes the pad’s routes, and its release goes', () {
      final s = stationReducer(inWrapup(), ReadyAction(ready()));
      expect(s.wrapup, isNull);
      expect(s.retainedAttempt, isNull);
      expect(s.release, isNull);
    });

    test('keeps an unexplained release across a reconnect in the idle window', () {
      final releasedState = run(
        [
          ReleasedAction(_released, at: DateTime.utc(2026), retain: _attempt),
          AgentStateAction(agentState(AgentState.available, since: _s3)),
        ],
        onCall(),
      );
      final s = stationReducer(releasedState, ReadyAction(ready()));
      expect(identical(s.release, _released), isTrue);
    });

    test('in wrap-up: takes the API’s anchor, and drops a panel for a different attempt', () {
      const otherAnchor = WrapupAnchor(
        attemptId: 'att-2',
        deadline: null,
        total: null,
        requiresDisposition: true,
        heldReason: null,
        autoReturn: true,
      );
      final s = stationReducer(
        inWrapup(),
        ReadyAction(
          ready(
            state: AgentState.wrapup,
            wrapup: WrapupState(
              attemptId: 'att-2',
              secondsTotal: 30,
              autoReturn: true,
              requiresDisposition: true,
              dispositionSubmitted: false,
            ),
          ),
          wrapup: otherAnchor,
        ),
      );
      expect(identical(s.wrapup, otherAnchor), isTrue);
      expect(s.retainedAttempt, isNull);
    });

    test('in wrap-up with no active_wrapup (another replica): keeps the anchor it holds', () {
      final before = inWrapup();
      final s = stationReducer(before, ReadyAction(ready(state: AgentState.wrapup)));
      expect(identical(s.wrapup, before.wrapup), isTrue);
      expect(identical(s.retainedAttempt, before.retainedAttempt), isTrue);
    });

    test('assigns the missed release unconditionally: absence says there is none', () {
      final withMissed = stationReducer(StationState.initial, ReadyAction(ready(missed: missedRelease('att-1'))));
      expect(withMissed.missedRelease?.attemptId, 'att-1');
      final cleared = stationReducer(withMissed, ReadyAction(ready()));
      expect(cleared.missedRelease, isNull);
    });
  });

  group('stationReducer: the break queue is one statement', () {
    test('moves the counter on every statement, including the ones that say it is empty', () {
      final queued = stationReducer(
        StationState.initial,
        AgentStateAction(agentState(AgentState.onCall, since: _s1, pending: AgentState.onBreak, pendingBreakReason: 'lunch')),
      );
      expect(queued.pendingBreakCode, 'lunch');
      expect(queued.pendingBreakStatements, 1);

      final emptied = stationReducer(queued, AgentStateAction(agentState(AgentState.onCall, since: _s1)));
      expect(emptied.pendingBreakCode, isNull);
      expect(emptied.pendingBreakStatements, 2);

      // `ready` states it too, and an empty queue still moves the counter.
      final restated = stationReducer(emptied, ReadyAction(ready()));
      expect(restated.pendingBreakStatements, 3);
    });
  });

  group('stationReducer: an unchanged value costs no rebuild', () {
    final cases = <String, StationAction>{
      'connection idle': const ConnectionAction(StationConnection.idle),
      'missed pings 0': const MissedPingsAction(0),
      'pong without a sample': const PongAction(null),
      'pong with offset 0': const PongAction(0),
      'campaign dialing': const CampaignStateAction(dialing: true),
    };
    for (final e in cases.entries) {
      test('returns the same state for ${e.key}', () {
        expect(identical(stationReducer(StationState.initial, e.value), StationState.initial), isTrue);
      });
    }

    test('a pong clears the misses and moves the offset only when it carried a sample', () {
      final missing = stationReducer(StationState.initial, const MissedPingsAction(2));
      final noSample = stationReducer(missing, const PongAction(null));
      expect(noSample.missedPings, 0);
      expect(noSample.clockOffsetMs, 0);
      expect(stationReducer(missing, const PongAction(-10000)).clockOffsetMs, -10000);
    });
  });

  group('stationReducer: mobile additions', () {
    test('ready reporting a different state drops the anchors that described the old one', () {
      final onBreak = stationReducer(
        StationState.initial,
        AgentStateAction(agentState(AgentState.available, since: _s1)),
      );
      final s = stationReducer(onBreak, ReadyAction(ready(state: AgentState.onBreak)));
      expect(s.agentState, AgentState.onBreak);
      expect(s.agentStateSince, isNull);
      expect(s.breakReasonCode, isNull);
    });

    test('ready restating the same state keeps since and the break reason', () {
      final onBreak = stationReducer(
        StationState.initial,
        AgentStateAction(agentState(AgentState.onBreak, since: _s1, breakReason: 'tea')),
      );
      final s = stationReducer(onBreak, ReadyAction(ready(state: AgentState.onBreak)));
      expect(s.agentStateSince, _s1);
      expect(s.breakReasonCode, 'tea');
    });

    test('an HTTP answer fills a missing anchor, never changes the state, never overrides a frame', () {
      final unknown = stationReducer(StationState.initial, ReadyAction(ready(state: AgentState.onBreak)));
      final answer = SessionStateResponse(
        sessionId: 'sess-1',
        kind: SessionKind.campaign,
        state: AgentState.onBreak,
        since: _s2,
        breakReason: 'device_away',
      );
      final filled = stationReducer(unknown, SessionStateAction(answer));
      expect(filled.agentStateSince, _s2);
      expect(filled.breakReasonCode, 'device_away');
      // Already anchored: same instance.
      expect(identical(stationReducer(filled, SessionStateAction(answer)), filled), isTrue);
      // A different state: ignored.
      final available = stationReducer(StationState.initial, ReadyAction(ready()));
      expect(identical(stationReducer(available, SessionStateAction(answer)), available), isTrue);
    });

    test('campaign_state keeps its sentence only while not dialling', () {
      final paused = stationReducer(StationState.initial, const CampaignStateAction(dialing: false, message: 'Paused by a supervisor'));
      expect(paused.dialing, isFalse);
      expect(paused.campaignMessage, 'Paused by a supervisor');
      final resumed = stationReducer(paused, const CampaignStateAction(dialing: true, message: 'Resumed'));
      expect(resumed.campaignMessage, isNull);
    });

    test('currentAttemptId: live, then the retained panel, then the wrap-up', () {
      expect(onCall().currentAttemptId, 'att-1');
      expect(inWrapup().currentAttemptId, 'att-1');
      expect(StationState.initial.currentAttemptId, isNull);
    });

    test('openWrapup maps the deadline to this device and captures the span once', () {
      final now = DateTime.utc(2026, 8, 11, 10);
      final anchor = openWrapup(
        WrapupState(
          attemptId: 'att-1',
          endsAt: now.add(const Duration(seconds: 40)),
          secondsTotal: 30,
          autoReturn: true,
          requiresDisposition: true,
          dispositionSubmitted: false,
        ),
        10000, // the server runs 10 s ahead of this device
        now,
      );
      expect(anchor.deadline, now.add(const Duration(seconds: 30)));
      expect(anchor.total, const Duration(seconds: 30));
      final held = openWrapup(
        WrapupState(attemptId: 'a', secondsTotal: 0, autoReturn: false, requiresDisposition: true, dispositionSubmitted: false),
        0,
        now,
      );
      expect(held.deadline, isNull);
      expect(held.total, isNull);
    });
  });
}
