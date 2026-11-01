import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/auth/app_gate.dart';
import 'theme/tokens.dart';

/// Shown while the gate resolves (version check, persisted sign-in, session).
/// The same mark as the native launch screen, so start-up has no visual jump.
///
/// When start-up cannot reach the server the gate keeps retrying on its own
/// and sets [GateLoading.notice]; the splash then says so and offers "Try
/// again" instead of spinning in silence.
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final gate = ref.watch(appGateProvider);
    final notice = gate is GateLoading ? gate.notice : null;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Space.xl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Semantics(
                  label: 'Magick Agency is starting',
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(Radii.lg),
                    child: Image.asset('assets/brand/logo.png', width: 64, height: 64, filterQuality: FilterQuality.medium),
                  ),
                ),
                const SizedBox(height: Space.xl),
                SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: t.textMuted)),
                if (notice != null) ...[
                  const SizedBox(height: Space.lg),
                  Semantics(
                    liveRegion: true,
                    child: Text(
                      notice,
                      key: const Key('splash-notice'),
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: t.textMuted),
                    ),
                  ),
                  const SizedBox(height: Space.md),
                  OutlinedButton(
                    key: const Key('splash-retry'),
                    onPressed: () => ref.read(appGateProvider.notifier).retryNow(),
                    child: const Text('Try again'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
