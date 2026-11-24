import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../logic/facts.dart';
import '../station_copy.dart';
import 'layouts.dart';

/// How many More details rows one push down opens (AS20, as the console).
const moreDetailsStep = 4;

/// The shortest time between two of those steps (each push is one drag, however long), so two
/// quick flicks open one step.
const moreDetailsPause = Duration(milliseconds: 300);

/// How far the last More details was opened, and whether the agent closed it with "Hide", so the
/// card drawn again for the same call (Call coming, then On call: two screens) opens as far as the
/// agent left it. One entry: the newest.
({String attemptId, int shown, bool held})? _remembered;

/// Forgets how far More details was opened: for tests, which draw one call many times.
@visibleForTesting
void forgetMoreDetails() => _remembered = null;

/// More details (AS20): the customer's other columns, under the card on Call coming and On call.
/// Closed at first, with a count and "Scroll down to see them."; while its end is on screen, each
/// push down on the page ([StationScrollPush]) opens [moreDetailsStep] more rows, one step per
/// [moreDetailsPause], each new row fading in (no motion when the phone asks for none). "Show all"
/// opens them at once and "Hide" closes them until "Show all" again (a push opens nothing). Values are uploaded text, plain, wrapped; a phone
/// number is hidden as the campaign hides numbers (AS9).
class MoreDetailsCard extends ConsumerStatefulWidget {
  const MoreDetailsCard({super.key, required this.call});

  final CallView call;

  @override
  ConsumerState<MoreDetailsCard> createState() => _MoreDetailsCardState();
}

class _MoreDetailsCardState extends ConsumerState<MoreDetailsCard> {
  final _end = GlobalKey();
  ValueListenable<int>? _pushes;
  int _shown = 0;
  int _from = 0;
  bool _held = false;
  DateTime? _lastStep;

  List<FactTileView> get _tiles {
    final facts = widget.call.facts;
    if (facts == null) return const [];
    return moreDetailTiles(facts, hasLastCall: widget.call.priorAttempts.isNotEmpty);
  }

  @override
  void initState() {
    super.initState();
    _restore();
  }

  void _restore() {
    final r = _remembered;
    final same = r != null && r.attemptId == widget.call.attemptId;
    _shown = same ? r.shown.clamp(0, _tiles.length) : 0;
    _held = same && r.held;
    _from = _shown;
    _lastStep = null;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final pushes = StationScrollPush.maybeOf(context);
    if (!identical(pushes, _pushes)) {
      _pushes?.removeListener(_onPush);
      _pushes = pushes?..addListener(_onPush);
    }
  }

