// The card's rules (AS19), the domain's own, in Dart, so the app and the console
// cannot disagree: the name and place guess and the customer's name
// (`packages/domain/src/customer-name.ts`, S1, S2), the hero rule
// (`context-hero.ts`, R1, R2), the one phone rule (`fact-phone.ts`, R6, S3)
// and the one builder of chosen tiles (`fact-tiles.ts`, S6), with the small
// readings they share (`context-columns.ts`). Each is held to the shared cases
// in `packages/contracts/fixtures/agent/fact-rules.json`, which the TypeScript
// originals run too (`test/fact_rules_test.dart`).

import 'dart:convert';

import 'agent_station.dart' show ContextFieldType, FactField, FactTile, FactTileRole;
import 'context_facts.dart';
import 'session.dart' show ContextDisplay;

// ─── The shared readings (`context-columns.ts`) ─────────────────────────────

/// A column name as compared: trimmed, lower case.
String foldColumnName(String name) => name.trim().toLowerCase();

/// A value that is present but carries no information.
const _placeholderValues = {'-', '--', 'n/a', 'na', 'null', 'none', ''};

/// A context value as display text (null for none): strings as they are,
/// scalars stringified (a whole double as JavaScript writes it, `5`), the
/// rest as JSON. The domain's `contextValueText`.
String? contextValueText(Object? value) {
  if (value == null) return null;
  if (value is String) return value;
  if (value is bool || value is int) return '$value';
  if (value is double) {
    return value.isFinite && value == value.truncateToDouble() && value.abs() < 1e21 ? '${value.toInt()}' : '$value';
  }
  try {
    return jsonEncode(value);
  } on Object {
    return null;
  }
}

/// Empty, or a placeholder such as `-` or `N/A`. The domain's `isBlankContextValue`.
bool isBlankContextValue(Object? value) {
  final text = contextValueText(value);
  return text == null || _placeholderValues.contains(text.trim().toLowerCase());
}

bool _nonBlank(String? s) => s != null && s.trim().isNotEmpty;

Set<String> _hiddenOf(ContextDisplay? display) => {
  for (final h in display?.hidden ?? const <String>[]) foldColumnName(h),
};

/// The row's own key for a configured column [name]: the exact spelling,
/// else the first key equal to it ignoring case; never a hidden one.
String? _rowKey(Map<String, Object?> context, String? name, Set<String> hidden) {
  if (name == null || !_nonBlank(name) || hidden.contains(foldColumnName(name))) return null;
  if (context.containsKey(name)) return name;
  for (final k in context.keys) {
    if (foldColumnName(k) == foldColumnName(name) && !hidden.contains(foldColumnName(k))) return k;
  }
  return null;
}

/// Each fact's column, as written, skipping a blank one.
List<String> _factColumns(ContextDisplay? display) => [
  for (final f in display?.facts ?? const <FactField>[])
    if (_nonBlank(f.column)) f.column,
];

// ─── The name and place guess (`customer-name.ts`, S1, S2) ──────────────────

/// Column names read as the customer's name when no role names one, in order.
/// Contract: the domain's `NAME_GUESS_COLUMNS`.
const nameGuessColumns = ['name', 'full_name', 'customer_name', 'first_name'];

/// Column names read as the customer's place when no role names one.
/// Contract: the domain's `PLACE_GUESS_COLUMNS`.
const placeGuessColumns = ['city', 'town', 'place', 'location', 'district', 'village'];

/// The longest name or place shown; a longer value is cut. The domain's `CUSTOMER_TEXT_MAX`.
const customerTextMax = 100;

final _squashed = RegExp(r'[\s_\-.]+');

/// A column name with case, spaces, `_`, `-` and `.` ignored: `Customer Name`
/// is `customer_name`. The domain's `squashColumnName`.
String squashColumnName(String name) => name.toLowerCase().replaceAll(_squashed, '');

String? _guessColumn(
  Object source,
  List<String> guesses,
  Iterable<String> hidden,
  Iterable<String> exclude,
  Map<String, ContextFieldType>? types,
) {
  final left = {
    for (final c in [...hidden, ...exclude]) foldColumnName(c),
  };
  final List<String> columns;
  if (source is Map<String, Object?>) {
    columns = [
      for (final e in source.entries)
        if (!left.contains(foldColumnName(e.key)) && !isBlankContextValue(e.value)) e.key,
    ];
  } else if (source is Iterable<String>) {
    columns = [
      for (final c in source)
        if (!left.contains(foldColumnName(c))) c,
    ];
  } else {
    throw ArgumentError.value(source, 'source', 'a row (Map<String, Object?>) or column names (Iterable<String>)');
  }
  for (final guess in guesses) {
    for (final c in columns) {
      if (squashColumnName(c) == squashColumnName(guess) && factTypeOf(c, types) != ContextFieldType.phone) return c;
    }
  }
  return null;
}

