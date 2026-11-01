import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../ui/primitives.dart';
import '../../station/parts/banners.dart' show BusyLabel;
import '../softphone_copy.dart';

/// The Phone tab's screens when it is not drawing the soft phone itself: not
/// open yet, opening, live on a campaign, open in another account, turned off,
/// and failed. Each says what is true and offers the one thing that helps, so
/// none is a dead end.

/// A full-screen message: icon, title, body, then the actions pinned below
/// (at 200% text the words scroll, the actions never leave the screen).
class SessionCard extends StatelessWidget {
  const SessionCard({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    this.notes = const [],
    this.actions = const [],
    this.busy = false,
    this.iconColor,
  });

  final IconData icon;
  final Color? iconColor;
  final String title;
  final String body;

  /// Further paragraphs; a [Widget] for a styled one (an error, a refusal).
  final List<Widget> notes;
  final List<Widget> actions;

  /// A spinner instead of the icon (loading, opening).
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(Space.xl, Space.xxl, Space.xl, Space.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(color: t.bgTertiary, borderRadius: BorderRadius.circular(Radii.lg)),
                  child: SizedBox.square(
                    dimension: 64,
                    child: busy
                        ? Padding(
                            padding: const EdgeInsets.all(20),
                            child: CircularProgressIndicator(strokeWidth: 2.5, color: t.accentHover),
                          )
                        : Icon(icon, size: 30, color: iconColor ?? t.textSecondary),
                  ),
                ),
                const SizedBox(height: Space.xl),
                Semantics(header: true, child: Text(title, style: text.headlineMedium)),
                const SizedBox(height: Space.md),
                Text(body, style: text.bodyLarge!.copyWith(color: t.textSecondary)),
                for (final n in notes) ...[const SizedBox(height: Space.md), n],
              ],
            ),
          ),
        ),
        if (actions.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var i = 0; i < actions.length; i++) ...[if (i > 0) const SizedBox(height: Space.sm), actions[i]],
              ],
            ),
          ),
      ],
    );
  }
}

/// A paragraph in a state's colour (a refusal, a warning).
class CardNote extends StatelessWidget {
  const CardNote(this.text, {super.key, this.danger = false, this.live = false});

  final String text;
  final bool danger;

  /// Announce it when it appears (the answer to something the agent pressed).
  final bool live;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final style = Theme.of(context).textTheme.bodyMedium!.copyWith(color: danger ? t.danger : t.textPrimary);
    final note = AppCard(
      color: danger ? t.dangerSubtle : null,
      borderColor: danger ? t.danger.withValues(alpha: 0.4) : null,
      child: Text(text, style: style),
    );
    return live ? Semantics(liveRegion: true, container: true, child: note) : note;
  }
}

/// The last refused session action (Open, Close, Switch), with Dismiss.
class SessionErrorNote extends ConsumerWidget {
  const SessionErrorNote({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final error = ref.watch(softphoneViewProvider.select((v) => v.sessionError));
    if (error == null) return const SizedBox.shrink();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Semantics(
      liveRegion: true,
      container: true,
      child: AppCard(
        key: const Key('softphone-session-error'),
        color: t.dangerSubtle,
        borderColor: t.danger.withValues(alpha: 0.4),
        padding: const EdgeInsets.fromLTRB(Space.md, Space.xs, Space.xs, Space.xs),
        child: Row(
          children: [
            Icon(Icons.error_outline, color: t.danger, size: 20),
            const SizedBox(width: Space.sm),
            Expanded(
              child: Text(error, style: text.bodyMedium!.copyWith(color: t.danger)),
            ),
            IconButton(
              tooltip: SoftphoneCopy.dismiss,
              icon: Icon(Icons.close, color: t.danger),
              onPressed: () => ref.read(softphoneActionsProvider).dismissSessionError(),
            ),
          ],
        ),
      ),
    );
  }
}

class LoadingCard extends StatelessWidget {
  const LoadingCard({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: SessionCard(
      key: const Key('softphone-loading'),
      icon: Icons.phone_outlined,
      busy: true,
      title: SoftphoneCopy.title,
      body: message,
    ),
  );
}

/// Not open: "Open the soft phone". The tap asks for the microphone (and
/// notifications) first, so the permission prompt never lands mid-call.
class ClosedCard extends ConsumerWidget {
  const ClosedCard({
    super.key,
    required this.state,
    required this.onOpen,
    required this.onOpenSettings,
    this.permissionNote,
    this.askingPermission = false,
  });

