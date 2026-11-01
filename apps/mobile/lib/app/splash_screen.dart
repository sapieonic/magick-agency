import 'package:flutter/material.dart';

import 'theme/tokens.dart';

/// Shown while the gate resolves (version check, persisted sign-in, session).
/// The same mark as the native launch screen, so start-up has no visual jump.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Scaffold(
      body: Center(
        child: Semantics(
          label: 'Magick Agency is starting',
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(Radii.lg),
                child: Image.asset('assets/brand/logo.png', width: 64, height: 64, filterQuality: FilterQuality.medium),
              ),
              const SizedBox(height: Space.xl),
              SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: t.textMuted)),
            ],
          ),
        ),
      ),
    );
  }
}
