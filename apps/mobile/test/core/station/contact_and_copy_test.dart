import 'package:agency_wire/agency_wire.dart' as wire;
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/contact_context.dart';
import 'package:magick_agency_agent/core/station/disposition_rules.dart';
import 'package:magick_agency_agent/core/station/station_copy.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

const _context = <String, Object?>{
  'First Name': 'Asha',
  'Policy #': 'POL-1',
  'City': 'Mumbai',
  'Amount Due': '12345.67',
  'Notes': '',
  'Branch': 'Andheri West',
};

List<String> labels(List<ResolvedField> fields) => [for (final f in fields) f.label];

wire.ContextDisplay display({List<String>? hero, List<String>? order, List<String>? hidden}) =>
    wire.ContextDisplay(hero: hero, order: order, hidden: hidden);

void main() {
  group('context resolution: the four rules (port of agencyContext.test.ts)', () {
    test('renders hero first, pinned, in ARRAY order (not roster order)', () {
      final r = resolveContextFields(_context, display(hero: ['Amount Due', 'First Name']));
      expect(labels(r.hero), ['Amount Due', 'First Name']);
    });

    test('then `order`, in array order, then the rest in ORIGINAL roster order', () {
      final r = resolveContextFields(_context, display(hero: ['First Name'], order: ['Branch', 'City']));
      expect(labels(r.fields), ['Branch', 'City', 'Policy #', 'Amount Due']);
    });

    test('keeps original roster order, NOT alphabetical, for the non-hero remainder', () {
      final r = resolveContextFields(_context, display(hero: ['First Name']));
      final l = labels(r.fields);
      expect(l, ['Policy #', 'City', 'Amount Due', 'Branch']);
      expect(l, isNot([...l]..sort()));
    });

    test('hides `hidden` at EVERY stage, including from hero', () {
      final r = resolveContextFields(
        _context,
        display(hero: ['First Name', 'Amount Due'], order: ['Amount Due'], hidden: ['Amount Due']),
      );
      expect(labels(r.hero), ['First Name']);
      expect(labels(r.fields), isNot(contains('Amount Due')));
      expect(labels(r.empty), isNot(contains('Amount Due')));
    });

    test('renders every column in original order when there is no operator opinion', () {
      expect(labels(resolveContextFields(_context, null).fields), labels(resolveContextFields(_context, display()).fields));
    });
  });

  group('context resolution: robustness', () {
    test('caps hero at four', () {
      final r = resolveContextFields(_context, display(hero: ['First Name', 'Policy #', 'City', 'Amount Due', 'Branch']));
      expect(r.hero, hasLength(4));
    });

    test('skips a configured hero column this contact does not have', () {
      expect(labels(resolveContextFields(_context, display(hero: ['Nonexistent', 'City'])).hero), ['City']);
    });

    test('matches configured names case- and whitespace-insensitively', () {
      expect(labels(resolveContextFields(_context, display(hero: ['  first name  '])).hero), ['First Name']);
    });

    test('collapses empty and placeholder values out of the main list', () {
      final r = resolveContextFields(
        const {'Name': 'Asha', 'A': '', 'B': '   ', 'C': '-', 'D': 'N/A', 'E': 'real'},
        display(hero: ['Name']),
      );
      expect(labels(r.fields), ['E']);
      expect(labels(r.empty), ['A', 'B', 'C', 'D']);
    });

    test('renders a nested value as readable text', () {
      final r = resolveContextFields(const {
        'Meta': {'a': 1},
        'List': [1, 2],
      }, display());
      final values = [for (final f in r.fields) f.value];
      expect(values, containsAll(['{"a":1}', '[1,2]']));
    });

    test('returns an entirely empty result for a contact with no extra columns', () {
      final r = resolveContextFields(const {}, display());
      expect([r.hero, r.fields, r.empty], everyElement(isEmpty));
    });
  });

  group('heuristic hero selection', () {
    test('picks at most one per bucket, in bucket order', () {
      expect(labels(resolveContextFields(_context, display()).hero), ['First Name', 'Amount Due', 'Policy #', 'City']);
    });

    test('skips a heuristic match whose value is empty', () {
      expect(labels(resolveContextFields(const {'Customer Name': '', 'City': 'Pune'}, display()).hero), ['City']);
    });

    test('never guesses when the operator configured heroes', () {
      expect(labels(resolveContextFields(_context, display(hero: ['Branch'])).hero), ['Branch']);
    });

    test('reports whether heroes were configured, so the UI can label a guess', () {
      expect(heroesWereConfigured(display(hero: ['City'])), isTrue);
      expect(heroesWereConfigured(display(hero: [])), isFalse);
      expect(heroesWereConfigured(null), isFalse);
    });
  });

  group('displayNameFor', () {
    test('a full-name column wins, hero columns first', () {
      expect(displayNameFor(const {'City': 'Pune', 'Customer Name': 'Ravi Kumar'}, null), 'Ravi Kumar');
      expect(displayNameFor(const {'name': 'A', 'Full Name': 'B'}, null, heroKeys: ['Full Name']), 'B');
    });

    test('first + last when there is no full name', () {
      expect(displayNameFor(const {'First Name': 'Asha', 'Last Name': 'Rao'}, null), 'Asha Rao');
      expect(displayNameFor(const {'first_name': 'Asha'}, null), 'Asha');
    });

    test('null when nothing looks like a name, or the value is a placeholder or a number', () {
      expect(displayNameFor(const {'City': 'Pune', 'Customer ID': 'C-1'}, null), isNull);
      expect(displayNameFor(const {'Name': 'N/A'}, null), isNull);
      expect(displayNameFor(const {'Name': '+91 98400 12345'}, null), isNull);
    });

    test('never reads a hidden column', () {
      expect(displayNameFor(const {'Name': 'Asha'}, display(hidden: ['name'])), isNull);
    });
  });

  group('priorAttemptsFor', () {
    wire.PriorAttempt prior(String campaignId, {String? code, wire.AttemptOutcome? outcome, int day = 1}) => wire.PriorAttempt(
          attemptNumber: day,
          campaignId: campaignId,
          campaignName: campaignId == 'camp-1' ? 'Renewals' : 'Q3 Winback',
          dispositionCode: code,
          outcome: outcome,
          endedAt: DateTime.utc(2026, 8, day, 10),
        );

    test('this campaign first, server order kept within each group, labels never raw codes', () {
      final out = priorAttemptsFor(
        [
          prior('parent', code: 'wrong_person', day: 3),
          prior('camp-1', code: 'interested', day: 2),
          prior('camp-1', outcome: wire.AttemptOutcome.noAnswer, day: 1),
        ],
        campaignId: 'camp-1',
        catalog: [const wire.Disposition(code: 'interested', label: 'Interested')],
        offsetMs: 0,
      );
      expect([for (final p in out) p.outcomeLabel], ['Interested', 'No answer', 'Wrong person']);
      expect([for (final p in out) p.sameCampaign], [true, true, false]);
      expect(out.last.campaignName, 'Q3 Winback');
    });

    test('times are mapped to this device', () {
      final out = priorAttemptsFor([prior('camp-1', day: 1)], campaignId: 'camp-1', catalog: const [], offsetMs: 60000);
      expect(out.single.at, DateTime.utc(2026, 8, 1, 9, 59));
    });
  });

  group('release copy (port of agencyReleaseCopy.test.ts)', () {
    test('every reason the contract knows has words, and none is a raw code', () {
      for (final reason in wire.ReleaseReason.values.where((r) => r != wire.ReleaseReason.unknown)) {
        final copy = releaseCopy(reason, 'srv');
        expect(isKnownReleaseReason(reason), isTrue, reason: reason.wire);
        expect(copy.headline, isNotEmpty);
        // Snake-case codes are the ones that could leak; `busy` is also a word.
        if (reason.wire.contains('_')) {
          expect('${copy.headline} ${copy.subtext}'.contains(reason.wire), isFalse);
        }
      }
    });

    test('an unknown reason still produces a headline and uses the server sentence', () {
      expect(releaseCopy(wire.ReleaseReason.unknown, '  The line went quiet.  ').subtext, 'The line went quiet.');
      expect(releaseCopy(wire.ReleaseReason.unknown, '').headline, 'Call ended');
      expect(releaseCopy(wire.ReleaseReason.unknown, '').subtext, 'The call ended.');
      expect(isKnownReleaseReason(wire.ReleaseReason.unknown), isFalse);
    });

    test('tones match the console', () {
      expect(releaseCopy(wire.ReleaseReason.agentDisconnected, '').tone, ReleaseTone.danger);
      expect(releaseCopy(wire.ReleaseReason.abandoned, '').tone, ReleaseTone.warning);
      expect(releaseCopy(wire.ReleaseReason.completed, '').tone, ReleaseTone.neutral);
    });

    test('says "we" in every retry promise and never promises this agent will call back', () {
      for (final r in [wire.ReleaseReason.noAnswer, wire.ReleaseReason.busy, wire.ReleaseReason.failed]) {
        final text = releaseCopy(r, '').subtext;
        expect(text, contains("We'll"));
        expect(text.toLowerCase(), isNot(contains("i'll")));
      }
    });
  });

  group('join and switch copy (port of agencyJoinConflict.ts)', () {
    test('does not tell a mid-call agent to leave right now', () {
      expect(joinConflictRemedy('Renewals', wire.AgentState.onCall), startsWith('Finish what you’re doing on Renewals'));
      expect(joinConflictRemedy('Renewals', wire.AgentState.onBreak), 'Leave Renewals first, then come back here.');
      expect(conflictIsMidCall(wire.AgentState.wrapup), isTrue);
      expect(conflictIsMidCall(wire.AgentState.available), isFalse);
    });

    test('switch failures name the stage', () {
      expect(switchFailureCopy(SwitchStage.leave, 'Renewals', null), 'Renewals is still open. Try again.');
      expect(switchFailureCopy(SwitchStage.rejoin, 'Renewals', 'Not staffed.'),
          'Left Renewals, but couldn’t join this campaign — Not staffed.');
    });
  });

  group('disposition rules (port of agencyDispositionForm.ts)', () {
    final catalog = [
      const wire.Disposition(code: 'interested', label: 'Interested'),
      const wire.Disposition(code: 'callback', label: 'Call back', requiresDatetime: true),
      const wire.Disposition(code: 'not_interested', label: 'Not interested', requiresNote: true),
    ];
    final now = DateTime.utc(2026, 1, 1, 12);

    DispositionBlock? block(String? code, {String notes = '', DateTime? at}) =>
        dispositionBlock(catalog, code: code, notes: notes, callbackAt: at, now: now);

    test('each block in order', () {
      expect(block(null), DispositionBlock.noSelection);
      expect(block('gone'), DispositionBlock.noSelection);
      expect(block('not_interested', notes: '   '), DispositionBlock.noteRequired);
      expect(block('callback'), DispositionBlock.datetimeRequired);
      expect(block('callback', at: now), DispositionBlock.callbackInPast);
      expect(block('callback', at: now.add(const Duration(hours: 1))), isNull);
      expect(block('interested'), isNull);
    });

    test('the request trims notes, omits empty ones, and sends callback_at only when asked for', () {
      final r = buildDispositionRequest(catalog, code: 'interested', notes: '  ok  ', callbackAt: now, now: now)!;
      expect(r.toJson(), {'disposition_code': 'interested', 'notes': 'ok'});
      final cb = buildDispositionRequest(catalog, code: 'callback', notes: '', callbackAt: now.add(const Duration(hours: 1)), now: now)!;
      expect(cb.toJson()['callback_at'], isNotNull);
      expect(cb.toJson().containsKey('notes'), isFalse);
      expect(buildDispositionRequest(catalog, code: 'callback', notes: '', callbackAt: null, now: now), isNull);
    });

    test('resync follows allowed_codes, keeps known entries, labels the new, drops repeats', () {
      final next = resyncDispositions(catalog, ['callback', 'wrong_number', 'callback', '']);
      expect([for (final d in next) d.code], ['callback', 'wrong_number']);
      expect(identical(next.first, catalog[1]), isTrue);
      expect(next.last.label, 'Wrong number');
    });
  });

  test('error copy for the call actions keys off the code', () {
    expect(humaniseCode('do_not-call'), 'Do not call');
    expect(alreadyRecordedCopy('Interested'), 'This call is already recorded as Interested.');
    expect(alreadyRecordedCopy(null), 'This call already has a different outcome recorded.');
  });
}
