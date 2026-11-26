import 'dart:async';

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
/// lot. Open, the list is at most a third of the screen tall and scrolls inside, so a call under it
/// stays on screen; it closes again on "Show less", or by itself once one message is left. Testers
/// did not find the next message behind Dismiss alone (LF36's addendum of 2026-11-26).
///
/// Each message is announced to a screen reader once, as it arrives (politely, after what is being
/// read), sender and text together. The banner is not a live region: one would say a message twice
/// as it arrives, and again whenever the banner changes (a second message queued, a dismissal,
/// opening the list), where nothing new arrived. Nothing here takes focus.
class SupervisorMessageBanner extends ConsumerStatefulWidget {
  const SupervisorMessageBanner({super.key});

  @override
  ConsumerState<SupervisorMessageBanner> createState() => _SupervisorMessageBannerState();
}

class _SupervisorMessageBannerState extends ConsumerState<SupervisorMessageBanner> {
  /// The ids already announced, so a dismissal (the next one moving up) says nothing again.
  final Set<String> _announced = {};

  /// Every queued message shown, not only the first; read only with more than one queued.
  bool _expanded = false;

  /// The open list's own controller: the shell's tabs hold the primary one.
  final ScrollController _list = ScrollController();

  @override
  void initState() {
    super.initState();
    // Manual, and fired at once: a message already queued when the shell mounts is said too.
    ref.listenManual(supervisorMessagesProvider, _onMessages, fireImmediately: true);
  }

  @override
  void dispose() {
    _list.dispose();
    super.dispose();
  }

  void _onMessages(List<SupervisorMessageView>? prev, List<SupervisorMessageView> next) {
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
  }

  void _setExpanded(bool v) => setState(() => _expanded = v);

  void _dismissAll(List<SupervisorMessageView> messages) {
    final dismiss = ref.read(dismissSupervisorMessageProvider);
    for (final m in [...messages]) {
      dismiss(m.id);
    }
  }

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
        child: _expanded && messages.length > 1 ? _all(context, messages) : _first(context, messages),
      ),
    );
  }

  Widget _icon(AppTokens t) => Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Icon(Icons.chat_bubble_outline, color: t.info, size: 20),
      );

  Widget _dismissButton(AppTokens t, String id, Key key) => IconButton(
        key: key,
        tooltip: StationCopy.dismissMessageLabel,
        icon: Icon(Icons.close, color: t.textSecondary),
        onPressed: () => ref.read(dismissSupervisorMessageProvider)(id),
      );

  /// A text button in the banner's colour, 48 dp tall, its words lined up with the text above.
  ButtonStyle _linkStyle(AppTokens t) => TextButton.styleFrom(
        foregroundColor: t.info,
        minimumSize: const Size(Space.touch, Space.touch),
        padding: EdgeInsets.zero,
        tapTargetSize: MaterialTapTargetSize.padded,
      );

  /// One message: who sent it and when, then its text. Plain text, as sent: never markup, never a
  /// link. [scrollAfter] bounds the text, which then scrolls inside.
  Widget _message(BuildContext context, SupervisorMessageView m, {double? scrollAfter, Key? fromKey, Key? textKey}) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final body = Text(m.text, key: textKey, style: text.bodyMedium!.copyWith(color: t.textPrimary));
    return Semantics(
      container: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(StationCopy.messageFrom(m.from, formatTime(m.sentAt)), key: fromKey, style: text.labelMedium!.copyWith(color: t.info)),
          const SizedBox(height: 2),
          if (scrollAfter == null)
            body
          else
            ConstrainedBox(constraints: BoxConstraints(maxHeight: scrollAfter), child: SingleChildScrollView(child: body)),
        ],
      ),
    );
  }

  /// The first message, and a button opening the list when more wait behind it.
  Widget _first(BuildContext context, List<SupervisorMessageView> messages) {
    final m = messages.first;
    final more = messages.length - 1;
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.xs, Space.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _icon(t),
          const SizedBox(width: Space.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // A long one scrolls inside the banner rather than pushing the call off the screen.
                _message(
                  context,
                  m,
                  scrollAfter: MediaQuery.sizeOf(context).height * 0.25,
                  fromKey: const Key('supervisor-message-from'),
                  textKey: const Key('supervisor-message-text'),
                ),
                if (more > 0)
                  TextButton.icon(
                    key: const Key('supervisor-message-more'),
                    onPressed: () => _setExpanded(true),
                    style: _linkStyle(t),
                    iconAlignment: IconAlignment.end,
                    icon: const Icon(Icons.expand_more, size: 20),
                    label: Text(StationCopy.showMoreMessages(more)),
                  ),
              ],
            ),
          ),
          _dismissButton(t, m.id, const Key('dismiss-supervisor-message')),
        ],
      ),
    );
  }

  /// Every queued message, oldest first, each with its own Dismiss; Show less and Dismiss all above.
  Widget _all(BuildContext context, List<SupervisorMessageView> messages) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, Space.xs, Space.xs, Space.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              _icon(t),
              const SizedBox(width: Space.md),
              Expanded(
                child: Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: Space.lg,
                  children: [
                    Text(StationCopy.messagesCount(messages.length), style: text.labelMedium!.copyWith(color: t.info)),
                    TextButton.icon(
                      key: const Key('supervisor-message-fewer'),
                      onPressed: () => _setExpanded(false),
                      style: _linkStyle(t),
                      iconAlignment: IconAlignment.end,
                      icon: const Icon(Icons.expand_less, size: 20),
                      label: const Text(StationCopy.showFewerMessages),
                    ),
                    Semantics(
                      label: StationCopy.dismissAllMessagesLabel,
                      button: true,
                      excludeSemantics: true,
                      onTap: () => _dismissAll(messages),
                      child: TextButton(
                        key: const Key('dismiss-all-supervisor-messages'),
                        onPressed: () => _dismissAll(messages),
                        style: _linkStyle(t),
                        child: const Text(StationCopy.dismissAllMessages),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          // At most a third of the screen tall, scrolling inside: a call under it stays on screen.
          ConstrainedBox(
            key: const Key('supervisor-message-list'),
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height / 3),
            child: Scrollbar(
              controller: _list,
              thumbVisibility: true,
              child: SingleChildScrollView(
                controller: _list,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final (i, m) in messages.indexed) ...[
                      if (i > 0) Divider(height: 1, indent: 32, color: t.info.withValues(alpha: 0.3)),
                      Row(
                        key: ValueKey('supervisor-message-item-${m.id}'),
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const SizedBox(width: 32),
                          Expanded(
                            child: Padding(padding: const EdgeInsets.symmetric(vertical: Space.sm), child: _message(context, m)),
                          ),
                          _dismissButton(t, m.id, ValueKey('dismiss-supervisor-message-${m.id}')),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
