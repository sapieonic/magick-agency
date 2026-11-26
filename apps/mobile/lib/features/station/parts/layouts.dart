import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderAbstractViewport;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart' show stationViewProvider;
import '../../../ui/keyboard.dart';
import '../widgets/action_buttons.dart';
import '../widgets/slide_to_confirm.dart';
import '../widgets/state_band.dart' show CompactBand;
import 'banners.dart';
import 'need_help.dart';
import 'top_bar.dart';

/// The one page shape every station screen uses (AS1, design-spec §1 and §4): the top bar, the
/// state's band, the screen's content (scrolling), and its actions pinned at the bottom, full
/// width, in thumb reach. At 200% text the content scrolls; the main action never moves off screen.
///
/// With the on-screen keyboard up the page ends at the keyboard's top (the shell's `Scaffold`
/// resizes for it, once: `ShellBody`), and the actions stay where they are, on the keyboard, with
/// the main one in view. They take at most a share of the page ([StationActionArea]), so the note
/// being typed keeps real room; its label and save status come into view with it
/// (`RevealWhileTyping`), and come back into view if a refusal appears under it
/// ([KeepTypingInView]). On a shorter page ([keyboardShortPage]), or at large text, the band keeps
/// only its title and clock while the keyboard is up ([CompactBand]), and stays, so the time left
/// to choose an outcome is in view while the agent types; on the shortest ([keyboardTinyPage]) it
/// scrolls with the content, as it does at large text with the keyboard down.
///
/// Under the band, in this order and at most one line each: the one-time listening notice, "your
/// customer is waiting", a slow internet line, the microphone, what ended while away, and how the
/// last Need help ended.
class StationPage extends StatelessWidget {
  const StationPage({
    super.key,
    required this.band,
    required this.body,
    this.actions,
    this.onCall = false,
    this.topBar = const StationTopBar(),
    this.banners = true,
    this.revealOnPush = false,
  });

  final Widget band;
  final List<Widget> body;

  /// The pinned actions; null for a screen with nothing to press ("The call connects by itself").
  final Widget? actions;

  /// A call screen: the listening notice says where its button is between calls.
  final bool onCall;
  final Widget topBar;

  /// The shared lines under the band; off for the screens with no station to work at.
  final bool banners;

  /// AS20: the content takes a push down even when it fits the screen, so the gesture reaches More
  /// details. Only the screens that draw it (Call coming, On call): elsewhere a page that fits stays
  /// still (AS1), and a press and hold on a fact is not taken for a drag.
  final bool revealOnPush;

  /// Under this much page with the keyboard up, the band keeps only its title and clock
  /// ([CompactBand], about 48 dp). 360×800 with a 300 dp keyboard leaves a 476 dp page: with the
  /// top bar (64), the whole band (72 to 116) and the actions (up to 45%, 214) pinned, the note
  /// would keep 82 dp. The testers' phone (411×917, a 330 dp keyboard) leaves 563, and the note
  /// 130 or more with the whole band; 499 under a supervisor's message.
  static const keyboardShortPage = 520.0;

  /// Under this much page with the keyboard up, the band scrolls with the content: 360×640 with a
  /// 300 dp keyboard leaves 316 dp (252 under a supervisor's message), and even the compact band
  /// would cost the note its label; 360×800 under a message leaves 412, where it would at 200%.
  static const keyboardTinyPage = 440.0;

  @override
  Widget build(BuildContext context) => KeyboardOpenBuilder(
    builder: (context, keyboard) => LayoutBuilder(builder: (context, box) => _page(context, keyboard, box.maxHeight)),
  );

