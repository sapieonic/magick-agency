import 'package:agency_wire/agency_wire.dart' as wire;
import 'package:meta/meta.dart';

import 'promise_rules.dart';
import 'server_clock.dart';
import 'station_copy.dart';
import 'station_view.dart';

/// The contact panel: which of a contact's arbitrary roster columns to show
/// and in what order (port of the console's `agencyContext.ts`), the name to
/// lead with, and the person's earlier calls.
///
/// The resolution rules are a cross-client contract (`AgencyContextDisplay`),
/// in precedence order:
///   1. the heroes first, pinned: the domain's one hero rule (`wire.heroColumnsFor`, the
///      domain's `context-hero.ts`): with the campaign's chosen facts (AS19) the customer's name
///      (the name role's column, else the name guess) then each fact's column, capped at the name
///      and four facts (R2); else `hero`, or a guess of one name, money, identity and place
///      column, capped at four ([wire.heroCapFor]);
///   2. then the `order` columns, in array order;
///   3. then every remaining column in ORIGINAL roster order;
///   4. minus `hidden`, at every stage.
/// Names match case- and whitespace-insensitively. A guess is said as one ("auto-selected"); with
/// chosen facts nothing but the name is guessed, even when the choice is empty.

@immutable
final class ResolvedField {
  const ResolvedField({required this.label, required this.value, required this.isEmpty});

  /// The original header, unchanged.
  final String label;

  /// Display text; always rendered as text, never markup.
  final String value;

  /// Empty or a placeholder (`-`, `N/A`, …).
  final bool isEmpty;

  @override
  bool operator ==(Object other) =>
      other is ResolvedField && other.label == label && other.value == value && other.isEmpty == isEmpty;

  @override
  int get hashCode => Object.hash(label, value, isEmpty);

  @override
  String toString() => 'ResolvedField($label)';
}

@immutable
final class ResolvedContextFields {
  const ResolvedContextFields({required this.hero, required this.fields, required this.empty});

  final List<ResolvedField> hero;

  /// Everything else with a value, in resolved order.
  final List<ResolvedField> fields;

  /// Empty or placeholder values, in resolved order, collapsed behind a summary.
  final List<ResolvedField> empty;
}

/// Readable text for any roster value, the domain's reading (`wire.contextValueText`): a nested
/// object renders as JSON, never as an object's type name; a whole number as it was written.
String contextDisplayString(Object? value) => wire.contextValueText(value) ?? '';

String _norm(String key) => key.trim().toLowerCase();

/// [maxHero] overrides the hero cap ([wire.heroCapFor]: the name and four facts with chosen
/// facts, else four).
ResolvedContextFields resolveContextFields(
  Map<String, Object?> context,
  wire.ContextDisplay? display, {
  int? maxHero,
}) {
  final original = context.keys.toList(growable: false);
  final hiddenKeys = {for (final k in display?.hidden ?? const <String>[]) _norm(k)};
  bool isHidden(String key) => hiddenKeys.contains(_norm(key));

  ResolvedField field(String key) =>
      ResolvedField(label: key, value: contextDisplayString(context[key]), isEmpty: wire.isBlankContextValue(context[key]));

  List<String> resolveNames(List<String>? names) {
    if (names == null) return const [];
    final out = <String>[];
    for (final name in names) {
      final wanted = _norm(name);
      for (final key in original) {
        if (_norm(key) == wanted) {
          // A configured name this contact lacks is skipped, never rendered blank.
          if (!isHidden(key) && !out.contains(key)) out.add(key);
          break;
        }
      }
    }
    return out;
  }

  // The panel lists every column under the heroes, so with nothing configured or guessed it pins
  // nothing (the rule's last stage, the first columns, is off), as the console's panel.
  final heroKeys = wire.heroColumnsFor(
    context,
    display,
    max: maxHero ?? wire.heroCapFor(display),
    fallbackToFirstColumns: false,
  );

  final heroSet = heroKeys.toSet();
  final ordered = [
    for (final k in resolveNames(display?.order))
      if (!heroSet.contains(k)) k,
  ];
  final orderedSet = ordered.toSet();
  final remaining = [
    for (final k in original)
      if (!heroSet.contains(k) && !orderedSet.contains(k) && !isHidden(k)) k,
  ];
  final rest = [...ordered, ...remaining].map(field).toList(growable: false);
  return ResolvedContextFields(
    hero: List.unmodifiable(heroKeys.map(field)),
    fields: List.unmodifiable(rest.where((f) => !f.isEmpty)),
    empty: List.unmodifiable(rest.where((f) => f.isEmpty)),
  );
}

/// True when the operator configured heroes (or chose the card's facts, AS19); false when they
/// were guessed.
bool heroesWereConfigured(wire.ContextDisplay? display) =>
    display?.facts != null || (display?.hero ?? const <String>[]).isNotEmpty;

// ─── The name to lead with ──────────────────────────────────────────────────

final _fullName = RegExp(r'^((full|customer|contact|client|account[\s_-]?holder|borrower)[\s_-]?)?name$', caseSensitive: false);
final _firstName = RegExp(r'^(first|given)[\s_-]?name$', caseSensitive: false);
final _lastName = RegExp(r'^(last|sur|family)[\s_-]?name$|^surname$', caseSensitive: false);
final _digitsOnly = RegExp(r'^[\d\s+()-]+$');

