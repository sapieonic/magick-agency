import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../app/theme/tokens.dart';
import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/flags/feature_flags.dart';
import '../../core/station/station_signals.dart';
import '../../core/station/station_view.dart' show stationViewProvider;
import '../../ui/primitives.dart';
import '../accounts/account_switcher.dart';
// "Enter station" goes to pre-flight with the campaign's name in the query,
// the way pre-flight reads it.
import '../preflight/preflight_screen.dart' show preflightLocation;
import 'assignment_entry.dart';
import 'campaigns_providers.dart';

/// The Station tab's first screen (mock 4): the campaigns this agent is
/// staffed on, with the console's status wording.
class CampaignsScreen extends ConsumerWidget {
  const CampaignsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Per workspace: another account or agent starts from nothing, never
    // from the previous one's list.
    final workspace = ref.watch(agentWorkspaceProvider);
    final assignments = workspace == null ? null : ref.watch(myAssignmentsProvider(workspace));
    final signals = ref.watch(stationSignalsProvider);
    final onDutyCampaign = signals.onDuty ? signals.campaignId : null;
    final softphoneOpen = signals.onDuty && signals.sessionKind == StationSessionKind.softphone;

    Future<void> refresh() async {
      if (workspace == null) return;
      rereadFeatureFlagsIfFailed(ref, workspace);
      try {
        final _ = await ref.refresh(myAssignmentsProvider(workspace).future);
      } catch (e) {
        // With a list already on screen it stays; say why it did not update.
        if (context.mounted && ref.read(myAssignmentsProvider(workspace)).hasValue) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e is ApiError ? e.userMessage : 'Could not check your campaigns.')),
          );
        }
      }
    }

    final List<Widget> body = switch (assignments) {
      // Signed out, or between accounts: nobody's list.
      null => const [],
      AsyncValue(:final value?) => _list(context, value, onDutyCampaign),
      // "Try again" after a failure: the spinner, not the old error.
      AsyncValue(:final error?, :final isLoading) when !isLoading => [
          _Centred(
            title: 'We couldn’t check your campaigns',
            body: error is ApiError ? error.userMessage : 'Could not check your campaigns.',
            action: OutlinedButton(onPressed: () => ref.invalidate(myAssignmentsProvider(workspace!)), child: const Text('Try again')),
          ),
        ],
      _ => [
          const Padding(
            padding: EdgeInsets.only(top: 120),
            child: Center(child: CircularProgressIndicator(semanticsLabel: 'Loading your campaigns')),
          ),
        ],
    };

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: refresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(Space.lg, Space.lg, Space.lg, Space.xl),
            children: [
              const _Header(),
              const SizedBox(height: Space.lg),
              if (onDutyCampaign != null) ...[
                _OnDutyBanner(campaignId: onDutyCampaign, name: _nameFor(assignments?.value, onDutyCampaign)),
                const SizedBox(height: Space.lg),
              ] else if (softphoneOpen) ...[
                const SoftphoneOpenBanner(),
                const SizedBox(height: Space.lg),
              ],
              ...body,
            ],
          ),
        ),
      ),
    );
  }

  static String? _nameFor(List<Assignment>? list, String id) {
    final match = list?.where((a) => a.campaignId == id).firstOrNull;
    return match == null ? null : campaignDisplayName(match);
  }

  List<Widget> _list(BuildContext context, List<Assignment> list, String? onDutyCampaign) {
    if (list.isEmpty) {
      return const [
        _Centred(title: 'You’re not assigned to a campaign yet', body: 'Ask your supervisor to add you to one.'),
      ];
    }
    return [
      for (final a in list) ...[
        _CampaignCard(assignment: a, onDutyCampaign: onDutyCampaign),
        const SizedBox(height: Space.md),
      ],
      if (list.length > 1)
        Padding(
          padding: const EdgeInsets.only(top: Space.sm),
          child: Text(
            'You can be on one campaign at a time.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
    ];
  }
}

class _Header extends ConsumerWidget {
  const _Header();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gate = ref.watch(appGateProvider);
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final ready = gate is GateReady ? gate : null;
    final canSwitch = (ready?.accounts.length ?? 0) > 1;
    final label = ready?.current.label ?? '';
    final subtitle = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Flexible(child: Text(label, style: text.bodyMedium!.copyWith(color: t.textSecondary), overflow: TextOverflow.ellipsis)),
        if (canSwitch) Icon(Icons.expand_more, size: 18, color: t.textSecondary),
      ],
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(header: true, child: Text('My campaigns', style: text.headlineMedium)),
        if (label.isNotEmpty)
          canSwitch
              ? Semantics(
                  button: true,
                  label: 'Account: $label. Switch account',
                  excludeSemantics: true,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(Radii.sm),
                    onTap: () => showAccountSwitcher(context),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: Space.touch),
                      child: Align(alignment: Alignment.centerLeft, widthFactor: 1, child: subtitle),
                    ),
                  ),
                )
              : Padding(padding: const EdgeInsets.only(top: Space.xs), child: subtitle),
      ],
    );
  }
}