  Widget _page(BuildContext context, bool keyboard, double height) {
    final t = context.tokens;
    final content = [
      if (banners) ...[
        ListenFirstNoticeCard(onCall: onCall),
        const StationTopNotices(),
        const WeakConnectionLine(),
        const MicProblemBanner(),
        const MissedReleaseCard(),
        const NeedHelpCard(),
      ],
      ...body,
    ];
    // Large text, or the keyboard up on a short page: the band gives the content its room. With
    // the keyboard up it keeps its title and clock in view, unless the page is too short even for
    // that; with the keyboard down (large text) it scrolls with the content. Otherwise it stays
    // put, whole.
    final large = MediaQuery.textScalerOf(context).scale(16) / 16 > 1.3;
    final compact = keyboard && height >= keyboardTinyPage && (large || height < keyboardShortPage);
    final tight = !compact && (large || (keyboard && height < keyboardShortPage));
    return ColoredBox(
      color: t.bgPrimary,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ColoredBox(color: t.bgSecondary, child: topBar),
          if (compact) CompactBand(child: band) else if (!tight) band,
          Expanded(
            child: _ScrollPushScope(
              child: KeepTypingInView(
                child: SingleChildScrollView(
                  // AS20: a push down reaches More details even when the content fits the screen.
                  physics: revealOnPush ? const AlwaysScrollableScrollPhysics() : null,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (tight) band,
                      Padding(
                        padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.lg),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: content),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (actions != null) StationActionArea(pageHeight: height, child: actions!),
        ],
      ),
    );
  }
}

/// AS20: each time the agent pushes the station's content down with a finger (it scrolls down, or
/// it is already at the end and the finger keeps pushing), [pushes] goes up by one: once per drag,
/// however long the finger stays down. More details listens, and opens a few more rows while its
/// end is on screen. Only the page's own scroll counts, never a list inside it, and only a finger
/// (a screen reader's scroll action and a fling carry no drag: "Show all" is their way).
class StationScrollPush extends InheritedWidget {
  const StationScrollPush({super.key, required this.pushes, required super.child});

  final ValueListenable<int> pushes;

  /// The page's pushes, or null outside a station page.
  static ValueListenable<int>? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<StationScrollPush>()?.pushes;

  @override
  bool updateShouldNotify(StationScrollPush oldWidget) => oldWidget.pushes != pushes;
}

class _ScrollPushScope extends StatefulWidget {
  const _ScrollPushScope({required this.child});

  final Widget child;

  @override
  State<_ScrollPushScope> createState() => _ScrollPushScopeState();
}

class _ScrollPushScopeState extends State<_ScrollPushScope> {
  final _pushes = ValueNotifier<int>(0);

  /// Whether this drag has counted its push already.
  bool _counted = false;

  @override
  void dispose() {
    _pushes.dispose();
    super.dispose();
  }

  bool _onScroll(ScrollNotification n) {
    if (n.depth != 0 || n.metrics.axis != Axis.vertical) return false;
    if (n is ScrollStartNotification) _counted = false;
    final down = switch (n) {
      ScrollUpdateNotification(:final dragDetails, :final scrollDelta) => dragDetails != null && (scrollDelta ?? 0) > 0,
      OverscrollNotification(:final dragDetails, :final overscroll) => dragDetails != null && overscroll > 0,
      _ => false,
    };
    if (down && !_counted) {
      _counted = true;
      _pushes.value++;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) => NotificationListener<ScrollNotification>(
    onNotification: _onScroll,
    child: StationScrollPush(pushes: _pushes, child: widget.child),
  );
}

/// The pinned bottom of a station screen: the last refusal, then the actions.
///
/// With the keyboard down it takes at most half the window under its padding, as it always has:
/// at 200% text on a 360×640 phone that holds the whole of What happened?'s Save & next call,
/// Save & take break and Call again. It never takes more than [restPageShare] of the page, so the
/// top bar and a strip of the content keep their place when the page is short for other reasons (a
/// supervisor's message over the tab at 200% text, a phone on its side); on a phone held upright
/// with no message that is more than the half window. The refusal over the actions takes at most
/// 22% of the window, leaving the main action [mainRoom].
///
/// With the on-screen keyboard up it takes at most [share] of the page it is pinned to
/// ([pageHeight]: the height the page is laid out in, so less the keyboard), the rest staying the
/// content's (the note being typed, its label and its save status). The refusal sits at the top,
/// at most [errorShare] of the page and never so much that the main action has less than
/// [mainRoom] (a longer refusal scrolls inside itself). While one shows, the area takes at least
/// what its first line ([errorRoom]) and [mainRoom] need, so a refusal that comes while the agent
/// types is in view, even when that is more than its share.
///
/// The actions take the rest and, when they do not fit (200% text, or the keyboard up on a small
/// phone), scroll inside themselves, keeping the screen's main action in view ([_ActionsScroll]),
/// with a scroll bar that says there is more: the secondary actions are the part that scrolls.
///
/// Measured with the app's fonts, a 24 dp status bar and the keyboard up: 360×640 with a 300 dp
/// keyboard leaves a 316 dp page, of which the top bar takes 64. Its 45% (142 dp) holds the
/// padding, the whole of Save & next call at 200% text (two lines, 116 dp), or a 64 dp main action
/// under the first line of a refusal, and leaves the content 110 dp: the note's label, its status
/// and the line being typed, at 200% text too. Half the page, as the soft phone's actions take,
/// would leave 94 dp, too little for that; 40% would cut the two-line Save. Under a supervisor's
/// message (252 dp) its share is 113 dp, and a refusal takes it to 136.
class StationActionArea extends ConsumerWidget {
  const StationActionArea({super.key, required this.pageHeight, required this.child});

