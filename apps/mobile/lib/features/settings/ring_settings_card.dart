import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/ring/ring_channel.dart';
import '../../core/ring/ring_copy.dart';
import '../../core/ring/ring_overrides.dart';
import '../../core/ring/ring_registration.dart';
import '../../ui/primitives.dart';

/// Me → Inbound calls (Mode B): "Ring this phone for inbound calls". Shown only where the
/// account allows ringing (`account_allows_ring`). The toggle is the agent's opt-in on this
/// phone; the checklist says what on the phone could stop a ring, each with a way to fix it;
/// the miss rule says what happens when rings go unanswered; the test ring proves it works.
class RingSettingsSection extends ConsumerWidget {
  const RingSettingsSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(ringSettingsProvider);
    if (settings == null || !settings.showCard) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionLabel(RingCopy.section),
        const SizedBox(height: Space.sm),
        RingSettingsCard(settings: settings),
        const SizedBox(height: Space.xl),
      ],
    );
  }
}

class RingSettingsCard extends ConsumerWidget {
  const RingSettingsCard({super.key, required this.settings});

  final RingSettings settings;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final registration = ref.read(ringRegistrationProvider.notifier);
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final status = settings.status!;
    final blocker = !status.pushConfigured
        ? RingCopy.notConfigured
        : (settings.token == null ? RingCopy.noPush : null);
    final checklist = settings.checklist;
    return Card(
      key: const Key('ring-settings'),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SwitchListTile(
            key: const Key('ring-toggle'),
            value: settings.optIn,
            onChanged: blocker != null || settings.saving ? null : (on) => registration.setOptIn(on),
            title: const Text(RingCopy.toggle),
            subtitle: Text(RingCopy.explain, style: text.bodySmall),
          ),
          if (blocker != null)
            _Note(text: blocker, color: t.warning)
          else if (settings.error != null)
            _Note(text: settings.error!, color: t.danger),
          const Divider(),
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.xs),
            child: Text(RingCopy.checklistTitle, style: text.labelMedium),
          ),
          if (checklist == null)
            _Note(text: RingCopy.checklistUnknown, color: t.textSecondary)
          else
            for (final item in RingChecklistItem.values)
              _ChecklistRow(item: item, ok: checklist.ok(item), onFix: () => registration.openSettings(item)),
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.md),
            child: Text(RingCopy.missRule, style: text.bodySmall!.copyWith(color: t.textSecondary)),
          ),
          if (settings.optIn && blocker == null) ...[
            const Divider(),
            _TestRing(phase: settings.testRing, onSend: registration.sendTestRing),
          ],
        ],
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note({required this.text, required this.color});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.md),
        child: Text(text, style: Theme.of(context).textTheme.bodySmall!.copyWith(color: color)),
      );
}

class _ChecklistRow extends StatelessWidget {
  const _ChecklistRow({required this.item, required this.ok, required this.onFix});

  final RingChecklistItem item;
  final bool ok;
  final VoidCallback onFix;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final label = RingCopy.item(item);
    return ListTile(
      key: Key('ring-check-${item.wire}'),
      minTileHeight: Space.touch,
      leading: Icon(
        ok ? Icons.check_circle_outline : Icons.error_outline,
        color: ok ? t.success : t.warning,
        semanticLabel: ok ? RingCopy.ready : RingCopy.needsAttention,
      ),
      title: Text(label),
      subtitle: Text(RingCopy.itemHint(item), style: Theme.of(context).textTheme.bodySmall),
      trailing: ok
          ? null
          : TextButton(
              onPressed: onFix,
              child: Text(RingCopy.fix, semanticsLabel: '${RingCopy.fix}: $label'),
            ),
    );
  }
}

class _TestRing extends StatelessWidget {
  const _TestRing({required this.phase, required this.onSend});

  final TestRingPhase phase;
  final Future<void> Function() onSend;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final busy = phase == TestRingPhase.sending || phase == TestRingPhase.waiting;
    final (String? line, Color color) = switch (phase) {
      TestRingPhase.idle => (null, t.textSecondary),
      TestRingPhase.sending => (RingCopy.testSending, t.textSecondary),
      TestRingPhase.waiting => (RingCopy.testWaiting, t.textSecondary),
      TestRingPhase.received => (RingCopy.testReceived, t.success),
      TestRingPhase.timedOut => (RingCopy.testTimedOut, t.warning),
      TestRingPhase.tooSoon => (RingCopy.testTooSoon, t.warning),
      TestRingPhase.failed => (RingCopy.testFailed, t.danger),
    };
    return Padding(
      padding: const EdgeInsets.all(Space.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          OutlinedButton.icon(
            key: const Key('ring-test'),
            onPressed: busy ? null : onSend,
            icon: const Icon(Icons.ring_volume_outlined),
            label: const Text(RingCopy.testRing),
          ),
          if (line != null) ...[
            const SizedBox(height: Space.sm),
            Semantics(
              liveRegion: true,
              child: Text(line, key: const Key('ring-test-result'), style: Theme.of(context).textTheme.bodySmall!.copyWith(color: color)),
            ),
          ],
        ],
      ),
    );
  }
}
