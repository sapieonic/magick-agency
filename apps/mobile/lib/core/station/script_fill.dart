import 'package:agency_wire/agency_wire.dart' as wire;
import 'package:flutter/foundation.dart';

/// A fact the script can say (AS19): its name, for "`<name> not given`", and its value as the card
/// shows it; null when the customer has none.
@immutable
final class ScriptFact {
  const ScriptFact({required this.label, this.value});

  final String label;
  final String? value;

  @override
  bool operator ==(Object other) => other is ScriptFact && other.label == label && other.value == value;
  @override
  int get hashCode => Object.hash(label, value);
}

/// What a script's `{key}`s say for the call on screen (BE-8, AS19).
@immutable
final class ScriptValues {
  const ScriptValues({this.name, this.place, this.agentName, this.campaignName, this.facts = const {}, this.factLabels = const {}});

  /// The customer's name and place (`{name}`, `{place}`); null when the customer has none.
  final String? name;
  final String? place;

  /// The agent's first name and the work's name; null leaves the key out.
  final String? agentName;
  final String? campaignName;

  /// Every other key's fact, by key: the chosen facts' keys (AS19), or on a campaign without them
  /// `amount_due` and `due_date` from the role tiles.
  final Map<String, ScriptFact> facts;

  /// The campaign's fact names by key, for a key this customer has no tile for.
  final Map<String, String> factLabels;
}

/// One run of a filled script line.
sealed class ScriptRun {
  const ScriptRun();

  /// The run as the screen shows it.
  String get text;
}

/// Text the agent says: the script's own words, a filled `{key}`, or a `{word}` the campaign does
/// not have (shown as written).
final class SaidRun extends ScriptRun {
  const SaidRun(this.text);
  @override
  final String text;

  @override
  bool operator ==(Object other) => other is SaidRun && other.text == text;
  @override
  int get hashCode => text.hashCode;
  @override
  String toString() => 'SaidRun($text)';
}

/// A `{key}` the customer has no value for: "`<name> not given`", in the muted style, and never read
/// aloud (AS19).
final class NotGivenRun extends ScriptRun {
  const NotGivenRun(this.label);
  final String label;

  @override
  String get text => '$label not given';

  @override
  bool operator ==(Object other) => other is NotGivenRun && other.label == label;
  @override
  int get hashCode => label.hashCode;
  @override
  String toString() => 'NotGivenRun($label)';
}

/// The names of the keys every script may use, for "`<name> not given`".
const _fixedLabels = {'name': 'Name', 'place': 'Place', 'amount_due': 'Amount due', 'due_date': 'Due date'};

/// A script line filled for the call on screen (AS19): each `{key}` in [allowed] (the campaign's
/// keys, `ScriptView.placeholders`) is its value, or "`<name> not given`" when this customer has none
/// (the agent's own name and the work's name are left out instead); any other `{word}` stays as
/// written. Keys may hold digits (`{emi_2}`). The contract's one reading of braces, `scriptPieces`.
List<ScriptRun> fillScriptRuns(String text, Iterable<String> allowed, ScriptValues v) {
  final runs = <ScriptRun>[];
  void say(String t) {
    if (t.isEmpty) return;
    final prev = runs.isEmpty ? null : runs.last;
    if (prev is SaidRun) {
      runs[runs.length - 1] = SaidRun(prev.text + t);
    } else {
      runs.add(SaidRun(t));
    }
  }

  String? clean(String? s) => s == null || s.trim().isEmpty ? null : s;

  for (final piece in wire.scriptPieces(text, allowed.toSet())) {
    switch (piece) {
      case wire.ScriptText(:final text):
        say(text);
      case wire.ScriptUnknown(:final token):
        say(token);
      case wire.ScriptKey(:final key):
        switch (key) {
          case 'agent_name':
            say(clean(v.agentName) ?? '');
          case 'campaign_name':
            say(clean(v.campaignName) ?? '');
          case 'name' || 'place':
            final value = clean(key == 'name' ? v.name : v.place);
            if (value != null) {
              say(value);
            } else {
              runs.add(NotGivenRun(_fixedLabels[key]!));
            }
          default:
            final fact = v.facts[key];
            final value = clean(fact?.value);
            if (value != null) {
              say(value);
            } else {
              runs.add(NotGivenRun(fact?.label ?? v.factLabels[key] ?? _fixedLabels[key] ?? key));
            }
        }
    }
  }
  return List.unmodifiable(runs);
}

/// The line as the screen shows it, "not given" included.
String shownScript(List<ScriptRun> runs) => runs.map((r) => r.text).join();

/// The line as read aloud (AS13, AS19): without the "not given" runs, spaces closed up.
String spokenScript(List<ScriptRun> runs) => runs
    .whereType<SaidRun>()
    .map((r) => r.text)
    .join()
    .replaceAll(RegExp(r'[ \t]{2,}'), ' ')
    .replaceAllMapped(RegExp(r' +([,.;:!?])'), (m) => m[1]!)
    .trim();