  /// The height of the page the area is pinned to.
  final double pageHeight;
  final Widget child;

  /// The most of the page the area takes with the keyboard up, its padding included.
  static const share = 0.45;

  /// The most of the page the refusal takes with the keyboard up.
  static const errorShare = 0.2;

  /// The most of the window the actions take with the keyboard down, under the area's padding.
  static const restShare = 0.5;

  /// The most of the page the area takes with the keyboard down, its padding included.
  static const restPageShare = 0.7;

  /// The most of the window the refusal takes with the keyboard down.
  static const restErrorShare = 0.22;

  /// The room the refusal always leaves the actions: a main action at normal text, End call or a
  /// [MainActionButton] (64 dp).
  static const mainRoom = 64.0;

  /// The room a refusal always has while it shows: its first line beside its 48 dp Dismiss.
  static const errorRoom = 48.0;

  static const _padding = EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.md);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final refused = ref.watch(stationViewProvider.select((v) => v?.actionError != null));
    // Rebuilt as the keyboard moves: the page it is given changes height.
    final double most;
    final double errorMost;
    if (keyboardOpenOf(context)) {
      most = math.max(pageHeight * share, refused ? _padding.vertical + mainRoom + errorRoom : 0);
      errorMost = math.max(0.0, math.min(math.max(pageHeight * errorShare, errorRoom), most - _padding.vertical - mainRoom));
    } else {
      final window = MediaQuery.sizeOf(context).height;
      most = math.min(window * restShare + _padding.vertical, pageHeight * restPageShare);
      errorMost = math.max(0.0, math.min(window * restErrorShare, most - _padding.vertical - mainRoom));
    }
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: most),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: t.bgSecondary,
          border: Border(top: BorderSide(color: t.border)),
        ),
        child: Padding(
          padding: _padding,
          child: Column(
            key: const Key('station-actions'),
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              ConstrainedBox(
                constraints: BoxConstraints(maxHeight: errorMost),
                child: const SingleChildScrollView(key: Key('action-error-scroll'), child: ActionErrorLine()),
              ),
              Flexible(child: _ActionsScroll(child: child)),
            ],
          ),
        ),
      ),
    );
  }
}

/// A station screen's actions, scrolling inside themselves when they do not fit, with the screen's
/// main action kept in view: whenever the room or the actions change, they scroll to the least
/// offset that shows the first [MainActionButton] or [SlideToConfirm] (End call) in [child] whole,
/// whether it comes first (Save & next call) or last (End call, under Mute and Speaker). The agent
/// can still scroll to the others; while some are out of view a scroll bar shows beside them.
class _ActionsScroll extends StatefulWidget {
  const _ActionsScroll({required this.child});

  final Widget child;

  @override
  State<_ActionsScroll> createState() => _ActionsScrollState();
}

class _ActionsScrollState extends State<_ActionsScroll> {
  final _scroll = ScrollController();
  bool _scheduled = false;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _schedule() {
    if (_scheduled) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scheduled = false;
      _keepMainInView();
    });
  }

  void _keepMainInView() {
    if (!mounted || !_scroll.hasClients) return;
    final position = _scroll.position;
    if (!position.hasContentDimensions || position.maxScrollExtent <= 0) return;
    RenderObject? main;
    void visit(Element e) {
      if (main != null) return;
      if (e.widget is MainActionButton || e.widget is SlideToConfirm) {
        main = e.findRenderObject();
        return;
      }
      e.visitChildren(visit);
    }

    context.visitChildElements(visit);
    final box = main;
    if (box is! RenderBox || !box.attached || !box.hasSize) return;
    final viewport = RenderAbstractViewport.maybeOf(box);
    if (viewport == null) return;
    // Its top at the top of the view, and its bottom at the bottom: any offset between shows it
    // whole, and the least of them is its place (the same each time the room is the same, so it
    // is back where it was when the keyboard goes down). Taller than the view, its top.
    final top = viewport.getOffsetToReveal(box, 0).offset;
    final bottom = viewport.getOffsetToReveal(box, 1).offset;
    final target = bottom > top ? top : math.max(0.0, bottom);
    final clamped = target.clamp(position.minScrollExtent, position.maxScrollExtent);
    if ((clamped - position.pixels).abs() > 0.5) position.jumpTo(clamped);
  }

  @override
  Widget build(BuildContext context) {
    _schedule();
    return NotificationListener<ScrollMetricsNotification>(
      onNotification: (_) {
        _schedule();
        return false;
      },
      child: Scrollbar(
        key: const Key('station-actions-scrollbar'),
        controller: _scroll,
        thumbVisibility: true,
        child: SingleChildScrollView(controller: _scroll, child: widget.child),
      ),
    );
  }
}

