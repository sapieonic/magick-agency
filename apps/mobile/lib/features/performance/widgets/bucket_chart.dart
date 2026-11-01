import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../ui/primitives.dart';
import '../logic/bucket_series.dart';
import '../logic/en_in_format.dart';

/// Day-by-day dials and conversations as grouped columns, drawn with a
/// [CustomPainter] (no chart library: two series of at most 31 points need
/// no zoom, pan or time scale).
///
/// Grouped, never stacked: every conversation is also a dial, so a stacked
/// column would draw a number that does not exist. Dials are accent and
/// conversations ember, and a legend names both (identity is never carried by
/// colour alone). Tapping a day labels its two values; a screen reader gets a
/// summary of the whole chart and one node per day, and "Show the numbers"
/// repeats everything as text. Part-days are drawn faded.
class BucketChart extends StatefulWidget {
  const BucketChart({super.key, required this.series});

  final BucketSeries series;

  static const double plotHeight = 168;

  @override
  State<BucketChart> createState() => _BucketChartState();
}

class _BucketChartState extends State<BucketChart> {
  int? _selected;
  bool _showTable = false;

  @override
  void didUpdateWidget(BucketChart old) {
    super.didUpdateWidget(old);
    if (old.series != widget.series) _selected = null;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final series = widget.series;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(header: true, child: Text('Day by day', style: text.titleSmall)),
          const SizedBox(height: 2),
          Text('What you dialled and what you talked to, one bar pair per day.', style: text.bodySmall),
          const SizedBox(height: Space.md),
          if (!series.drawable)
            Text(singleBucketNote, key: const Key('bucket-chart-single'), style: text.bodySmall)
          else ...[
            _SelectionLine(point: _selected == null ? null : series.points[_selected!]),
            const SizedBox(height: Space.xs),
            LayoutBuilder(
              builder: (context, constraints) {
                final width = constraints.maxWidth;
                final painter = BucketChartPainter(
                  series: series,
                  selected: _selected,
                  dials: t.accent,
                  conversations: t.ember,
                  grid: t.border,
                  axis: t.borderStrong,
                  highlight: t.bgTertiary,
                  tickStyle: monoStyle(context, size: 10.5, color: t.textMuted),
                  valueStyle: monoStyle(context, size: 11, weight: FontWeight.w600, color: t.textPrimary),
                  textScaler: MediaQuery.textScalerOf(context).clamp(maxScaleFactor: 1.3),
                );
                return Semantics(
                  container: true,
                  label: chartSummary(series),
                  child: GestureDetector(
                    key: const Key('bucket-chart'),
                    behavior: HitTestBehavior.opaque,
                    onTapDown: (d) {
                      final i = painter.indexAt(d.localPosition.dx, width);
                      setState(() => _selected = i == _selected ? null : i);
                    },
                    child: RepaintBoundary(
                      child: CustomPaint(size: Size(width, BucketChart.plotHeight), painter: painter),
                    ),
                  ),
                );
              },
            ),
            const SizedBox(height: Space.sm),
            ExcludeSemantics(
              child: Wrap(
                spacing: Space.lg,
                runSpacing: Space.xs,
                children: [
                  _LegendItem(color: t.accent, label: 'Dials'),
                  _LegendItem(color: t.ember, label: 'Conversations'),
                ],
              ),
            ),
            const SizedBox(height: Space.sm),
            if (series.hasPartial) ...[
              Text(partialBucketNote, key: const Key('bucket-partial-note'), style: text.bodySmall),
              const SizedBox(height: Space.xs),
            ],
            Text(bucketTimezoneNote, key: const Key('bucket-timezone-note'), style: text.bodySmall),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: () => setState(() => _showTable = !_showTable),
                child: Text(_showTable ? 'Hide the numbers' : 'Show the numbers'),
              ),
            ),
            if (_showTable) _NumbersTable(points: series.points),
          ],
        ],
      ),
    );
  }
}

/// The tapped day's values, announced as they change.
class _SelectionLine extends StatelessWidget {
  const _SelectionLine({required this.point});

