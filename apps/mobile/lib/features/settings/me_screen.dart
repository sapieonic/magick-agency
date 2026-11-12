import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme/app_theme.dart';
import '../../app/theme/tokens.dart';
import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/session/local_preferences.dart';
import '../../core/station/station_signals.dart';
import '../../core/station/station_view.dart';
import '../../core/telemetry/log.dart';
import '../../ui/primitives.dart';
import '../accounts/account_switcher.dart';
import 'notification_preferences.dart';

/// Why signing out is refused right now, or null.
///
/// A call on screen, and an agent still in the dialing pool, get the
/// console's Exit-station sentences (`EXIT_BLOCKED_COPY` and
/// `EXIT_AVAILABLE_BLOCKED_COPY` in `apps/console`), less its "or go on
/// break": the console lets an agent on a break exit, but this phone keeps the
/// station open until the agent leaves it, so a break is no way out here and
/// the sentence on a break says so.
///
/// A soft-phone call that owes its outcome, and an open soft phone, get the
/// soft phone's own sentences.
String? signOutBlockedReason(StationSignals signals, {AgentPhase? phase}) {
  if (signals.callActive) return signOutBlockedOnCall;
  final softphone = signals.sessionKind == StationSessionKind.softphone;
  if (signals.outcomeOwed) return softphone ? signOutBlockedOwedSoftphone : signOutBlockedOwedStation;
  if (!signals.onDuty) return null;
  if (softphone) return signOutBlockedSoftphone;
  return switch (phase) {
    AgentPhase.available => signOutBlockedAvailable,
    AgentPhase.onBreak => signOutBlockedOnBreak,
    _ => signOutBlockedOpen,
  };
}

const signOutBlockedOnCall = 'Finish this call first — this call is still on your screen.';
const signOutBlockedAvailable =
    'You’re still in the dialling pool — leave the station first, or a call could be sent to an empty screen.';
const signOutBlockedOnBreak = 'You’re on a break, but your station is still open on this phone — leave the station first, then sign out.';
const signOutBlockedOpen = 'Your station is still open on this phone — leave the station first, then sign out.';
const signOutBlockedSoftphone = 'Your soft phone is still open on this phone — close the soft phone first, then sign out.';
const signOutBlockedOwedSoftphone =
    'Save this call’s outcome first — then close the soft phone and sign out.';
const signOutBlockedOwedStation = 'Save this call’s outcome first — then leave the station and sign out.';

/// The Me tab: who and where the agent is, their email preferences, this
/// phone's theme, sound and vibration, diagnostics for support, and sign-out.
class MeScreen extends ConsumerWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gate = ref.watch(appGateProvider);
    final ready = gate is GateReady ? gate : null;
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Me')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.xxl),
        children: [
          if (ready != null) ...[
            Text(ready.displayName, style: text.headlineSmall),
            if (ready.email != null && ready.email != ready.displayName) Text(ready.email!, style: text.bodySmall),
            const SizedBox(height: Space.xl),
            const SectionLabel('Account'),
            const SizedBox(height: Space.sm),
            _AccountCard(ready: ready),
            const SizedBox(height: Space.xl),
          ],
          const SectionLabel('Email notifications'),
          const SizedBox(height: Space.sm),
          const _NotificationSection(),
          const SizedBox(height: Space.xl),
          const SectionLabel('Appearance'),
          const SizedBox(height: Space.sm),
          const _AppearanceCard(),
          const SizedBox(height: Space.xl),
          const SectionLabel('Sound and haptics'),
          const SizedBox(height: Space.sm),
          const _LocalPrefsCard(),
          const SizedBox(height: Space.xl),
          const SectionLabel('Diagnostics'),
          const SizedBox(height: Space.sm),
          const _DiagnosticsCard(),
          const SizedBox(height: Space.xl),
          const _SignOut(),
        ],
      ),
    );
  }
}