/// The column the customer's name is guessed from: the first column whose
/// squashed name is on [nameGuessColumns], in the list's order; never a
/// [hidden] or [exclude]d one (compared ignoring case), never one [types]
/// reads as a phone number (the column matched ignoring case, as
/// [factTypeOf] matches it). [source] is a row (`Map<String, Object?>`, blank
/// values skipped) or column names (`Iterable<String>`). `Customer ID` and
/// `Contact Number` are never the name. The domain's `guessNameColumn`.
String? guessNameColumn(
  Object source, {
  Iterable<String> hidden = const [],
  Iterable<String> exclude = const [],
  Map<String, ContextFieldType>? types,
}) =>
    _guessColumn(source, nameGuessColumns, hidden, exclude, types);

/// The column the line under the name is guessed from: as [guessNameColumn],
/// over [placeGuessColumns]. The domain's `guessPlaceColumn`.
String? guessPlaceColumn(
  Object source, {
  Iterable<String> hidden = const [],
  Iterable<String> exclude = const [],
  Map<String, ContextFieldType>? types,
}) =>
    _guessColumn(source, placeGuessColumns, hidden, exclude, types);

/// A column's value as the name or the place: trimmed, cut to
/// [customerTextMax], null when blank. The domain's `customerText`.
String? customerText(Object? value) {
  if (isBlankContextValue(value)) return null;
  final text = contextValueText(value)?.trim();
  if (text == null || text.isEmpty) return null;
  return text.length > customerTextMax ? text.substring(0, customerTextMax) : text;
}

/// The row's column the customer's name is read from: the `name` role's when
/// set (null when the row has no such visible column: no guess then), else
/// [guessNameColumn] over the row, never a fact's column. The domain's
/// `customerNameColumn`.
String? customerNameColumn(Map<String, Object?> context, ContextDisplay? display) {
  final hidden = _hiddenOf(display);
  final role = display?.roles?.name;
  if (_nonBlank(role)) return _rowKey(context, role, hidden);
  return guessNameColumn(context, hidden: hidden, exclude: _factColumns(display), types: display?.types);
}

/// The customer's name on this row, or null (S1). The domain's `customerNameFrom`.
String? customerNameFrom(Map<String, Object?> context, ContextDisplay? display) {
  final key = customerNameColumn(context, display);
  return key == null ? null : customerText(context[key]);
}

/// The row's column the line under the name is read from: the `place` role's
/// when set, else, without facts, the guess; with facts none (S2). The
/// domain's `customerPlaceColumn`.
String? customerPlaceColumn(Map<String, Object?> context, ContextDisplay? display) {
  final hidden = _hiddenOf(display);
  final role = display?.roles?.place;
  if (_nonBlank(role)) return _rowKey(context, role, hidden);
  if (display?.facts != null) return null;
  return guessPlaceColumn(context, hidden: hidden, types: display?.types);
}

/// The line under the customer's name on this row, or null. The domain's `customerPlaceFrom`.
String? customerPlaceFrom(Map<String, Object?> context, ContextDisplay? display) {
  final key = customerPlaceColumn(context, display);
  return key == null ? null : customerText(context[key]);
}

// ─── The hero rule (`context-hero.ts`) ──────────────────────────────────────

/// The legacy hero cap. The domain's `MAX_HERO_FIELDS`.
const maxHeroFields = 4;

/// The most facts a card shows. Contract: `AGENCY_FACT_FIELDS_MAX`.
const factFieldsMax = 4;

/// The most heroes a surface shows: with facts (AS19 R2), the name and
/// [factFieldsMax] facts; else [maxHeroFields]. The domain's `heroCapFor`.
int heroCapFor(ContextDisplay? display) => display?.facts != null ? 1 + factFieldsMax : maxHeroFields;