class _OnDutyBanner extends StatelessWidget {
  const _OnDutyBanner({required this.campaignId, required this.name});

  final String campaignId;
  final String? name;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return AppCard(
      color: t.accentSubtle,
      borderColor: t.borderFocus,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(name == null ? 'You’re on duty' : 'You’re on duty on $name', style: text.titleMedium),
          const SizedBox(height: Space.xs),
          Text('You can be on one campaign at a time. Leave this one before starting another.', style: text.bodySmall),
          const SizedBox(height: Space.md),
          FilledButton(
            onPressed: () => context.go(Routes.station(campaignId)),
            child: const Text('Back to your station'),
          ),
        ],
      ),
    );
  }
}

/// The agent's soft-phone session is open on this phone. Joining a campaign is
/// still offered: the pre-flight's join asks to close the soft phone first (and
/// refuses while a call there is unfinished).
class SoftphoneOpenBanner extends StatelessWidget {
  const SoftphoneOpenBanner({super.key});

  static const title = 'Your soft phone is open';
  static const body = 'You can have one session at a time. Joining a campaign closes the soft phone first.';
  static const action = 'Back to the soft phone';

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return AppCard(
      key: const Key('softphone-open-banner'),
      color: t.accentSubtle,
      borderColor: t.borderFocus,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: text.titleMedium),
          const SizedBox(height: Space.xs),
          Text(body, style: text.bodySmall),
          const SizedBox(height: Space.md),
          FilledButton(onPressed: () => context.go(Routes.phone), child: const Text(action)),
        ],
      ),
    );
  }
}

class _CampaignCard extends ConsumerWidget {
  const _CampaignCard({required this.assignment, required this.onDutyCampaign});

  final Assignment assignment;
  final String? onDutyCampaign;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final entry = assignmentEntry(assignment);
    final name = campaignDisplayName(assignment);
    final isOnDutyHere = onDutyCampaign == assignment.campaignId;
    // Contact assignment: the agent's own contacts here, on the console's
    // rule, which reads the join bootstrap: only while on duty on this
    // campaign, and only when it assigns contacts or lets agents retry
    // ([StationView.myContactsOffered]). Off duty there is no bootstrap to
    // judge by, so nothing (the console offers it from the station only).
    final offeredHere = isOnDutyHere &&
        ref.watch(stationViewProvider.select(
          (v) => v != null && v.campaignId == assignment.campaignId && v.myContactsOffered,
        ));
    final contacts = ref.watch(contactAssignmentEnabledProvider) && offeredHere
        ? TextButton.icon(
            key: Key('my-contacts-${assignment.campaignId}'),
            onPressed: () => context.go(Routes.myContacts(assignment.campaignId)),
            icon: const Icon(Icons.people_alt_outlined, size: 18),
            label: Semantics(label: 'My contacts in $name', excludeSemantics: true, child: const Text('My contacts')),
          )
        : null;

    final Widget? action;
    if (isOnDutyHere) {
      action = FilledButton(
        onPressed: () => context.go(Routes.station(assignment.campaignId)),
        child: const Text('Back to your station'),
      );
    } else if (!entry.canEnter) {
      action = Text('Closed', style: text.labelLarge!.copyWith(color: t.textMuted));
    } else if (onDutyCampaign != null) {
      // On duty elsewhere: the banner above is the way back, not a second station.
      action = null;
    } else {
      action = FilledButton(
        onPressed: () => context.push(preflightLocation(assignment.campaignId, name)),
        child: Semantics(label: 'Enter station for $name', excludeSemantics: true, child: const Text('Enter station')),
      );
    }

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: Space.sm,
            runSpacing: Space.xs,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(name, style: text.titleMedium),
              if (entry.label != null) StatusPill(entry.label!, tone: entry.tone),
            ],
          ),
          if (entry.note != null) ...[
            const SizedBox(height: Space.xs),
            Text(entry.note!, style: text.bodySmall),
          ],
          if (action != null || contacts != null) ...[
            const SizedBox(height: Space.md),
            Wrap(
              spacing: Space.sm,
              runSpacing: Space.sm,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [?action, ?contacts],
            ),
          ],
        ],
      ),
    );
  }
}

class _Centred extends StatelessWidget {
  const _Centred({required this.title, required this.body, this.action});

  final String title;
  final String body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(top: 72),
      child: Column(
        children: [
          Text(title, style: text.titleLarge, textAlign: TextAlign.center),
          const SizedBox(height: Space.sm),
          Text(body, style: text.bodyMedium!.copyWith(color: context.tokens.textSecondary), textAlign: TextAlign.center),
          if (action != null) ...[const SizedBox(height: Space.lg), action!],
        ],
      ),
    );
  }
}
