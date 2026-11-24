/// The customer's facts as the station's card and script show them (BE-6, AS19).
library;

import 'package:agency_wire/agency_wire.dart' show foldColumnName;

import '../../../core/station/station_view.dart';
import 'format.dart';

/// At most this many fact tiles on the card (AS19: four facts at most; no Last call tile beside
/// them, Last calls has its own card).
const maxCardTiles = 4;

/// The BE-6 tiles in the order the card shows them: amount due and due date first, then the rest
/// in hero order; never the name's or the place's own column, never an empty one.
List<FactTileView> factTilesInOrder(FactsView facts) {
  bool isNameOrPlace(FactTileView f) => f.raw.trim() == facts.name || f.raw.trim() == facts.place;
  final shown = facts.tiles.where((f) => f.raw.trim().isNotEmpty && !isNameOrPlace(f)).toList();
  return [
    ...shown.where((f) => f.amountDue),
    ...shown.where((f) => f.dueDate),
    ...shown.where((f) => !f.amountDue && !f.dueDate),
  ];
}

/// How many tiles the BE-6 card draws in its row (before AS19): three, or two beside the Last call tile.
int legacyTileRoom({required bool hasLastCall}) => hasLastCall ? 2 : 3;

/// The BE-6 tiles the card draws in its row ([legacyTileRoom] of them).
List<FactTileView> legacyCardTiles(FactsView facts, {required bool hasLastCall}) =>
    factTilesInOrder(facts).take(legacyTileRoom(hasLastCall: hasLastCall)).toList(growable: false);

/// AS20, More details: the server's `facts.more` minus the columns the card already draws (its
/// chosen tiles, or the BE-6 row), matched ignoring case, each column once, empty values left out.
/// Empty when the server sent none.
List<FactTileView> moreDetailTiles(FactsView facts, {required bool hasLastCall}) {
  final more = facts.more;
  if (more == null) return const [];
  final drawn = facts.chosen ? cardFactTiles(facts) : legacyCardTiles(facts, hasLastCall: hasLastCall);
  final skip = {for (final t in drawn) foldColumnName(t.column)};
  final out = <FactTileView>[];
  for (final t in more) {
    if (factIsEmpty(t) || !skip.add(foldColumnName(t.column))) continue;
    out.add(t);
  }
  return List.unmodifiable(out);
}

/// The campaign's chosen facts (AS19) in the order the card draws them: the list's order, with the
/// first highlighted one moved first (the server sends it first; this holds even if it did not).
/// Empty values stay: the card shows "—". At most [maxCardTiles].
List<FactTileView> cardFactTiles(FactsView facts) {
  final tiles = facts.tiles.take(maxCardTiles).toList(growable: false);
  final h = tiles.indexWhere((t) => t.highlight);
  if (h <= 0) return tiles;
  return [tiles[h], for (final (i, t) in tiles.indexed) if (i != h) t];
}

/// The value has nothing in it: the card shows "—", the script "`<name> not given`".
bool factIsEmpty(FactTileView f) => f.raw.trim().isEmpty;

/// What the card shows for an empty value.
const emptyFactText = '—';

/// The fact is drawn as a figure (it shrinks to fit before it is ever cut): money, a number, a date
/// or a phone number the server could read.
bool factIsFigure(FactTileView f) =>
    !factIsEmpty(f) &&
    f.parsed != null &&
    switch (f.kind) {
      FactKind.money || FactKind.number || FactKind.date || FactKind.phone => true,
      FactKind.text || FactKind.yesNo => false,
    };

/// A fact as the station shows it (AS19, the console's rules): money as `₹1,25,000` (paise only
/// when not zero), a number as `1,25,000`, a date as `20 Nov` (`20 Nov 2027` when [now] is given and
/// it is not this year), a phone number formatted, or hidden when the campaign hides numbers
/// ([masked], AS9: `98••• ••321`, never its digits), yes / no as `Yes` / `No`. A value the server
/// could not read is shown as uploaded (a hidden phone column's still without its digits); an
/// empty one as "—".
String factText(FactTileView f, {bool masked = false, DateTime? now}) {
  if (factIsEmpty(f)) return emptyFactText;
  // As uploaded, without the spaces around it (as the console shows it).
  final raw = f.raw.trim();
  final parsed = f.parsed;
  if (f.kind == FactKind.phone && masked) {
    return maskFactPhone(parsed ?? raw);
  }
  if (parsed == null) return raw;
  return switch (f.kind) {
    FactKind.money => formatRupees(parsed),
    FactKind.number => formatIndianNumber(parsed),
    FactKind.date => formatFactDate(parsed, now: now),
    FactKind.phone => formatFactPhone(parsed),
    FactKind.yesNo => switch (parsed) {
        'yes' => 'Yes',
        'no' => 'No',
        _ => raw,
      },
    FactKind.text => raw,
  };
}

/// The compact card's first fact (AS19 S4): "Amount due: ₹12,500", the first of the card's facts
/// ([cardFactTiles]) with a value, as the card shows it; null when none has one.
String? firstFactLine(FactsView facts, {bool masked = false, DateTime? now}) {
  final f = cardFactTiles(facts).where((f) => !factIsEmpty(f)).firstOrNull;
  return f == null ? null : '${f.label}: ${factText(f, masked: masked, now: now)}';
}

/// Details' list under the pinned fields: with More details from the server (AS20), the line under
/// the name first (the card cuts it to one line; here it is in full), then More details' rows (the
/// columns the supervisor turned off left out, phone numbers hidden as the campaign hides them) as
/// fields, minus the pinned ones; from an older server, the roster row as before ([CallView.otherFields]).
List<ContactField> detailsOtherFields(CallView call, {bool masked = false, DateTime? now}) {
  final more = call.facts?.more;
  if (more == null) return call.otherFields;
  final pinned = {for (final f in call.heroFields) foldColumnName(f.label)};
  // The place's column is the one the server read the place from ([CallView.placeColumn], the
  // domain's rule), matched by its name ignoring case, never by its value (another column may hold
  // the same text, and the server cuts a long place); More details leaves it out, as the card shows
  // it. Only when the server read a place: a blank or placeholder value is none.
  final place = call.facts?.place?.trim() ?? '';
  final column = call.placeColumn;
  final placeField = place.isEmpty || column == null || pinned.contains(foldColumnName(column))
      ? null
      : call.otherFields.where((f) => foldColumnName(f.label) == foldColumnName(column) && f.value.trim().isNotEmpty).firstOrNull;
  final skip = {...pinned, if (placeField != null) foldColumnName(placeField.label)};
  return List.unmodifiable([
    ?placeField,
    for (final t in more)
      if (!factIsEmpty(t) && !skip.contains(foldColumnName(t.column)))
        ContactField(key: t.column, label: t.column, value: factText(t, masked: masked, now: now)),
  ]);
}