final _heroHeuristics = [
  RegExp(r'^(full[\s_-]?)?name$|customer|contact|first.?name|client', caseSensitive: false),
  RegExp('amount|balance|due|outstanding|premium|emi|total', caseSensitive: false),
  RegExp('policy|account|loan|invoice|order|ticket|ref', caseSensitive: false),
  RegExp('city|branch|region|zone|state', caseSensitive: false),
];

List<String> _heroNames(ContextDisplay? display) => [
  for (final h in display?.hero ?? const <String>[])
    if (_nonBlank(h)) h,
];

/// The configured hero names as written, before `hidden`.
List<String> _heroNamesAsConfigured(ContextDisplay? display, String? nameGuess) {
  if (display?.facts == null) return _heroNames(display);
  final role = display?.roles?.name;
  final name = _nonBlank(role) ? role : nameGuess;
  return [if (_nonBlank(name)) name!, ..._factColumns(display)];
}

/// Each name once, minus hidden.
List<String> _withoutHidden(List<String> names, Set<String> hidden) => [
  for (final n in {...names})
    if (!hidden.contains(foldColumnName(n))) n,
];

/// The campaign's configured hero names, without a row: with facts (AS19),
/// the customer's name (the `name` role's column, else [guessNameColumn] over
/// `hero`, never a fact's column) then each fact's column; else `hero`. Each
/// once, minus hidden (ignoring case); not capped. Empty when nothing is
/// configured. The domain's `configuredHeroNames`.
List<String> configuredHeroNames(ContextDisplay? display) {
  final hidden = _hiddenOf(display);
  final nameGuess = display?.facts != null && !_nonBlank(display?.roles?.name)
      ? guessNameColumn(_heroNames(display), hidden: hidden, exclude: _factColumns(display), types: display?.types)
      : null;
  return _withoutHidden(_heroNamesAsConfigured(display, nameGuess), hidden);
}

/// The row's hero columns (its own key spelling), in display order: the
/// configured heroes ([configuredHeroNames], the name guessed over the row's
/// visible columns with a value); with facts that is all (S2); else one per
/// heuristic bucket; else, unless [fallbackToFirstColumns] is false, the
/// first columns with a value. In [columnOrder] (the import's order) first,
/// then the row's; never a hidden column; at most [max] (default
/// [heroCapFor]). The domain's `heroColumnsFor`.
List<String> heroColumnsFor(
  Map<String, Object?> context,
  ContextDisplay? display, {
  List<String>? columnOrder,
  int? max,
  bool fallbackToFirstColumns = true,
}) {
  final cap = max ?? heroCapFor(display);
  List<String> capped(List<String> l) => l.length > cap ? l.sublist(0, cap) : l;
  final ordered = {
    for (final k in columnOrder ?? const <String>[])
      if (context.containsKey(k)) k,
    ...context.keys,
  };
  final hidden = _hiddenOf(display);
  final visible = [
    for (final k in ordered)
      if (!hidden.contains(foldColumnName(k))) k,
  ];

  final chosen = display?.facts != null;
  final nameGuess = chosen && !_nonBlank(display?.roles?.name)
      ? guessNameColumn({for (final k in visible) k: context[k]}, exclude: _factColumns(display), types: display?.types)
      : null;
  final configured = <String>[];
  for (final name in _withoutHidden(_heroNamesAsConfigured(display, nameGuess), hidden)) {
    for (final k in visible) {
      if (foldColumnName(k) == foldColumnName(name)) {
        if (!configured.contains(k)) configured.add(k);
        break;
      }
    }
  }
  if (configured.isNotEmpty || chosen) return capped(configured);

  final guessed = <String>[];
  for (final pattern in _heroHeuristics) {
    for (final k in visible) {
      if (!guessed.contains(k) && pattern.hasMatch(k) && !isBlankContextValue(context[k])) {
        guessed.add(k);
        break;
      }
    }
  }
  if (guessed.isNotEmpty) return capped(guessed);

  if (!fallbackToFirstColumns) return const [];
  return capped([
    for (final k in visible)
      if (!isBlankContextValue(context[k])) k,
  ]);
}

// ─── The phone rule (`fact-phone.ts`, R6, S3) ───────────────────────────────

/// The fewest digits a masked number shows any of. The domain's `PHONE_MASK_MIN_DIGITS`.
const phoneMaskMinDigits = 7;

/// What a masked number too short to mask shows. The domain's `PHONE_MASK_NONE`.
const phoneMaskNone = '•••';

final _nonDigits = RegExp(r'\D');
final _indianMobile = RegExp(r'^[6-9]\d{9}$');

