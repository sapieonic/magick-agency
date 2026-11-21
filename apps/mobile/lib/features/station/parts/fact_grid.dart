import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../logic/facts.dart';
import '../station_copy.dart';
import '../station_providers.dart' show stationClockProvider;
import 'sheets.dart' show StationModalGuard, thisCallNow;

/// The card's chosen facts (AS19, the phone's form): a 2 × 2 grid; the highlighted fact first, the
/// full row, in the call colour; a lone last tile the full width. Text stays on one line and ends
/// in "…"; money, numbers, dates and phone numbers shrink to fit (to 65 % at most) before they are
/// ever cut. An empty value is "—". Press and hold a fact for its full value ([showFactSheet]).
/// Only the facts: no Last call tile (Last calls has its own card). At large text the tiles stack
/// one under the other.
class FactGrid extends ConsumerWidget {
  const FactGrid({super.key, required this.tiles});

  /// In the card's order ([cardFactTiles]).
  final List<FactTileView> tiles;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final masked = ref.watch(stationViewProvider.select((v) => v?.maskPhone ?? false));
    final now = ref.watch(stationClockProvider)();
    final highlight = tiles.isNotEmpty && tiles.first.highlight;
    final cells = <Widget>[
      for (final (i, f) in tiles.indexed)
        FactCell(
          key: Key('fact-tile-$i'),
          label: f.label,
          value: factText(f, masked: masked, now: now),
          figure: factIsFigure(f),
          empty: factIsEmpty(f),
          highlight: i == 0 && highlight,
          column: f.column,
        ),
    ];
    if (cells.isEmpty) return const SizedBox.shrink();

    final stacked = MediaQuery.textScalerOf(context).scale(16) / 16 > 1.4;
    final rows = <List<Widget>>[];
    var i = 0;
    if (highlight || stacked) {
      rows.add([cells[0]]);
      i = 1;
    }
    while (i < cells.length) {
      if (stacked || i + 1 >= cells.length) {
        rows.add([cells[i]]);
        i += 1;
      } else {
        rows.add([cells[i], cells[i + 1]]);
        i += 2;
      }
    }
    return Column(
      key: const Key('fact-grid'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final (r, row) in rows.indexed) ...[
          if (r > 0) const SizedBox(height: Space.sm),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final (c, cell) in row.indexed) ...[if (c > 0) const SizedBox(width: Space.sm), Expanded(child: cell)],
            ],
          ),
        ],
      ],
    );
  }
}

/// One tile of [FactGrid]: the fact's name over its value. With a [column] (a fact, not the last
/// call), press and hold opens [showFactSheet], and a screen reader says so.
class FactCell extends StatelessWidget {
  const FactCell({
    super.key,
    required this.label,
    required this.value,
    this.figure = false,
    this.empty = false,
    this.highlight = false,
    this.column,
  });

  final String label;

  /// As shown: formatted, a hidden number hidden, "—" when empty.
  final String value;

  /// Shrinks to fit rather than being cut.
  final bool figure;
  final bool empty;
  final bool highlight;
  final String? column;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final call = context.stateTokens.onCall;
    final text = Theme.of(context).textTheme;
    final figureStyle = (highlight ? text.headlineMedium : text.headlineSmall)!
        .copyWith(fontWeight: FontWeight.w800, fontFeatures: const [FontFeature.tabularFigures()], color: t.textPrimary);
    final wordStyle = (highlight ? text.titleLarge : text.titleMedium)!.copyWith(fontWeight: FontWeight.w700, color: t.textPrimary);
    final valueStyle = empty ? wordStyle.copyWith(color: t.textMuted, fontWeight: FontWeight.w600) : (figure ? figureStyle : wordStyle);

    final Widget valueBox;
    if (highlight && !figure) {
      // The highlighted fact's words may take two lines.
      valueBox = Text(value, key: const Key('fact-value'), style: valueStyle, maxLines: 2, overflow: TextOverflow.ellipsis);
    } else {
      // Every tile's value sits in a box the height of a figure, so the two tiles of a row match.
      valueBox = _ValueLine(text: value, style: valueStyle, shrink: figure, boxStyle: figureStyle);
    }

