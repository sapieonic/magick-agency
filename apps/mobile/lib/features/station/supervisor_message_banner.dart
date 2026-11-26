import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderAbstractViewport;
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/station/station_view.dart';
import '../../ui/keyboard.dart';
import 'logic/format.dart';
import 'station_copy.dart';

/// A supervisor's message to the agent (floor assist, LF5; the app's LF36): shown by the shell at
/// the top of every tab, over a call too, never as a dialog: nothing waits on it. Plain text, with
/// who sent it and when. Messages queue, oldest first: the banner shows one, with its own Dismiss,
/// and a "Show 2 more messages" button under it. That button opens the banner to every queued
/// message, oldest first, each with its sender, time, text and Dismiss, and "Dismiss all" for the
/// lot; the same button then reads "Show less". The list closes again on "Show less", by itself
/// once one message is left, and when a call arrives ([callArrivalProvider]: a call coming or
/// offered, or connecting), which dismisses nothing. A message arriving while it is open scrolls
/// the list to it, unless the agent's finger is on the list. Messages stay one-way: there is no
/// reply (LF36, decided 2026-11-26).
///
/// Dismiss all can be undone: the messages leave the banner at once, "3 messages dismissed" and
/// Undo take their place for [undoWindow] ([undoWindowScreenReader] with a screen reader on), and
/// only then are they dismissed through the seam, each by id. Undo brings them back in their
/// place, oldest first, the list open as it was, saying nothing again (they never left the queue).
/// A message arriving in the window shows, with Undo under it while there is room; a second
/// Dismiss all, or the banner going while they are still queued (the shell leaving), dismisses the
/// first at once. The station closing sends nothing: its queue empties first, and with it the
/// pending ids.
///
/// Room: the banner takes at most a third of the room it is given (the shell gives it the space
/// between the status bar and the keyboard or tab bar), never less than one message beside its
/// Dismiss ([least]), and its text and list scroll inside, so the screen under it stays usable.
/// While the on-screen keyboard is up it takes only that one row, on any phone: the tab under it is
/// being typed in, and on a small phone a third of the room would leave the note no line of its
/// own. With more than one message and no room for the list, it says how to get the room: with the
/// keyboard up and room for the list once it is down, a "See all 3" button that hides the keyboard
/// and opens the list (narrower at large text: "All 3", then its icon alone); on a phone on its
/// side (a third cannot hold the open list, [listRoom], even with the keyboard down), "Turn your
/// phone upright to see all 3 messages" after the time; else, "· 2 more messages". The list opens
/// again once there is room, if it was open; See all with no room once the keyboard is down opens
/// nothing later.
///
/// Each message is said to a screen reader once, as it arrives (politely, after what is being
/// read), sender and text together, and so is Dismiss all's line. Where the platform takes
/// announcements (iOS) they are sent as such and the banner has no live region: one around the
/// banner would say a message twice as it arrives, and again whenever the banner changes (a second
/// message queued, a dismissal, opening the list), where nothing new arrived. Android takes none
/// (its embedding always reports [MediaQuery.supportsAnnounceOf] false), so there the banner says
/// them through a one-pixel live region of its own, out of sight, whose words are only ever what
/// is to be said: a new node for each arrival and each Dismiss all, its words unchanged by a
/// dismissal, opening the list or Undo, so TalkBack reads each once. Nothing here takes focus on
/// its own: only when one
/// of its controls had focus and went (its message dismissed, the list closed by itself or by a
/// call, Dismiss all, Undo) does focus move, to the next message's Dismiss, else the one before,
/// else the button, else the first Dismiss, else Undo. The button that opens and closes the list is
/// one widget both ways, so it keeps focus, and says whether it is open.
class SupervisorMessageBanner extends ConsumerStatefulWidget {
  const SupervisorMessageBanner({super.key});

  /// The least the banner takes when it has the room: one message's row beside its 48 dp Dismiss.
  static const double least = Space.touch + 2 * Space.sm;