/// The ten digits of an Indian mobile from a number's digits (no `+`), or
/// null: twelve starting `91` and eleven starting `0` lose that prefix. The
/// domain's `indianMobileDigits`.
String? indianMobileDigits(String digits) {
  final national = digits.length == 12 && digits.startsWith('91')
      ? digits.substring(2)
      : digits.length == 11 && digits.startsWith('0')
      ? digits.substring(1)
      : digits;
  return _indianMobile.hasMatch(national) ? national : null;
}

/// A phone fact in full: an Indian mobile as `+91 98765 43210`, anything else
/// as given, trimmed. [value] is the parsed value, or a raw value the parse
/// refused. The domain's `formatFactPhone`.
String formatFactPhone(String value) {
  final text = value.trim();
  final mobile = indianMobileDigits(text.replaceAll(_nonDigits, ''));
  return mobile == null ? text : '+91 ${mobile.substring(0, 5)} ${mobile.substring(5)}';
}

/// A phone fact masked: the first two and the last three digits (of the ten
/// for an Indian mobile), `98••• ••210`; [phoneMaskNone] when it has fewer
/// than [phoneMaskMinDigits]. The domain's `maskFactPhone`.
String maskFactPhone(String value) {
  final bare = value.replaceAll(_nonDigits, '');
  final shown = indianMobileDigits(bare) ?? bare;
  if (shown.length < phoneMaskMinDigits) return phoneMaskNone;
  return '${shown.substring(0, 2)}••• ••${shown.substring(shown.length - 3)}';
}

// ─── The chosen tiles (`fact-tiles.ts`, S6) ─────────────────────────────────

/// The type [types] declares for [column] (its exact spelling, else the first
/// entry equal to it ignoring case); text when none or one this build does
/// not know. The domain's `factTypeOf`.
ContextFieldType factTypeOf(String column, Map<String, ContextFieldType>? types) {
  if (types == null) return ContextFieldType.text;
  ContextFieldType? declared = types[column];
  if (!types.containsKey(column)) {
    for (final e in types.entries) {
      if (foldColumnName(e.key) == foldColumnName(column)) {
        declared = e.value;
        break;
      }
    }
  }
  return declared == null || declared == ContextFieldType.unknown ? ContextFieldType.text : declared;
}

FactTileRole? _roleOfKey(String? key) => switch (key) {
  'amount_due' => FactTileRole.amountDue,
  'due_date' => FactTileRole.dueDate,
  _ => null,
};

/// The tiles of a campaign with chosen facts (AS19): one per fact whose
/// column the row has (exact, else ignoring case) and is not hidden, in
/// order, each column once; the label trimmed (none when blank), the key
/// (none when empty); the type [factTypeOf]; `raw` the value as text (`''`
/// when blank); `value` [parseContextFact] (against [now]); the tile keyed
/// `amount_due` / `due_date` that role, one tile per role; only the first
/// highlighted fact keeps the highlight and moves first; then at most
/// [factFieldsMax]. Empty when the display has no facts. The domain's
/// `chosenFactTiles`.
List<FactTile> chosenFactTiles(Map<String, Object?> context, ContextDisplay? display, {DateTime? now}) {
  final facts = display?.facts;
  if (facts == null) return const [];
  final hidden = _hiddenOf(display);
  final tiles = <FactTile>[];
  var highlighted = -1;
  for (final fact in facts) {
    final column = _rowKey(context, fact.column, hidden);
    if (column == null || tiles.any((t) => t.column == column)) continue;
    final label = fact.label.trim();
    final key = fact.key.isEmpty ? null : fact.key;
    final keyRole = _roleOfKey(key);
    final role = keyRole != null && tiles.any((t) => t.role == keyRole) ? null : keyRole;
    final type = factTypeOf(column, display?.types);
    final raw = contextValueText(context[column]) ?? '';
    final highlight = fact.highlight && highlighted < 0;
    if (highlight) highlighted = tiles.length;
    tiles.add(
      FactTile(
        column: column,
        label: label.isEmpty ? null : label,
        key: key,
        highlight: highlight,
        role: role,
        type: type,
        raw: raw,
        value: parseContextFact(raw, type, now: now),
      ),
    );
  }
  if (highlighted > 0) tiles.insert(0, tiles.removeAt(highlighted));
  return List.unmodifiable(tiles.length > factFieldsMax ? tiles.sublist(0, factFieldsMax) : tiles);
}