  final SoftphoneScreenClosed state;
  final VoidCallback onOpen;
  final VoidCallback onOpenSettings;

  /// Why the last tap did not open (the microphone was refused), or null.
  final String? permissionNote;
  final bool askingPermission;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    if (state.microphoneBlocked) {
      return SessionCard(
        key: const Key('softphone-mic-blocked'),
        icon: Icons.mic_off,
        iconColor: t.danger,
        title: SoftphoneCopy.micBlockedTitle,
        body: SoftphoneCopy.micBlockedBody,
        notes: [if (state.notice case final notice?) CardNote(notice)],
        actions: [
          FilledButton(
            key: const Key('softphone-open-settings'),
            onPressed: onOpenSettings,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: const Text(SoftphoneCopy.openSettings),
          ),
        ],
      );
    }
    return SessionCard(
      key: const Key('softphone-closed'),
      icon: Icons.dialpad,
      title: SoftphoneCopy.closedTitle,
      body: SoftphoneCopy.closedBody,
      notes: [
        if (state.notice case final notice?) CardNote(notice),
        if (permissionNote case final note?) CardNote(note, danger: true, live: true),
        const SessionErrorNote(),
      ],
      actions: [
        FilledButton.icon(
          key: const Key('softphone-open'),
          onPressed: askingPermission ? null : onOpen,
          icon: const Icon(Icons.phone_outlined),
          label: BusyLabel(label: SoftphoneCopy.open, busy: askingPermission, color: t.onAccent),
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
        ),
        if (permissionNote != null)
          OutlinedButton(
            key: const Key('softphone-open-settings'),
            onPressed: onOpenSettings,
            child: const Text(SoftphoneCopy.openSettings),
          ),
      ],
    );
  }
}

/// `session_on_campaign`: the agent is live on a campaign. The answer is the
/// switch on that session (SP7), never a second session. In another account
/// the app names it and offers the account switch (where that account's
/// station can make the switch); it never switches across accounts in place.
class OnCampaignCard extends ConsumerWidget {
  const OnCampaignCard({super.key, required this.state});

  final SoftphoneScreenOnCampaign state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = state;
    final busy = ref.watch(softphoneViewProvider.select((v) => v.sessionBusy));
    final actions = ref.read(softphoneActionsProvider);
    final t = context.tokens;

    if (!s.sameAccount) {
      return SessionCard(
        key: const Key('softphone-on-campaign'),
        icon: Icons.headset_mic_outlined,
        title: SoftphoneCopy.onCampaignTitle(s.campaignName, account: s.accountName, sameAccount: false),
        body: SoftphoneCopy.onCampaignOtherAccount(s.campaignName, s.accountName),
        notes: const [SessionErrorNote()],
        actions: [
          if (s.canSwitchAccount)
            FilledButton(
              key: const Key('softphone-switch-account'),
              onPressed: busy != SoftphoneSessionBusy.none ? null : () => actions.requestAccountSwitch(s.accountId),
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
              child: Text(SoftphoneCopy.switchAccountTo(s.accountName)),
            ),
        ],
      );
    }

    final switching = busy == SoftphoneSessionBusy.switching;
    final midCall = s.switchQueued;
    return SessionCard(
      key: const Key('softphone-on-campaign'),
      icon: Icons.headset_mic_outlined,
      title: SoftphoneCopy.onCampaignTitle(s.campaignName, sameAccount: true),
      body: SoftphoneCopy.onCampaignDetail(s.campaignName, s.stateLabel, sameAccount: true),
      notes: [
        if (s.hostedHere) Text(midCall ? SoftphoneCopy.onCampaignSwitchQueued : SoftphoneCopy.onCampaignSwitchIdle),
        const SessionErrorNote(),
      ],
      actions: [
        if (s.hostedHere && s.switchQueued)
          FilledButton(
            key: const Key('softphone-switch'),
            onPressed: null,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: const Text(SoftphoneCopy.switchQueued),
          )
        else if (s.hostedHere)
          FilledButton(
            key: const Key('softphone-switch'),
            onPressed: busy != SoftphoneSessionBusy.none
                ? null
                : () async {
                    final router = GoRouter.maybeOf(context);
                    final ok = await actions.switchToSoftphone();
                    if (ok) router?.go(Routes.station(s.campaignId));
                  },
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: BusyLabel(
              label: switching ? SoftphoneCopy.switching : SoftphoneCopy.switchToSoftphone,
              busy: switching,
              color: t.onAccent,
            ),
          ),
        OutlinedButton(
          key: const Key('softphone-go-to-station'),
          onPressed: switching ? null : () => GoRouter.maybeOf(context)?.go(Routes.station(s.campaignId)),
          child: const Text(SoftphoneCopy.goToStation),
        ),
      ],
    );
  }
}