class _AccountCard extends ConsumerWidget {
  const _AccountCard({required this.ready});
  final GateReady ready;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = Theme.of(context).textTheme;
    final canSwitch = ready.accounts.length > 1;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          ListTile(
            title: Text(ready.accountName),
            subtitle: ready.tenantName.isEmpty ? null : Text(ready.tenantName),
            leading: const Icon(Icons.business_outlined),
          ),
          if (canSwitch) ...[
            const Divider(),
            ListTile(
              minTileHeight: Space.touch + 8,
              leading: const Icon(Icons.swap_horiz),
              title: Text('Switch account', style: text.titleSmall),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => showAccountSwitcher(context),
            ),
          ],
        ],
      ),
    );
  }
}

class _NotificationSection extends ConsumerWidget {
  const _NotificationSection();

  Future<void> _apply(BuildContext context, Future<String?> save) async {
    final error = await save;
    if (error != null && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspace = ref.watch(agentWorkspaceProvider);
    if (workspace == null) return const SizedBox.shrink();
    // Per workspace: another account or agent starts from nothing, never from
    // the previous one's settings.
    final provider = notificationPreferencesProvider(workspace);
    final prefs = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final text = Theme.of(context).textTheme;
    final intro = Padding(
      padding: const EdgeInsets.only(bottom: Space.sm),
      child: Text(
        'Choose which emails you receive from this organisation. These settings are yours alone, and each '
        'organisation you belong to has its own.',
        style: text.bodySmall,
      ),
    );

    return switch (prefs) {
      AsyncValue(:final value?) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            intro,
            if (value.isEmpty)
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Nothing to configure', style: text.titleSmall),
                    const SizedBox(height: Space.xs),
                    Text('There are no notifications aimed at your role in this organisation yet.', style: text.bodySmall),
                  ],
                ),
              )
            else
              for (final group in _grouped(value)) ...[
                Padding(
                  padding: const EdgeInsets.only(top: Space.sm, bottom: Space.xs),
                  child: Text(categoryLabel(group.key), style: text.labelMedium),
                ),
                Card(
                  clipBehavior: Clip.antiAlias,
                  child: Column(
                    children: [
                      for (var i = 0; i < group.value.length; i++) ...[
                        if (i > 0) const Divider(),
                        _EventRow(
                          event: group.value[i],
                          onEnabled: (on) => _apply(context, controller.setEnabled(group.value[i].key, on)),
                          onFrequency: (f) => _apply(context, controller.setFrequency(group.value[i].key, f)),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
          ],
        ),
      // "Try again" after a failure: the spinner, not the old error.
      AsyncValue(:final error?) when !prefs.isLoading => AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                error is ApiError ? error.userMessage : 'Could not load your notification settings',
                style: text.bodyMedium,
              ),
              const SizedBox(height: Space.sm),
              OutlinedButton(
                onPressed: () => ref.invalidate(provider),
                child: const Text('Try again'),
              ),
            ],
          ),
        ),
      _ => const Padding(
          padding: EdgeInsets.all(Space.lg),
          child: Center(child: CircularProgressIndicator(semanticsLabel: 'Loading your notification settings')),
        ),
    };
  }

  static List<MapEntry<String, List<NotificationEventPreference>>> _grouped(List<NotificationEventPreference> events) {
    final byCategory = <String, List<NotificationEventPreference>>{};
    for (final e in events) {
      (byCategory[e.category] ??= []).add(e);
    }
    return byCategory.entries.toList(growable: false);
  }
}

class _EventRow extends StatelessWidget {
  const _EventRow({required this.event, required this.onEnabled, required this.onFrequency});