/// The person's name for the headline of a campaign call WITHOUT chosen facts (the legacy card),
/// when a column says it plainly: a full-name column, else first + last. Hero columns are looked
/// at first. Null when nothing looks like a name, and the UI leads with the number.
///
/// Never for an inbound caller or a soft-phone contact, nor for a campaign with chosen facts: those
/// read the customer's name by the domain's one rule ([customerNameOf], AS19 S1).
String? displayNameFor(Map<String, Object?> context, wire.ContextDisplay? display, {List<String> heroKeys = const []}) {
  final hidden = {for (final k in display?.hidden ?? const <String>[]) _norm(k)};
  final keys = [...heroKeys, ...context.keys.where((k) => !heroKeys.contains(k))]
      .where((k) => !hidden.contains(_norm(k)))
      .toList(growable: false);

  String? valueOf(String key) {
    final v = contextDisplayString(context[key]).trim();
    if (wire.isBlankContextValue(v) || _digitsOnly.hasMatch(v)) return null;
    return v;
  }

  for (final k in keys) {
    if (_fullName.hasMatch(k.trim())) {
      final v = valueOf(k);
      if (v != null) return v;
    }
  }
  String? first;
  String? last;
  for (final k in keys) {
    final t = k.trim();
    if (first == null && _firstName.hasMatch(t)) first = valueOf(k);
    if (last == null && _lastName.hasMatch(t)) last = valueOf(k);
  }
  if (first != null) return last != null ? '$first $last' : first;
  return null;
}

/// The customer's name on a roster row by the domain's one rule (AS19 S1, `wire.customerNameFrom`):
/// the campaign's name role's column when it sets one (blank on this row: none), else the name
/// guess, never a fact's column. Null when there is none. Inbound callers and soft-phone contacts.
String? customerNameOf(Map<String, Object?>? context, wire.ContextDisplay? display) =>
    context == null ? null : wire.customerNameFrom(context, display);

// ─── Earlier calls ──────────────────────────────────────────────────────────

const Map<wire.AttemptOutcome, String> _outcomeLabels = {
  wire.AttemptOutcome.connected: 'Connected',
  wire.AttemptOutcome.noAnswer: 'No answer',
  wire.AttemptOutcome.busy: 'Line busy',
  wire.AttemptOutcome.failed: "Couldn't connect",
  wire.AttemptOutcome.machine: 'Answering machine',
  wire.AttemptOutcome.invalid: 'Number not usable',
  wire.AttemptOutcome.abandoned: 'Dropped before an agent',
  wire.AttemptOutcome.agentDisconnected: 'Agent connection dropped',
  wire.AttemptOutcome.orphaned: 'Recovered',
  wire.AttemptOutcome.canceled: 'Cancelled',
};

/// Earlier dials of this person, this campaign's first (each group keeps the
/// server's newest-first order). A disposition code from a parent campaign's
/// catalog falls back to readable words, never the raw code. Times are
/// mapped to this device's clock.
List<PriorAttempt> priorAttemptsFor(
  List<wire.PriorAttempt> prior, {
  required String campaignId,
  required List<wire.Disposition> catalog,
  required int offsetMs,
}) {
  String labelFor(wire.PriorAttempt p) {
    final code = p.dispositionCode;
    if (code != null && code.isNotEmpty) {
      for (final d in catalog) {
        if (d.code == code) return d.label;
      }
      return humaniseCode(code);
    }
    final outcome = p.outcome;
    if (outcome != null) return _outcomeLabels[outcome] ?? humaniseCode(p.outcomeRaw ?? '');
    return 'No outcome recorded';
  }

  final same = <PriorAttempt>[];
  final other = <PriorAttempt>[];
  for (final p in prior) {
    final at = correctedInstant(p.endedAt ?? p.dialedAt, offsetMs);
    if (at == null) continue;
    final notes = p.notes?.trim();
    final view = PriorAttempt(
      at: at,
      outcomeLabel: labelFor(p),
      notes: notes == null || notes.isEmpty ? null : notes,
      sameCampaign: p.campaignId == campaignId,
      campaignName: p.campaignName,
      promise: p.promiseDate == null ? null : formatPromise(p.promiseDate!, p.promiseAmount),
    );
    (view.sameCampaign ? same : other).add(view);
  }
  return List.unmodifiable([...same, ...other]);
}

/// A contact's latest promise to pay (PT9), as the station shows it; null
/// without one.
PromiseView? promiseViewFor(wire.ContactPromise? promise) => promise == null
    ? null
    : PromiseView(
        text: formatPromise(promise.date, promise.amount),
        state: switch (promise.state) {
          wire.PromiseState.upcoming => PromiseStanding.upcoming,
          wire.PromiseState.dueToday => PromiseStanding.dueToday,
          wire.PromiseState.missed => PromiseStanding.missed,
          wire.PromiseState.followedUp => PromiseStanding.followedUp,
          wire.PromiseState.unknown => PromiseStanding.unknown,
        },
      );
