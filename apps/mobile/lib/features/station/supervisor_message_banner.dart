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
/// who sent it and when. Messages queue, oldest first: the banner shows one and says how many more
/// are waiting; Dismiss shows the next. Each message is announced to a screen reader once, as it
/// arrives (politely, after what is being read), sender and text together. The banner is not a live
/// region: one would say a message twice as it arrives, and again whenever the banner changes (a
/// second message queued, a dismissal), where nothing new arrived.
class SupervisorMessageBanner extends ConsumerStatefulWidget {
  const SupervisorMessageBanner({super.key});

  @override
  ConsumerState<SupervisorMessageBanner> createState() => _SupervisorMessageBannerState();
}

class _SupervisorMessageBannerState extends ConsumerState<SupervisorMessageBanner> {
  /// The ids already announced, so a dismissal (the next one moving up) says nothing again.
  final Set<String> _announced = {};

  @override
  void initState() {
    super.initState();
    // Manual, and fired at once: a message already queued when the shell mounts is said too.
    ref.listenManual(supervisorMessagesProvider, _announceNew, fireImmediately: true);
  }

  void _announceNew(List<SupervisorMessageView>? prev, List<SupervisorMessageView> next) {
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

  @override
  Widget build(BuildContext context) {
    final messages = ref.watch(supervisorMessagesProvider);
    if (messages.isEmpty) return const SizedBox.shrink();
    final m = messages.first;
    final more = messages.length - 1;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Material(
      key: const Key('supervisor-message'),
      color: t.infoSubtle,
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.info.withValues(alpha: 0.4)))),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.xs, Space.sm),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(Icons.chat_bubble_outline, color: t.info, size: 20),
              ),
              const SizedBox(width: Space.md),
              Expanded(
                child: Semantics(
                  container: true,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        StationCopy.messageFrom(m.from, formatTime(m.sentAt)),
                        key: const Key('supervisor-message-from'),
                        style: text.labelMedium!.copyWith(color: t.info),
                      ),
                      const SizedBox(height: 2),
                      // Plain text, as sent: never markup, never a link. Long ones scroll inside the
                      // banner rather than pushing the call off the screen.
                      ConstrainedBox(
                        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.25),
                        child: SingleChildScrollView(
                          child: Text(m.text, key: const Key('supervisor-message-text'), style: text.bodyMedium!.copyWith(color: t.textPrimary)),
                        ),
                      ),
                      if (more > 0) ...[
                        const SizedBox(height: 2),
                        Text(
                          StationCopy.moreMessages(more),
                          key: const Key('supervisor-message-more'),
                          style: text.bodySmall!.copyWith(color: t.textSecondary),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              IconButton(
                key: const Key('dismiss-supervisor-message'),
                tooltip: StationCopy.dismissMessageLabel,
                icon: Icon(Icons.close, color: t.textSecondary),
                onPressed: () => ref.read(dismissSupervisorMessageProvider)(m.id),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