    final tile = DecoratedBox(
      decoration: BoxDecoration(color: highlight ? call.soft : t.bgPrimary, borderRadius: BorderRadius.circular(Radii.md)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: Space.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: text.bodySmall!.copyWith(color: highlight ? call.deep : null, fontWeight: highlight ? FontWeight.w700 : null),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              softWrap: false,
            ),
            const SizedBox(height: 2),
            valueBox,
          ],
        ),
      ),
    );

    final from = column;
    if (from == null) {
      return Semantics(container: true, label: '$label: $value', excludeSemantics: true, child: tile);
    }
    void open() => showFactSheet(context, label: label, value: value, column: from);
    return Semantics(
      container: true,
      label: '$label: $value',
      hint: StationCopy.factHoldHint,
      onLongPressHint: StationCopy.factHoldAction,
      onLongPress: open,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onLongPress: () {
          Feedback.forLongPress(context);
          open();
        },
        child: tile,
      ),
    );
  }
}

/// A one-line value: text ends in "…"; with [shrink], it first shrinks to fit, to 65 % of its size
/// at most. The box is one line of [boxStyle] high whatever the value's style.
class _ValueLine extends StatelessWidget {
  const _ValueLine({required this.text, required this.style, required this.shrink, required this.boxStyle});

  final String text;
  final TextStyle style;
  final bool shrink;
  final TextStyle boxStyle;

  /// The smallest a figure is drawn, against its own size.
  static const minScale = 0.65;

  @override
  Widget build(BuildContext context) {
    final scaler = MediaQuery.textScalerOf(context);
    final direction = Directionality.of(context);
    final box = TextPainter(text: TextSpan(text: 'Ag0', style: boxStyle), textDirection: direction, textScaler: scaler, maxLines: 1)
      ..layout();
    final height = box.height;
    box.dispose();
    return SizedBox(
      height: height,
      child: LayoutBuilder(
        builder: (context, c) {
          var size = style.fontSize ?? 14;
          if (shrink && c.maxWidth.isFinite) {
            final full = TextPainter(text: TextSpan(text: text, style: style), textDirection: direction, textScaler: scaler, maxLines: 1)
              ..layout();
            final width = full.width;
            full.dispose();
            if (width > c.maxWidth) size = size * math.max(minScale, (c.maxWidth / width) * 0.98);
          }
          return Align(
            alignment: AlignmentDirectional.centerStart,
            child: Text(
              text,
              key: const Key('fact-value'),
              style: style.copyWith(fontSize: size),
              maxLines: 1,
              softWrap: false,
              overflow: TextOverflow.ellipsis,
            ),
          );
        },
      ),
    );
  }
}

/// Press and hold a fact (AS19): its name, the full value as the card shows it (a hidden number
/// stays hidden), "From column: X", and OK. Closes by itself when the call on screen changes.
Future<void> showFactSheet(BuildContext context, {required String label, required String value, required String column}) {
  final view = ProviderScope.containerOf(context, listen: false).read(stationViewProvider);
  final scope = thisCallNow(view);
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (context) {
      final t = context.tokens;
      final text = Theme.of(context).textTheme;
      return StationModalGuard(
        scope: scope,
        child: SingleChildScrollView(
          key: const Key('fact-sheet'),
          padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(header: true, child: Text(label, style: text.titleSmall!.copyWith(color: t.textSecondary))),
              const SizedBox(height: Space.xs),
              Text(value, key: const Key('fact-sheet-value'), style: text.headlineSmall!.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: Space.xs),
              Text(StationCopy.fromColumn(column), key: const Key('fact-sheet-column'), style: text.bodySmall!.copyWith(color: t.textSecondary)),
              const SizedBox(height: Space.md),
              FilledButton(
                key: const Key('fact-sheet-ok'),
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(Space.touch)),
                onPressed: () => Navigator.of(context).pop(),
                child: const Text(StationCopy.ok),
              ),
            ],
          ),
        ),
      );
    },
  );
}