/// `session_on_softphone`: the agent's soft phone is open in another account.
/// Close it there and open here (refused while its call is unfinished), or go
/// to that account, which is the primary way while a call there is unfinished.
class ElsewhereCard extends ConsumerWidget {
  const ElsewhereCard({super.key, required this.state});

  final SoftphoneScreenElsewhere state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = state;
    final busy = ref.watch(softphoneViewProvider.select((v) => v.sessionBusy));
    final actions = ref.read(softphoneActionsProvider);
    final t = context.tokens;
    final closing = busy == SoftphoneSessionBusy.closing || busy == SoftphoneSessionBusy.opening;
    final goThere = s.canSwitchAccount
        ? (s.callPending
              ? FilledButton(
                  key: const Key('softphone-go-there'),
                  onPressed: closing ? null : () => actions.requestAccountSwitch(s.accountId),
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                  child: Text(SoftphoneCopy.useSoftphoneIn(s.accountName)),
                )
              : OutlinedButton(
                  key: const Key('softphone-go-there'),
                  onPressed: closing ? null : () => actions.requestAccountSwitch(s.accountId),
                  child: Text(SoftphoneCopy.useSoftphoneIn(s.accountName)),
                ))
        : null;
    return SessionCard(
      key: const Key('softphone-elsewhere'),
      icon: Icons.swap_horiz,
      title: SoftphoneCopy.elsewhereTitle,
      body: SoftphoneCopy.elsewhereDetail(s.accountName),
      notes: [if (s.callPending) CardNote(SoftphoneCopy.elsewhereCallPending(s.accountName), danger: true), const SessionErrorNote()],
      actions: [
        if (!s.callPending)
          FilledButton(
            key: const Key('softphone-elsewhere-close'),
            onPressed: closing ? null : actions.closeElsewhereAndOpen,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: BusyLabel(label: closing ? SoftphoneCopy.closing : SoftphoneCopy.elsewhereClose, busy: closing, color: t.onAccent),
          ),
        ?goThere,
      ],
    );
  }
}

/// Off for the account, with nothing here to finish.
class OffCard extends StatelessWidget {
  const OffCard({super.key});

  @override
  Widget build(BuildContext context) => const SessionCard(
    key: Key('softphone-off'),
    icon: Icons.phone_disabled_outlined,
    title: SoftphoneCopy.offTitle,
    body: SoftphoneCopy.offBody,
  );
}

/// Off here, and the agent's soft-phone session is open in another account:
/// close it (so the agent is not locked out of campaigns by it), and say who
/// can save an outcome its call still owes.
class StrandedCard extends ConsumerWidget {
  const StrandedCard({super.key, required this.state});

  final SoftphoneScreenOffStranded state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = ref.watch(softphoneViewProvider.select((v) => v.sessionBusy));
    final closing = busy == SoftphoneSessionBusy.closing;
    final t = context.tokens;
    return SessionCard(
      key: const Key('softphone-stranded'),
      icon: Icons.phone_disabled_outlined,
      title: SoftphoneCopy.strandedTitle,
      body: SoftphoneCopy.strandedDetail,
      notes: [
        if (state.callOwed) const CardNote(SoftphoneCopy.strandedOwed),
        const Text(SoftphoneCopy.strandedClose),
        const SessionErrorNote(),
      ],
      actions: [
        FilledButton(
          key: const Key('softphone-stranded-close'),
          onPressed: closing ? null : () => ref.read(softphoneActionsProvider).closeStranded(),
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          child: BusyLabel(label: closing ? SoftphoneCopy.closing : SoftphoneCopy.closeSoftphone, busy: closing, color: t.onAccent),
        ),
      ],
    );
  }
}

/// The bootstrap or the open failed for a reason Retry may fix.
class ErrorCard extends ConsumerWidget {
  const ErrorCard({super.key, required this.state});

  final SoftphoneScreenError state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    return SessionCard(
      key: const Key('softphone-error'),
      icon: Icons.error_outline,
      iconColor: t.danger,
      title: SoftphoneCopy.errorTitle,
      body: state.message,
      actions: [
        FilledButton(
          key: const Key('softphone-retry'),
          onPressed: () => ref.read(softphoneActionsProvider).retry(),
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          child: const Text(SoftphoneCopy.tryAgain),
        ),
      ],
    );
  }
}
