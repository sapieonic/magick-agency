import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/station/station_view.dart';
import 'logic/format.dart';
import 'station_copy.dart';

/// A supervisor's message to the agent (floor assist, LF5; the app's LF36): shown by the shell at
/// the top of every tab, over a call too, never as a dialog: nothing waits on it. Plain text, with
/// who sent it and when. Messages queue, oldest first: the banner shows one, with its own Dismiss,
/// and a "Show 2 more messages" button under it. That button opens the banner to every queued
/// message, oldest first, each with its sender, time, text and Dismiss, and "Dismiss all" for the
/// lot; the same button then reads "Show less". The list closes again on "Show less", or by itself
/// once one message is left. Testers did not find the next message behind Dismiss alone (LF36's
/// addendum of 2026-11-26).
///
/// Room: the banner takes at most a third of the room it is given (the shell gives it the space
/// between the status bar and the keyboard or tab bar), never less than one message beside its
/// Dismiss, and its text and list scroll inside, so the screen under it stays usable. When a third
/// cannot hold the open list (the keyboard is up, or a phone on its side), it shows the first
/// message only, with "· 2 more messages" after its time, until there is room again; the list opens
/// again then if it was open.
///
/// Each message is announced to a screen reader once, as it arrives (politely, after what is being
/// read), sender and text together. The banner is not a live region: one would say a message twice
/// as it arrives, and again whenever the banner changes (a second message queued, a dismissal,
/// opening the list), where nothing new arrived. Nothing here takes focus on its own: only when one
/// of its controls had focus and went (its message dismissed, the list closed by itself) does focus
/// move, to the next message's Dismiss, else the one before, else the button. The button that opens
/// and closes the list is one widget both ways, so it keeps focus, and says whether it is open.
class SupervisorMessageBanner extends ConsumerStatefulWidget {
  const SupervisorMessageBanner({super.key});

  /// The least the banner takes when it has the room: one message's row beside its 48 dp Dismiss.
  static const double least = Space.touch + 2 * Space.sm;

  /// The room the open list needs: the count, one message with its Dismiss, and "Show less".
  static const double listRoom = 144;

  @override
  ConsumerState<SupervisorMessageBanner> createState() => _SupervisorMessageBannerState();
}

class _SupervisorMessageBannerState extends ConsumerState<SupervisorMessageBanner> {
  /// The ids already announced, so a dismissal (the next one moving up) says nothing again.
  final Set<String> _announced = {};

  /// Every queued message shown, not only the first; read only with more than one queued and room
  /// for the list, and kept while there is no room, so the list opens again once there is.
  bool _expanded = false;

  /// The open list's own controller, for its always-visible scrollbar: without one, the scrollbar
  /// would look for the PrimaryScrollController, which is not this list's.
  final ScrollController _list = ScrollController();

  /// Focus for the button that opens and closes the list, for "Dismiss all", and for each queued
  /// message's Dismiss, by id: owned here so focus can be moved deliberately when a control goes.
  final FocusNode _toggleFocus = FocusNode(debugLabel: 'Show more or fewer messages');
  final FocusNode _allFocus = FocusNode(debugLabel: 'Dismiss all messages');
  final Map<String, FocusNode> _dismissFocus = {};

  @override
  void initState() {
    super.initState();
    // Manual, and fired at once: a message already queued when the shell mounts is said too.
    ref.listenManual(supervisorMessagesProvider, _onMessages, fireImmediately: true);
  }

  @override
  void dispose() {
    _list.dispose();
    _toggleFocus.dispose();
    _allFocus.dispose();
    for (final n in _dismissFocus.values) {
      n.dispose();
    }
    super.dispose();
  }

  void _onMessages(List<SupervisorMessageView>? prev, List<SupervisorMessageView> next) {
    // Read before the banner repaints: which of its controls has focus, if any.
    final held = _held();
    // One (or none) left: the list closes, and the next burst starts with one shown. The watch in
    // build repaints; this only resets what it reads.
    if (next.length <= 1) _expanded = false;
    final fresh = [for (final m in next) if (_announced.add(m.id)) m];
    if (fresh.isNotEmpty) {
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
    }
    // Forget what is no longer queued, so the set stays as small as the queue.
    _announced.retainWhere((id) => next.any((m) => m.id == id));
    _afterRepaint(held, prev ?? const [], next);
  }