  /// The room the open list needs: the count, one message with its Dismiss, and "Show less".
  static const double listRoom = 144;

  /// Undo's line under a message that arrived after Dismiss all: its 48 dp Undo and the gap under it.
  static const double undoLine = Space.touch + Space.sm;

  /// What a message's row takes besides the message and "See all": its padding, the icon, the gap
  /// and the 48 dp Dismiss. See all takes at most half of the rest, so the message keeps as much.
  static const double rowChrome = Space.lg + 20 + Space.md + Space.xs + Space.touch;

  /// What the shell's tab bar may take from the room once the keyboard is down (Material's own
  /// height for it, more than the app's): the room "See all" counts on is never more than it gets.
  static const double tabBarAllowance = 80;

  /// How long Dismiss all can be undone.
  static const undoWindow = Duration(seconds: 6);

  /// The same with a screen reader on: the line is read, then Undo is found.
  static const undoWindowScreenReader = Duration(seconds: 12);

  @override
  ConsumerState<SupervisorMessageBanner> createState() => _SupervisorMessageBannerState();
}

/// Dismiss all, not yet sent: [ids] in the queue's order, the seam's [dismiss] as it was then,
/// the [timer] that sends it, and whether the list was open (Undo opens it again, unless a call
/// arrived since).
final class _Dismissal {
  _Dismissal(this.ids, this.dismiss, this.timer, {required this.wasOpen});

  final List<String> ids;
  final void Function(String id) dismiss;
  final Timer timer;
  bool wasOpen;
}

class _SupervisorMessageBannerState extends ConsumerState<SupervisorMessageBanner> {
  /// The ids already announced, so a dismissal (the next one moving up) says nothing again.
  final Set<String> _announced = {};

  /// Every queued message shown, not only the first; read only with more than one queued and room
  /// for the list, and kept while there is no room, so the list opens again once there is.
  bool _expanded = false;

  /// Whether the list was open in the last frame built.
  bool _shownOpen = false;

  /// The open list's own controller, for its always-visible scrollbar (without one, the scrollbar
  /// would look for the PrimaryScrollController, which is not this list's) and to bring a new
  /// message into view.
  final ScrollController _list = ScrollController();

  /// The agent's finger is on the list (a drag): a new message does not move it then.
  bool _dragging = false;

  /// Each message's row in the open list, by id, to find it on screen.
  final Map<String, GlobalKey> _itemKeys = {};

  /// Dismiss all, while it can still be undone.
  _Dismissal? _pending;

  /// Focus for the button that opens and closes the list, for "Dismiss all", for each queued
  /// message's Dismiss, by id, for "See all" and for Undo: owned here so focus can be moved
  /// deliberately when a control goes.
  final FocusNode _toggleFocus = FocusNode(debugLabel: 'Show more or fewer messages');
  final FocusNode _allFocus = FocusNode(debugLabel: 'Dismiss all messages');
  final FocusNode _seeAllFocus = FocusNode(debugLabel: 'Hide the keyboard to see all messages');
  final FocusNode _undoFocus = FocusNode(debugLabel: 'Undo dismiss all');
  final Map<String, FocusNode> _dismissFocus = {};

  /// "See all" had focus when pressed: once the keyboard is down, focus goes to the list's button.
  bool _focusOnRoom = false;

  /// "See all" was pressed: once the keyboard is down the list opens, or, with no room for it even
  /// then, the wish is let go, so the list never opens later unasked.
  bool _seeAllAsked = false;

  /// What the live region says where the platform takes no announcements (Android): the newest
  /// arrival, or Dismiss all's line. [_sayKey] is new for each, so each is a new node, said once;
  /// nothing else changes either.
  String _say = '';
  int _sayKey = 0;

  @override
  void initState() {
    super.initState();
    // Manual, and fired at once: a message already queued when the shell mounts is said too. (A
    // banner mounted afresh while an old one's Dismiss all is still on its way to the seam would
    // say those once more; the shell keeps one banner while the queue is not empty.)
    ref.listenManual(supervisorMessagesProvider, _onMessages, fireImmediately: true);
    ref.listenManual<String?>(callArrivalProvider, _onCallArrival);
  }