  final SeriesPoint? point;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme.labelMedium;
    return Semantics(
      liveRegion: true,
      child: Text(
        point == null ? 'Tap a day to see its numbers.' : pointSummary(point!),
        key: const Key('bucket-selection'),
        style: style,
        maxLines: 2,
      ),
    );
  }
}

class _LegendItem extends StatelessWidget {
  const _LegendItem({required this.color, required this.label});

  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          DecoratedBox(
            decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2)),
            child: const SizedBox.square(dimension: 10),
          ),
          const SizedBox(width: 6),
          Flexible(child: Text(label, style: Theme.of(context).textTheme.labelMedium)),
        ],
      );
}

class _NumbersTable extends StatelessWidget {
  const _NumbersTable({required this.points});

  final List<SeriesPoint> points;

  @override
  Widget build(BuildContext context) {
    final head = Theme.of(context).textTheme.labelSmall;
    final cell = monoStyle(context, size: 13);
    TableRow row(String a, String b, String c, TextStyle? s) => TableRow(children: [
          Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text(a, style: s)),
          Text(b, style: s, textAlign: TextAlign.end),
          Text(c, style: s, textAlign: TextAlign.end),
        ]);
    return Table(
      key: const Key('bucket-chart-table'),
      columnWidths: const {0: FlexColumnWidth(1.4), 1: FlexColumnWidth(), 2: FlexColumnWidth(1.4)},
      defaultVerticalAlignment: TableCellVerticalAlignment.middle,
      children: [
        row('Day', 'Dials', 'Conversations', head),
        for (final p in points)
          row(p.partial ? '${p.title} *' : p.title, EnIn.count(p.attempts), EnIn.count(p.connected), cell),
      ],
    );
  }
}

/// Paints the plot. Geometry comes from [ChartLayout] (pure, tested); this
/// class only turns it into paths.
class BucketChartPainter extends CustomPainter {
  BucketChartPainter({
    required this.series,
    required this.selected,
    required this.dials,
    required this.conversations,
    required this.grid,
    required this.axis,
    required this.highlight,
    required this.tickStyle,
    required this.valueStyle,
    required this.textScaler,
  });

  final BucketSeries series;
  final int? selected;
  final Color dials;
  final Color conversations;
  final Color grid;
  final Color axis;
  final Color highlight;
  final TextStyle tickStyle;
  final TextStyle valueStyle;
  final TextScaler textScaler;

  static const double padLeft = 36;
  static const double padRight = 4;
  static const double padTop = 18;
  static const double padBottom = 20;

  /// How faded a part-day's bars are.
  static const double partialAlpha = 0.45;

  ChartLayout layoutFor(double width) =>
      ChartLayout(width: math.max(0, width - padLeft - padRight), count: series.points.length);

  /// The day under a tap at [dx] in a chart [width] wide.
  int indexAt(double dx, double width) => layoutFor(width).indexAt(dx - padLeft);

  TextPainter _text(String s, TextStyle style) =>
      TextPainter(text: TextSpan(text: s, style: style), textDirection: TextDirection.ltr, textScaler: textScaler)
        ..layout();