  void _setExpanded(bool v, List<SupervisorMessageView> messages) {
    final held = _held();
    setState(() => _expanded = v);
    _afterRepaint(held, messages, messages);
  }

  void _dismissAll(List<SupervisorMessageView> messages) {
    final dismiss = ref.read(dismissSupervisorMessageProvider);
    for (final m in [...messages]) {
      dismiss(m.id);
    }
  }

  // ── Focus ──

  FocusNode _dismissNode(String id) => _dismissFocus.putIfAbsent(id, () => FocusNode(debugLabel: 'Dismiss message $id'));

  /// The control with focus now, and the id of its message (none for the button and Dismiss all).
  (FocusNode, String?)? _held() {
    if (_toggleFocus.hasPrimaryFocus) return (_toggleFocus, null);
    if (_allFocus.hasPrimaryFocus) return (_allFocus, null);
    for (final MapEntry(key: id, value: node) in _dismissFocus.entries) {
      if (node.hasPrimaryFocus) return (node, id);
    }
    return null;
  }

  static bool _onScreen(FocusNode n) => n.parent != null && (n.context?.mounted ?? false);

  /// Once the banner has repainted: if one of its controls had focus, focus stays in the banner
  /// (on that control if it is still there, else the next message's Dismiss, else the one before,
  /// else the button, else the first Dismiss). Nothing had focus: nothing takes it. Then the focus
  /// of messages no longer queued is let go.
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
        to ??= [_toggleFocus, for (final m in after) ?_dismissFocus[m.id]].where(_onScreen).firstOrNull;
        if (to != null && !to.hasPrimaryFocus) to.requestFocus();
      }
      final queued = ref.read(supervisorMessagesProvider);
      _dismissFocus.removeWhere((id, n) {
        if (queued.any((m) => m.id == id) || _onScreen(n)) return false;
        n.dispose();
        return true;
      });
    });
  }

  // ── Build ──

  @override
  Widget build(BuildContext context) {
    final messages = ref.watch(supervisorMessagesProvider);
    if (messages.isEmpty) return const SizedBox.shrink();
    final t = context.tokens;
    return Material(
      key: const Key('supervisor-message'),
      color: t.infoSubtle,
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.info.withValues(alpha: 0.4)))),
        child: LayoutBuilder(
          builder: (context, box) {
            // The room it is given (the shell gives the space between the status bar and the
            // keyboard or tab bar); placed with no bound, the window's height.
            final room = box.maxHeight.isFinite ? box.maxHeight : MediaQuery.sizeOf(context).height;
            final most = math.min(room, math.max(room / 3, SupervisorMessageBanner.least));
            final listFits = messages.length > 1 && most >= SupervisorMessageBanner.listRoom;
            return ConstrainedBox(
              constraints: BoxConstraints(maxHeight: most),
              child: _content(context, messages, listFits: listFits, open: listFits && _expanded),
            );
          },
        ),
      ),
    );
  }

  /// One message, or the open list, beside the icon; under it, when the list fits, the button that
  /// opens and closes it (and "Dismiss all" while open). The button keeps its place in the tree
  /// both ways, so it keeps focus.
  Widget _content(BuildContext context, List<SupervisorMessageView> messages, {required bool listFits, required bool open}) {
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
                            more: listFits ? 0 : messages.length - 1,
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
          if (!open) _dismissButton(t, first, const Key('dismiss-supervisor-message')),
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

  /// One message: who sent it and when (and how many more wait, when the list has no room), then
  /// its text. Plain text, as sent: never markup, never a link.
  Widget _message(BuildContext context, SupervisorMessageView m, {int more = 0, Key? fromKey, Key? textKey}) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final from = StationCopy.messageFrom(m.from, formatTime(m.sentAt));
    return Semantics(
      container: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            more > 0 ? '$from · ${StationCopy.moreMessages(more)}' : from,
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
                    Row(
                      key: ValueKey('supervisor-message-item-${m.id}'),
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Padding(padding: const EdgeInsets.symmetric(vertical: Space.sm), child: _message(context, m)),
                        ),
                        _dismissButton(t, m, ValueKey('dismiss-supervisor-message-${m.id}')),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