  @override
  void didUpdateWidget(MoreDetailsCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.call.attemptId != widget.call.attemptId) _restore();
  }

  @override
  void dispose() {
    _pushes?.removeListener(_onPush);
    super.dispose();
  }

  void _set(int shown, {required int from, bool held = false}) {
    setState(() {
      _from = from;
      _shown = shown;
      _held = held;
    });
    _remembered = (attemptId: widget.call.attemptId, shown: shown, held: held);
  }

  /// True when the end of More details is inside the page's visible part.
  bool _endOnScreen() {
    final end = _end.currentContext?.findRenderObject() as RenderBox?;
    final scrollable = context.findAncestorStateOfType<ScrollableState>()?.context.findRenderObject() as RenderBox?;
    if (end == null || !end.attached || scrollable == null || !scrollable.attached) return false;
    final y = end.localToGlobal(Offset.zero, ancestor: scrollable).dy;
    return y >= 0 && y <= scrollable.size.height;
  }

  void _onPush() {
    final total = _tiles.length;
    if (!mounted || _shown >= total || _held) return;
    // `clock`, not `DateTime.now`: the same instant, and a test's fake one.
    final now = clock.now();
    final last = _lastStep;
    if (last != null && now.difference(last) < moreDetailsPause) return;
    if (!_endOnScreen()) return;
    _lastStep = now;
    _set((_shown + moreDetailsStep).clamp(0, total), from: _shown);
  }

  @override
  Widget build(BuildContext context) {
    final tiles = _tiles;
    if (tiles.isEmpty) return const SizedBox.shrink();
    final masked = ref.watch(stationViewProvider.select((v) => v?.maskPhone ?? false));
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final still = MediaQuery.disableAnimationsOf(context);
    final total = tiles.length;
    final shown = _shown.clamp(0, total);
    final all = shown >= total;
    return Padding(
      padding: const EdgeInsets.only(top: Space.md),
      child: DecoratedBox(
        key: const Key('more-details-card'),
        decoration: BoxDecoration(
          color: t.bgSecondary,
          borderRadius: BorderRadius.circular(Radii.lg),
          border: Border.all(color: t.border),
        ),
        child: Padding(
          padding: const EdgeInsets.all(Space.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Side by side when they fit; at large text on a narrow phone the button goes under the
              // title, so neither is squeezed.
              OverflowBar(
                alignment: MainAxisAlignment.spaceBetween,
                overflowAlignment: OverflowBarAlignment.start,
                spacing: Space.sm,
                overflowSpacing: Space.xs,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.playlist_add, size: 20, color: t.textSecondary),
                      const SizedBox(width: Space.sm),
                      Flexible(
                        child: Semantics(
                          header: true,
                          child: Text.rich(
                            TextSpan(
                              text: StationCopy.moreDetailsTitle,
                              style: text.titleSmall!.copyWith(color: t.textSecondary),
                              children: [
                                TextSpan(text: '  ${StationCopy.moreDetailsCount(total)}', style: text.bodySmall!.copyWith(color: t.textMuted)),
                              ],
                            ),
                            key: const Key('more-details-title'),
                          ),
                        ),
                      ),
                    ],
                  ),
                  // Merged, so the button itself says whether the list is open.
                  MergeSemantics(
                    child: Semantics(
                      expanded: shown > 0,
                      child: TextButton.icon(
                        key: const Key('more-details-toggle'),
                        onPressed: () => all ? _set(0, from: 0, held: true) : _set(total, from: shown),
                        icon: Icon(all ? Icons.expand_less : Icons.expand_more),
                        label: Text(all ? StationCopy.moreDetailsHide : StationCopy.moreDetailsShowAll),
                      ),
                    ),
                  ),
                ],
              ),
              for (final (i, tile) in tiles.take(shown).indexed)
                _MoreRow(
                  key: ValueKey('more-detail-${tile.column}'),
                  label: tile.column,
                  value: factText(tile, masked: masked),
                  fadeIn: !still && i >= _from,
                  delay: Duration(milliseconds: 60 * (i - _from).clamp(0, moreDetailsStep)),
                ),
              if (!all) ...[
                const SizedBox(height: Space.sm),
                Text(
                  shown == 0 ? StationCopy.moreDetailsHint : StationCopy.moreDetailsShown(shown, total),
                  key: const Key('more-details-hint'),
                  style: text.bodySmall!.copyWith(color: t.textMuted),
                ),
              ],
              SizedBox(key: _end, height: 1),
            ],
          ),
        ),
      ),
    );
  }
}

/// One row of More details: the column's name over its value, read as one by a screen reader.
class _MoreRow extends StatefulWidget {
  const _MoreRow({super.key, required this.label, required this.value, required this.fadeIn, required this.delay});

  final String label;
  final String value;
  final bool fadeIn;
  final Duration delay;

  @override
  State<_MoreRow> createState() => _MoreRowState();
}

class _MoreRowState extends State<_MoreRow> with SingleTickerProviderStateMixin {
  static const _fade = Duration(milliseconds: 260);

  // The row waits its turn ([_MoreRow.delay]) inside one animation, then fades and slides in.
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: _fade + widget.delay,
    value: widget.fadeIn ? 0 : 1,
  );
  late final Animation<double> _in = CurvedAnimation(
    parent: _c,
    curve: Interval(widget.delay.inMicroseconds / (_fade + widget.delay).inMicroseconds, 1, curve: Curves.easeOut),
  );

  @override
  void initState() {
    super.initState();
    if (widget.fadeIn) _c.forward();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final row = Padding(
      padding: const EdgeInsets.only(top: Space.sm),
      child: DecoratedBox(
        decoration: BoxDecoration(color: t.bgPrimary, borderRadius: BorderRadius.circular(Radii.md)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: Space.xs),
          child: MergeSemantics(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(widget.label, style: text.labelSmall!.copyWith(color: t.textMuted)),
                const SizedBox(height: 2),
                Text(widget.value, key: const Key('more-value'), style: text.titleSmall),
              ],
            ),
          ),
        ),
      ),
    );
    return FadeTransition(
      opacity: _in,
      child: SlideTransition(
        position: Tween(begin: const Offset(0, 0.15), end: Offset.zero).animate(_in),
        child: row,
      ),
    );
  }
}
