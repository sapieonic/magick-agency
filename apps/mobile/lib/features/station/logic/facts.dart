/// The customer's facts as the station's card and script show them (BE-6, AS19).
library;

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