  @override
  void dispose() {
    // The banner going while a Dismiss all is pending and its ids still queued (the shell leaving)
    // sends it: the agent asked for it. The station closing sends nothing: its queue empties first
    // and [_onMessages] lets the pending ids go. After this frame, so no provider changes while the
    // tree is torn down.
    final p = _pending;
    if (p != null) {
      p.timer.cancel();
      scheduleMicrotask(() {
        for (final id in p.ids) {
          p.dismiss(id);
        }
      });
    }
    _list.dispose();
    _toggleFocus.dispose();
    _allFocus.dispose();
    _seeAllFocus.dispose();
    _undoFocus.dispose();
    for (final n in _dismissFocus.values) {
      n.dispose();
    }
    super.dispose();
  }

  /// The messages the banner shows: the queue less a Dismiss all still pending.
  List<SupervisorMessageView> _visible(List<SupervisorMessageView> queued) {
    final p = _pending;
    return p == null ? queued : [for (final m in queued) if (!p.ids.contains(m.id)) m];
  }

  void _onMessages(List<SupervisorMessageView>? prev, List<SupervisorMessageView> next) {
    // Read before the banner repaints: which of its controls has focus, if any.
    final held = _held();
    final before = _visible(prev ?? const []);
    // A pending Dismiss all keeps only what is still queued (the 20 held, a message dismissed
    // elsewhere); nothing left, nothing to undo.
    final p = _pending;
    if (p != null) {
      p.ids.removeWhere((id) => !next.any((m) => m.id == id));
      if (p.ids.isEmpty) {
        p.timer.cancel();
        _pending = null;
      }
    }
    final shown = _visible(next);
    // One (or none) left: the list closes, and the next burst starts with one shown. The watch in
    // build repaints; this only resets what it reads.
    if (shown.length <= 1) _expanded = false;
    final fresh = [for (final m in next) if (_announced.add(m.id)) m];
    if (fresh.isNotEmpty) {
      // For the live region (read in build, which the watch repaints): the new ones, together.
      _say = [for (final m in fresh) StationCopy.messageAnnouncement(m.from, m.text)].join('\n');
      _sayKey++;
      // After the frame: the first call comes from initState, where the context cannot be read.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !MediaQuery.supportsAnnounceOf(context)) return;
        for (final m in fresh) {
          unawaited(
            SemanticsService.sendAnnouncement(
              View.of(context),
              StationCopy.messageAnnouncement(m.from, m.text),
              Directionality.of(context),
            ),
          );
        }
      });
      // Arriving while the list is open: the list scrolls to the newest.
      if (_shownOpen) _revealAfterFrame(fresh.last.id);
    }
    // Forget what is no longer queued, so the set stays as small as the queue.
    _announced.retainWhere((id) => next.any((m) => m.id == id));
    _afterRepaint(held, before, shown);
  }

  /// A call arriving closes the open list (it dismisses nothing), so the call has the screen.
  void _onCallArrival(String? prev, String? next) {
    if (next == null || next == prev) return;
    _focusOnRoom = false;
    _seeAllAsked = false;
    // Undo after a call arrived puts the messages back with the list shut: the call has the screen.
    _pending?.wasOpen = false;
    if (!_expanded) return;
    final shown = _visible(ref.read(supervisorMessagesProvider));
    // Focus in the list stays in the banner: on the first message's Dismiss if it was there (the
    // same control, still shown), else on the button that opens the list again. Closing is not a
    // dismissal, so it never lands on another message's Dismiss.
    final held = switch (_held()) {
      null => null,
      final h when h.$1 == _toggleFocus || (h.$2 != null && h.$2 == shown.firstOrNull?.id) => h,
      _ => (_toggleFocus, null),
    };
    setState(() => _expanded = false);
    _afterRepaint(held, shown, shown);
  }

  void _setExpanded(bool v, List<SupervisorMessageView> shown) {
    final held = _held();
    setState(() => _expanded = v);
    _afterRepaint(held, shown, shown);
  }

  /// "See all", with the keyboard up: hides the keyboard (the field being typed in lets go of
  /// focus, which closes it) and opens the list, which shows once the keyboard is down.
  void _seeAll() {
    final own = _seeAllFocus.hasPrimaryFocus;
    if (!own) FocusManager.instance.primaryFocus?.unfocus();
    unawaited(SystemChannels.textInput.invokeMethod<void>('TextInput.hide'));
    setState(() {
      _expanded = true;
      _seeAllAsked = true;
      _focusOnRoom = own;
    });
  }

  /// Dismiss all: the messages leave the banner now, and are dismissed through the seam once
  /// Undo's window ends. An earlier one still pending is sent first: this one replaces it.
  void _dismissAll(List<SupervisorMessageView> shown) {
    final held = _held();
    _sendPending();
    final ids = [for (final m in shown) m.id];
    final window = MediaQuery.accessibleNavigationOf(context)
        ? SupervisorMessageBanner.undoWindowScreenReader
        : SupervisorMessageBanner.undoWindow;
    setState(() {
      _pending = _Dismissal(ids, ref.read(dismissSupervisorMessageProvider), Timer(window, _sendPending), wasOpen: _expanded);
      _expanded = false;
      _say = StationCopy.messagesDismissedAnnouncement(ids.length);
      _sayKey++;
    });
    if (MediaQuery.supportsAnnounceOf(context)) {
      unawaited(
        SemanticsService.sendAnnouncement(
          View.of(context),
          StationCopy.messagesDismissedAnnouncement(ids.length),
          Directionality.of(context),
        ),
      );
    }
    _afterRepaint(held, shown, const []);
  }

  /// Sends the pending Dismiss all, each id through the seam.
  void _sendPending() {
    final p = _pending;
    if (p == null) return;
    p.timer.cancel();
    _pending = null;
    for (final id in p.ids) {
      p.dismiss(id);
    }
    if (mounted) setState(() {});
  }

  /// Undo: the messages come back where they were (they never left the queue), the list open if it
  /// was, said again to no one.
  void _undo() {
    final p = _pending;
    if (p == null) return;
    final held = _held();
    final queued = ref.read(supervisorMessagesProvider);
    final before = _visible(queued);
    p.timer.cancel();
    setState(() {
      _pending = null;
      _expanded = p.wasOpen && queued.length > 1;
    });
    _afterRepaint(held, before, queued);
  }

  // ── The open list's scroll ──

  bool _onListScroll(ScrollNotification n) {
    if (n.depth != 0) return false;
    if (n is ScrollStartNotification) {
      _dragging = n.dragDetails != null;
    } else if (n is ScrollEndNotification) {
      _dragging = false;
    }
    return false;
  }

  /// Once the list has repainted: scrolls it the least that shows message [id] (its top, when it
  /// is taller than the list), unless the agent is dragging it. No focus moves.
  void _revealAfterFrame(String id) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_shownOpen || _dragging || !_list.hasClients) return;
      final box = _itemKeys[id]?.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.attached) return;
      final viewport = RenderAbstractViewport.maybeOf(box);
      if (viewport == null) return;
      final p = _list.position;
      final top = viewport.getOffsetToReveal(box, 0).offset;
      final bottom = viewport.getOffsetToReveal(box, 1).offset;
      final now = p.pixels;
      final double? to = now > top ? top : (now < bottom ? math.min(top, bottom) : null);
      if (to == null) return;
      final target = to.clamp(p.minScrollExtent, p.maxScrollExtent);
      if ((target - now).abs() < 0.5) return;
      if (MediaQuery.disableAnimationsOf(context)) {
        _list.jumpTo(target);
      } else {
        unawaited(_list.animateTo(target, duration: const Duration(milliseconds: 250), curve: Curves.easeOutCubic));
      }
    });
  }

  // ── Focus ──

  FocusNode _dismissNode(String id) => _dismissFocus.putIfAbsent(id, () => FocusNode(debugLabel: 'Dismiss message $id'));

  /// The control with focus now, and the id of its message (none for the other buttons).
  (FocusNode, String?)? _held() {
    for (final n in [_toggleFocus, _allFocus, _seeAllFocus, _undoFocus]) {
      if (n.hasPrimaryFocus) return (n, null);
    }
    for (final MapEntry(key: id, value: node) in _dismissFocus.entries) {
      if (node.hasPrimaryFocus) return (node, id);
    }
    return null;
  }

  static bool _onScreen(FocusNode n) => n.parent != null && (n.context?.mounted ?? false);

  /// Once the banner has repainted: if one of its controls had focus, focus stays in the banner
  /// (on that control if it is still there, else the next message's Dismiss, else the one before,
  /// else the button, else the first Dismiss, else Undo). Nothing had focus: nothing takes it. Then
  /// what belonged to messages no longer queued is let go.
  void _afterRepaint((FocusNode, String?)? held, List<SupervisorMessageView> before, List<SupervisorMessageView> after) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (held != null) {
        final (node, id) = held;
        FocusNode? to = _onScreen(node) ? node : null;
        if (to == null && id != null) {
          final i = before.indexWhere((m) => m.id == id);
          final near = [...before.skip(i + 1), ...before.take(math.max(i, 0)).toList().reversed];
          to = near.map((m) => _dismissFocus[m.id]).whereType<FocusNode>().where(_onScreen).firstOrNull;
        }
        to ??= [_toggleFocus, for (final m in after) ?_dismissFocus[m.id], _undoFocus].where(_onScreen).firstOrNull;
        if (to != null && !to.hasPrimaryFocus) to.requestFocus();
      }
      final queued = ref.read(supervisorMessagesProvider);
      _dismissFocus.removeWhere((id, n) {
        if (queued.any((m) => m.id == id) || _onScreen(n)) return false;
        n.dispose();
        return true;
      });
      _itemKeys.removeWhere((id, _) => !queued.any((m) => m.id == id));
    });
  }

  /// "See all" had focus and the keyboard is down: focus to the list's button, else the Dismiss.
  void _focusAfterRoom(SupervisorMessageView first) {
    _focusOnRoom = false;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final to = [_toggleFocus, ?_dismissFocus[first.id]].where(_onScreen).firstOrNull;
      if (to != null && !to.hasPrimaryFocus) to.requestFocus();
    });
  }

  // ── Build ──

  @override
  Widget build(BuildContext context) {
    final messages = ref.watch(supervisorMessagesProvider);
    if (messages.isEmpty) return const SizedBox.shrink();
    final shown = _visible(messages);
    final t = context.tokens;
    final banner = Material(
      key: const Key('supervisor-message'),
      color: t.infoSubtle,
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.info.withValues(alpha: 0.4)))),
        child: KeyboardOpenBuilder(
          builder: (context, typing) => LayoutBuilder(
            builder: (context, box) {
              // The room it is given (the shell gives the space between the status bar and the
              // keyboard or tab bar); placed with no bound, the window's height. While the keyboard
              // is up the tab under it is being typed in: one row, whatever the room.
              final room = box.maxHeight.isFinite ? box.maxHeight : MediaQuery.sizeOf(context).height;
              double third(double room) => math.max(room / 3, SupervisorMessageBanner.least);
              final most = math.min(room, typing ? SupervisorMessageBanner.least : third(room));
              final pending = _pending;
              if (shown.isEmpty) {
                // Every message dismissed, Undo's window open: its line holds the banner's place.
                _shownOpen = false;
                return ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: most),
                  child: _undoLine(context, pending?.ids.length ?? 0, under: false),
                );
              }
              // A message arrived in Undo's window: Undo under it, while both have room.
              bool undoUnderIn(double most) => pending != null && most >= SupervisorMessageBanner.least + SupervisorMessageBanner.undoLine;
              bool listFitsIn(double most) =>
                  shown.length > 1 && (undoUnderIn(most) ? most - SupervisorMessageBanner.undoLine : most) >= SupervisorMessageBanner.listRoom;
              final undoUnder = pending != null && undoUnderIn(most);
              final listFits = listFitsIn(most);
              // The room once the keyboard is down: the keyboard's height back, less what the tab
              // bar may take (never more than the shell will give). With no bound given, the room
              // is the window's already.
              final view = View.of(context);
              final inset = math.max(MediaQuery.viewInsetsOf(context).bottom, view.viewInsets.bottom / view.devicePixelRatio);
              final bar = SupervisorMessageBanner.tabBarAllowance + view.viewPadding.bottom / view.devicePixelRatio;
              final roomDown = box.maxHeight.isFinite ? room + math.max(0.0, inset - bar) : room;
              final listFitsDown = listFitsIn(math.min(roomDown, third(roomDown)));
              // See all pressed, the keyboard down: the list opens if it fits; with no room for it
              // even now (turned on its side since), the wish goes, so nothing opens later unasked.
              if (!typing && _seeAllAsked && (listFits || !listFitsDown)) {
                _seeAllAsked = false;
                if (!listFits) _expanded = false;
                if (_focusOnRoom) _focusAfterRoom(shown.first);
              }
              final open = listFits && _expanded;
              _shownOpen = open;
              if (!open) _dragging = false;
              final noRoom = shown.length > 1 && !listFits
                  ? (typing && listFitsDown
                        ? _NoRoom.keyboard
                        : (MediaQuery.orientationOf(context) == Orientation.landscape ? _NoRoom.sideways : _NoRoom.short))
                  : null;
              final content = _content(context, shown, listFits: listFits, open: open, noRoom: noRoom, width: box.maxWidth);
              return ConstrainedBox(
                constraints: BoxConstraints(maxHeight: most),
                child: undoUnder
                    ? Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [Flexible(child: content), _undoLine(context, pending.ids.length, under: true)],
                      )
                    : content,
              );
            },
          ),
        ),
      ),
    );
    // Android: what is to be said, in a live region out of sight (see the class's notes). Always in
    // a Stack, so the banner keeps its place in the tree whether or not the region is there.
    final live = !MediaQuery.supportsAnnounceOf(context);
    return Stack(
      fit: StackFit.passthrough,
      children: [
        banner,
        if (live)
          Positioned(
            left: 0,
            top: 0,
            width: 1,
            height: 1,
            child: KeyedSubtree(
              key: ValueKey(_sayKey),
              child: Semantics(
                key: const Key('supervisor-message-live'),
                container: true,
                liveRegion: true,
                label: _say,
                child: const SizedBox.expand(),
              ),
            ),
          ),
      ],
    );
  }

  /// One message, or the open list, beside the icon; under it, when the list fits, the button that
  /// opens and closes it (and "Dismiss all" while open). The button keeps its place in the tree
  /// both ways, so it keeps focus. With no room for the list, [noRoom] says why, and what to do.
  Widget _content(
    BuildContext context,
    List<SupervisorMessageView> messages, {
    required bool listFits,
    required bool open,
    required _NoRoom? noRoom,
    required double width,
  }) {
    final t = context.tokens;
    final first = messages.first;
    return Padding(
      padding: EdgeInsetsDirectional.fromSTEB(Space.lg, Space.sm, Space.xs, listFits ? 0 : Space.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.only(top: 2),
            child: Icon(Icons.chat_bubble_outline, color: t.info, size: 20),
          ),
          const SizedBox(width: Space.md),
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Flexible(
                  child: open
                      ? _all(context, messages)
                      // A long one scrolls inside the banner rather than pushing the call off the screen.
                      : SingleChildScrollView(
                          child: _message(
                            context,
                            first,
                            after: switch (noRoom) {
                              _NoRoom.sideways => StationCopy.turnUprightToSeeAll(messages.length),
                              _NoRoom.short => StationCopy.moreMessages(messages.length - 1),
                              _NoRoom.keyboard || null => null,
                            },
                            fromKey: const Key('supervisor-message-from'),
                            textKey: const Key('supervisor-message-text'),
                          ),
                        ),
                ),
                if (listFits)
                  Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: Space.lg,
                    children: [
                      MergeSemantics(
                        child: Semantics(
                          expanded: open,
                          child: TextButton.icon(
                            key: const Key('supervisor-message-toggle'),
                            focusNode: _toggleFocus,
                            onPressed: () => _setExpanded(!open, messages),
                            style: _linkStyle(t),
                            iconAlignment: IconAlignment.end,
                            icon: Icon(open ? Icons.expand_less : Icons.expand_more, size: 20),
                            label: Text(open ? StationCopy.showFewerMessages : StationCopy.showMoreMessages(messages.length - 1)),
                          ),
                        ),
                      ),
                      if (open)
                        TextButton(
                          key: const Key('dismiss-all-supervisor-messages'),
                          focusNode: _allFocus,
                          onPressed: () => _dismissAll(messages),
                          style: _linkStyle(t),
                          child: const Text(StationCopy.dismissAllMessages, semanticsLabel: StationCopy.dismissAllMessagesLabel),
                        ),
                    ],
                  ),
              ],
            ),
          ),
          if (noRoom == _NoRoom.keyboard) _seeAllButton(context, t, messages.length, width: width),
          if (!open) _dismissButton(t, first, const Key('dismiss-supervisor-message')),
        ],
      ),
    );
  }

  /// With the keyboard up: "See all 3", 48 dp, beside the message's Dismiss in a row [width] wide.
  /// It takes at most half of what the row leaves ([SupervisorMessageBanner.rowChrome]), so the
  /// message keeps at least as much; where its words do not fit there whole (large text, a narrow
  /// phone), "All 3", then the icon alone. Its label is the whole sentence every way.
  Widget _seeAllButton(BuildContext context, AppTokens t, int n, {required double width}) {
    final most = math.max(Space.touch, (width - SupervisorMessageBanner.rowChrome) / 2);
    // The button's own text style, and what it adds to its words: its padding, the icon and the
    // gap between them (8 dp at most).
    final style = TextButtonTheme.of(context).style?.textStyle?.resolve(const {}) ?? Theme.of(context).textTheme.labelLarge;
    const around = 2 * Space.sm + 20 + 8;
    bool fits(String words) {
      final p = TextPainter(
        text: TextSpan(text: words, style: style),
        textDirection: Directionality.of(context),
        textScaler: MediaQuery.textScalerOf(context),
        maxLines: 1,
      )..layout();
      final w = p.width;
      p.dispose();
      return around + w <= most;
    }

    final words = [StationCopy.seeAllMessages(n), StationCopy.seeAllMessagesShort(n)].where(fits).firstOrNull;
    final label = StationCopy.seeAllMessagesLabel(n);
    final buttonStyle = _linkStyle(t).copyWith(padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: Space.sm)));
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: most),
      child: words == null
          ? TextButton(
              key: const Key('supervisor-message-see-all'),
              focusNode: _seeAllFocus,
              onPressed: _seeAll,
              style: buttonStyle,
              child: Icon(Icons.keyboard_hide_outlined, size: 20, semanticLabel: label),
            )
          : TextButton.icon(
              key: const Key('supervisor-message-see-all'),
              focusNode: _seeAllFocus,
              onPressed: _seeAll,
              style: buttonStyle,
              icon: const Icon(Icons.keyboard_hide_outlined, size: 20),
              label: Text(words, maxLines: 1, softWrap: false, overflow: TextOverflow.ellipsis, semanticsLabel: label),
            ),
    );
  }

  /// "3 messages dismissed" and Undo (48 dp): in the banner's place, or [under] a message that
  /// arrived since. Its words scroll inside at large text.
  Widget _undoLine(BuildContext context, int n, {required bool under}) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Padding(
      key: const Key('supervisor-message-undo-line'),
      padding: EdgeInsetsDirectional.fromSTEB(Space.lg, under ? 0 : Space.sm, Space.xs, Space.sm),
      child: Row(
        children: [
          if (under)
            const SizedBox(width: 20 + Space.md)
          else ...[
            Icon(Icons.chat_bubble_outline, color: t.info, size: 20),
            const SizedBox(width: Space.md),
          ],
          Expanded(
            child: SingleChildScrollView(
              child: Text(StationCopy.messagesDismissed(n), style: text.labelMedium!.copyWith(color: t.textSecondary)),
            ),
          ),
          TextButton(
            key: const Key('undo-dismiss-all-supervisor-messages'),
            focusNode: _undoFocus,
            onPressed: _undo,
            style: _linkStyle(t).copyWith(padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: Space.md))),
            child: Text(StationCopy.undoDismiss, semanticsLabel: StationCopy.undoDismissLabel(n)),
          ),
        ],
      ),
    );
  }

  Widget _dismissButton(AppTokens t, SupervisorMessageView m, Key key) => IconButton(
        key: key,
        focusNode: _dismissNode(m.id),
        tooltip: StationCopy.dismissMessageFrom(m.from),
        icon: Icon(Icons.close, color: t.textSecondary),
        onPressed: () => ref.read(dismissSupervisorMessageProvider)(m.id),
      );

  /// A text button in the banner's colour, 48 dp tall, its words lined up with the text above.
  ButtonStyle _linkStyle(AppTokens t) => TextButton.styleFrom(
        foregroundColor: t.info,
        minimumSize: const Size(Space.touch, Space.touch),
        padding: EdgeInsets.zero,
        tapTargetSize: MaterialTapTargetSize.padded,
      );

  /// One message: who sent it and when (and [after] it, why the list is not open), then its text.
  /// Plain text, as sent: never markup, never a link.
  Widget _message(BuildContext context, SupervisorMessageView m, {String? after, Key? fromKey, Key? textKey}) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final from = StationCopy.messageFrom(m.from, formatTime(m.sentAt));
    return Semantics(
      container: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            after != null ? '$from · $after' : from,
            key: fromKey,
            style: text.labelMedium!.copyWith(color: t.info),
          ),
          const SizedBox(height: 2),
          Text(m.text, key: textKey, style: text.bodyMedium!.copyWith(color: t.textPrimary)),
        ],
      ),
    );
  }

  /// Every queued message, oldest first, each with its own Dismiss, under how many there are; the
  /// list scrolls inside the room the banner has.
  Widget _all(BuildContext context, List<SupervisorMessageView> messages) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(StationCopy.messagesCount(messages.length), style: text.labelMedium!.copyWith(color: t.info)),
        Flexible(
          child: NotificationListener<ScrollNotification>(
            onNotification: _onListScroll,
            child: Scrollbar(
              key: const Key('supervisor-message-list'),
              controller: _list,
              thumbVisibility: true,
              child: SingleChildScrollView(
                controller: _list,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final (i, m) in messages.indexed) ...[
                      if (i > 0) Divider(height: 1, color: t.info.withValues(alpha: 0.3)),
                      KeyedSubtree(
                        key: _itemKeys.putIfAbsent(m.id, () => GlobalKey(debugLabel: 'Message ${m.id}')),
                        child: Row(
                          key: ValueKey('supervisor-message-item-${m.id}'),
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Padding(padding: const EdgeInsets.symmetric(vertical: Space.sm), child: _message(context, m)),
                            ),
                            _dismissButton(t, m, ValueKey('dismiss-supervisor-message-${m.id}')),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Why the open list has no room, with more than one message: the keyboard is up (and the list
/// would fit with it down), the phone is on its side, or the window is short for some other reason
/// (split screen).
enum _NoRoom { keyboard, sideways, short }