  @override
  void paint(Canvas canvas, Size size) {
    final layout = layoutFor(size.width);
    final plotH = size.height - padTop - padBottom;
    final baseline = padTop + plotH;
    final top = series.top;

    // Three hairlines, not five: the tap label and the table carry precision.
    final gridPaint = Paint()..strokeWidth = 1;
    for (final fraction in const [0.0, 0.5, 1.0]) {
      final y = baseline - fraction * plotH;
      gridPaint.color = fraction == 0 ? axis : grid;
      canvas.drawLine(Offset(padLeft, y), Offset(size.width - padRight, y), gridPaint);
      final tick = _text(EnIn.count((top * fraction).round()), tickStyle);
      tick.paint(canvas, Offset(padLeft - 6 - tick.width, y - tick.height / 2));
    }

    if (selected != null) {
      final x = padLeft + selected! * layout.bandWidth;
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromLTWH(x, padTop - 4, layout.bandWidth, plotH + 4), const Radius.circular(4)),
        Paint()..color = highlight,
      );
    }

    // The peak dial column gets the one direct label when nothing is tapped.
    var peak = 0;
    for (var i = 1; i < series.points.length; i++) {
      if (series.points[i].attempts > series.points[peak].attempts) peak = i;
    }

    final dialPaint = Paint();
    final convPaint = Paint();
    final every = layout.labelEvery;
    for (var i = 0; i < series.points.length; i++) {
      final p = series.points[i];
      final alpha = p.partial ? partialAlpha : 1.0;
      dialPaint.color = dials.withValues(alpha: dials.a * alpha);
      convPaint.color = conversations.withValues(alpha: conversations.a * alpha);
      final x0 = padLeft + layout.groupStart(i);
      final hA = ChartLayout.barHeight(p.attempts, top, plotH);
      final hC = ChartLayout.barHeight(p.connected, top, plotH);
      final pathA = columnPath(x0, baseline - hA, layout.barWidth, hA);
      final pathC = columnPath(x0 + layout.barWidth + ChartLayout.barGap, baseline - hC, layout.barWidth, hC);
      if (pathA != null) canvas.drawPath(pathA, dialPaint);
      if (pathC != null) canvas.drawPath(pathC, convPaint);

      if (i == selected) {
        _valueLabel(canvas, EnIn.count(p.attempts), x0 + layout.barWidth / 2, baseline - hA);
        _valueLabel(canvas, EnIn.count(p.connected), x0 + layout.barWidth * 1.5 + ChartLayout.barGap, baseline - hC);
      } else if (selected == null && i == peak && p.attempts > 0) {
        _valueLabel(canvas, EnIn.count(p.attempts), x0 + layout.groupWidth / 2, baseline - hA);
      }

      if (i % every == 0) {
        final day = _text(p.label, tickStyle);
        day.paint(canvas, Offset(padLeft + layout.groupCentre(i) - day.width / 2, baseline + 4));
      }
    }
  }

  void _valueLabel(Canvas canvas, String s, double cx, double barTop) {
    final tp = _text(s, valueStyle);
    tp.paint(canvas, Offset(cx - tp.width / 2, math.max(0, barTop - tp.height - 2)));
  }

  /// One node per day, so a screen reader can walk the bars.
  @override
  SemanticsBuilderCallback get semanticsBuilder => (size) {
        final layout = layoutFor(size.width);
        return [
          for (var i = 0; i < series.points.length; i++)
            CustomPainterSemantics(
              rect: Rect.fromLTWH(padLeft + i * layout.bandWidth, 0, layout.bandWidth, size.height),
              properties: SemanticsProperties(label: pointSummary(series.points[i]), textDirection: TextDirection.ltr),
            ),
        ];
      };

  @override
  bool shouldRepaint(BucketChartPainter oldDelegate) =>
      oldDelegate.series != series ||
      oldDelegate.selected != selected ||
      oldDelegate.dials != dials ||
      oldDelegate.conversations != conversations ||
      oldDelegate.grid != grid ||
      oldDelegate.textScaler != textScaler;

  @override
  bool shouldRebuildSemantics(BucketChartPainter oldDelegate) => oldDelegate.series != series;
}

/// A column rounded at the data end and square at the baseline (a fully
/// rounded rect lifts a short bar off its axis). Null for a zero bar.
Path? columnPath(double x, double y, double width, double height) {
  if (height <= 0) return null;
  final r = math.min(4.0, math.min(width / 2, height));
  final bottom = y + height;
  return Path()
    ..moveTo(x, bottom)
    ..lineTo(x, y + r)
    ..quadraticBezierTo(x, y, x + r, y)
    ..lineTo(x + width - r, y)
    ..quadraticBezierTo(x + width, y, x + width, y + r)
    ..lineTo(x + width, bottom)
    ..close();
}