/// Two buttons side by side, stacked when large text would squeeze them.
class ButtonPair extends StatelessWidget {
  const ButtonPair({super.key, required this.first, required this.second});

  final Widget first;
  final Widget second;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(16) / 16;
    if (scale > 1.35) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          first,
          const SizedBox(height: Space.sm),
          second,
        ],
      );
    }
    return Row(
      children: [
        Expanded(child: first),
        const SizedBox(width: Space.md),
        Expanded(child: second),
      ],
    );
  }
}

/// A white card with a small heading row (icon and words), as the mock-ups draw "My day",
/// "Last calls", "What to do".
class StationCard extends StatelessWidget {
  const StationCard({super.key, this.icon, this.title, required this.child, this.color, this.borderColor});

  final IconData? icon;
  final String? title;
  final Widget child;
  final Color? color;
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: color ?? t.bgSecondary,
        borderRadius: BorderRadius.circular(Radii.lg),
        border: Border.all(color: borderColor ?? t.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(Space.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (title != null) ...[
              Semantics(
                header: true,
                child: Row(
                  children: [
                    if (icon != null) ...[Icon(icon, size: 20, color: t.textSecondary), const SizedBox(width: Space.sm)],
                    Expanded(child: Text(title!, style: text.titleSmall!.copyWith(color: t.textSecondary))),
                  ],
                ),
              ),
              const SizedBox(height: Space.sm),
            ],
            child,
          ],
        ),
      ),
    );
  }
}

/// A number tile ("Calls today 42 / 120", "Amount due ₹12,500"): a small label over a big value.
class NumberTile extends StatelessWidget {
  const NumberTile({super.key, required this.label, required this.value, this.suffix, this.color});

  final String label;
  final String value;

  /// After the value, smaller ("/ 120").
  final String? suffix;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return MergeSemantics(
      child: DecoratedBox(
        decoration: BoxDecoration(color: color ?? t.bgPrimary, borderRadius: BorderRadius.circular(Radii.md)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: Space.sm),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(label, style: text.bodySmall, maxLines: 2),
              const SizedBox(height: 2),
              Text.rich(
                TextSpan(
                  text: value,
                  style: text.headlineSmall!.copyWith(fontWeight: FontWeight.w800, fontFeatures: const [FontFeature.tabularFigures()]),
                  children: [
                    if (suffix != null) TextSpan(text: ' $suffix', style: text.bodySmall),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Up to three tiles in a row; one under the other once large text would crush them.
class TileRow extends StatelessWidget {
  const TileRow({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(16) / 16;
    if (scale > 1.4) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (i, c) in children.indexed) ...[if (i > 0) const SizedBox(height: Space.sm), c],
        ],
      );
    }
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, c) in children.indexed) ...[if (i > 0) const SizedBox(width: Space.sm), Expanded(child: c)],
        ],
      ),
    );
  }
}

/// Numbered steps ("What to do"): 1, 2, 3, each a short sentence.
class StepsCard extends StatelessWidget {
  const StepsCard({super.key, required this.title, required this.steps, this.tone});

  final String title;
  final List<String> steps;
  final StationTone? tone;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final c = tone == null ? null : context.stateTokens.of(tone!);
    return StationCard(
      icon: Icons.checklist,
      title: title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, step) in steps.indexed)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: Space.xs),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  DecoratedBox(
                    decoration: BoxDecoration(color: c?.soft ?? t.bgTertiary, shape: BoxShape.circle),
                    child: SizedBox.square(
                      dimension: 28,
                      child: Center(child: Text('${i + 1}', style: text.titleSmall!.copyWith(color: c?.deep))),
                    ),
                  ),
                  const SizedBox(width: Space.md),
                  Expanded(child: Padding(padding: const EdgeInsets.only(top: 4), child: Text(step, style: text.bodyLarge))),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