  final NotificationEventPreference event;
  final ValueChanged<bool> onEnabled;
  final ValueChanged<NotificationFrequency> onFrequency;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final digest = event.cadence == NotificationCadence.digest;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SwitchListTile(
          value: event.enabled,
          onChanged: onEnabled,
          title: Text(event.label),
          subtitle: Text(event.description, style: text.bodySmall),
        ),
        if (digest)
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.md),
            child: Wrap(
              spacing: Space.sm,
              children: [
                for (final f in frequencyLabels.entries)
                  ChoiceChip(
                    label: Text(f.value),
                    selected: event.enabled && event.frequency == f.key,
                    onSelected: (_) => onFrequency(f.key),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Until the agent chooses, the switch shows what the phone's own setting gives.
class _AppearanceCard extends ConsumerWidget {
  const _AppearanceCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final chosen = ref.watch(localPreferencesProvider.select((p) => p.darkTheme));
    final dark = chosen ?? MediaQuery.platformBrightnessOf(context) == Brightness.dark;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: SwitchListTile(
        value: dark,
        onChanged: ref.read(localPreferencesProvider.notifier).setDarkTheme,
        secondary: Icon(dark ? Icons.dark_mode_outlined : Icons.light_mode_outlined),
        title: const Text('Dark theme'),
        subtitle: Text('On this phone only', style: Theme.of(context).textTheme.bodySmall),
      ),
    );
  }
}

class _LocalPrefsCard extends ConsumerWidget {
  const _LocalPrefsCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final prefs = ref.watch(localPreferencesProvider);
    final notifier = ref.read(localPreferencesProvider.notifier);
    final text = Theme.of(context).textTheme;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          SwitchListTile(
            value: prefs.sounds,
            onChanged: notifier.setSounds,
            title: const Text('Sounds'),
            subtitle: Text('Ring and call tones on this phone', style: text.bodySmall),
          ),
          const Divider(),
          SwitchListTile(
            value: prefs.haptics,
            onChanged: notifier.setHaptics,
            title: const Text('Vibration'),
            subtitle: Text('A buzz when a call arrives and when it connects', style: text.bodySmall),
          ),
        ],
      ),
    );
  }
}

class _DiagnosticsCard extends ConsumerWidget {
  const _DiagnosticsCard();

  Future<void> _copyLogs(BuildContext context) async {
    final lines = Log.recent();
    await Clipboard.setData(ClipboardData(text: lines.join('\n')));
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Copied ${lines.length} log ${lines.length == 1 ? 'line' : 'lines'}. Phone numbers and email addresses are '
          'masked.',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final identity = ref.watch(clientIdentityProvider);
    final text = Theme.of(context).textTheme;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _InfoRow(label: 'App version', value: '${identity.version} (${identity.build})'),
          const SizedBox(height: Space.sm),
          Text('Client', style: text.bodySmall),
          SelectableText(identity.header, style: monoStyle(context, size: 12)),
          const SizedBox(height: Space.md),
          OutlinedButton.icon(
            onPressed: () => _copyLogs(context),
            icon: const Icon(Icons.copy_all_outlined),
            label: const Text('Copy recent logs'),
          ),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return MergeSemantics(
      child: Row(
        children: [
          Expanded(child: Text(label, style: text.bodyMedium)),
          Text(value, style: monoStyle(context)),
        ],
      ),
    );
  }
}

class _SignOut extends ConsumerStatefulWidget {
  const _SignOut();

  @override
  ConsumerState<_SignOut> createState() => _SignOutState();
}

class _SignOutState extends ConsumerState<_SignOut> {
  bool _signingOut = false;

  Future<void> _confirm() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text('You’ll need your email and password, or Google, to sign in again on this phone.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Sign out')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _signingOut = true);
    await ref.read(appGateProvider.notifier).signOut();
    if (mounted) setState(() => _signingOut = false);
  }

  @override
  Widget build(BuildContext context) {
    final blocked = signOutBlockedReason(
      ref.watch(stationSignalsProvider),
      phase: ref.watch(stationViewProvider.select((v) => v?.phase)),
    );
    final t = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        OutlinedButton.icon(
          onPressed: blocked != null || _signingOut ? null : _confirm,
          icon: const Icon(Icons.logout),
          label: Text(_signingOut ? 'Signing out…' : 'Sign out'),
          style: OutlinedButton.styleFrom(foregroundColor: t.danger, minimumSize: const Size.fromHeight(52)),
        ),
        if (blocked != null) ...[
          const SizedBox(height: Space.sm),
          Text(blocked, style: Theme.of(context).textTheme.bodySmall!.copyWith(color: t.warning)),
        ],
      ],
    );
  }
}
