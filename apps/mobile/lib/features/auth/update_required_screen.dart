import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme/tokens.dart';
import '../../core/auth/app_gate.dart';
import '../../ui/primitives.dart';
import 'auth_widgets.dart';

/// This build is below the server's `min_supported`: nothing else opens until
/// it is updated. The store link comes from `GET /client-config`.
class UpdateRequiredScreen extends ConsumerStatefulWidget {
  const UpdateRequiredScreen({super.key});

  @override
  ConsumerState<UpdateRequiredScreen> createState() => _UpdateRequiredScreenState();
}

class _UpdateRequiredScreenState extends ConsumerState<UpdateRequiredScreen> {
  String? _error;

  Future<void> _open(String url) async {
    setState(() => _error = null);
    final uri = Uri.tryParse(url);
    var opened = false;
    if (uri != null) {
      try {
        opened = await ref.read(externalLinkProvider)(uri);
      } catch (_) {
        opened = false;
      }
    }
    if (!opened && mounted) setState(() => _error = 'We couldn’t open the store. Open it yourself and update Magick Agency.');
  }

  @override
  Widget build(BuildContext context) {
    final gate = ref.watch(appGateProvider);
    final identity = ref.watch(clientIdentityProvider);
    final storeUrl = gate is GateUpdateRequired ? gate.storeUrl : null;
    final min = gate is GateUpdateRequired ? gate.minSupported : '';
    final store = identity.platform == 'ios' ? 'the App Store' : 'Google Play';
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    return AuthLayout(
      title: 'Update the app',
      children: [
        Text(
          'This version of Magick Agency is too old to take calls. Update it from $store to carry on — '
          'your sign-in and settings stay as they are.',
          style: text.bodyMedium!.copyWith(color: t.textSecondary),
        ),
        const SizedBox(height: Space.md),
        Text(
          'You have ${identity.version} · ${min.isEmpty ? 'a newer version is needed' : 'needs $min or later'}',
          style: text.bodySmall,
        ),
        const SizedBox(height: Space.xl),
        if (_error != null) ...[FormMessage(_error!, tone: Tone.warn), const SizedBox(height: Space.lg)],
        if (storeUrl != null && storeUrl.isNotEmpty)
          FilledButton.icon(
            onPressed: () => _open(storeUrl),
            icon: const Icon(Icons.system_update_alt),
            label: const Text('Update now'),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          )
        else
          Text('Open $store and search for Magick Agency.', style: text.bodyMedium, textAlign: TextAlign.center),
      ],
    );
  }
}
