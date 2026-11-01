import 'package:flutter/material.dart';

import '../../../app/theme/tokens.dart';
import 'banners.dart';
import 'call_band.dart';

/// The two page shapes the station uses.
///
/// Both keep the content scrollable and the primary action pinned below it:
/// at 200% text the content scrolls, the action never moves off screen.

/// Waiting, offline, on break: header, banners, content, actions.
class IdleLayout extends StatelessWidget {
  const IdleLayout({super.key, required this.body, required this.actions});

  final List<Widget> body;
  final Widget actions;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const StationHeader(),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [const IdleLinkBanner(), const MicProblemBanner(), const MissedReleaseCard(), ...body],
            ),
          ),
        ),
        _ActionArea(child: actions),
      ],
    );
  }
}

/// Ringing, on a call, wrap-up: the band, content, and the pinned action.
class CallLayout extends StatelessWidget {
  const CallLayout({super.key, required this.body, required this.bottom});

  final List<Widget> body;
  final Widget bottom;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const CallBand(),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [const MicProblemBanner(), const MissedReleaseCard(), ...body],
            ),
          ),
        ),
        _ActionArea(child: bottom),
      ],
    );
  }
}

class _ActionArea extends StatelessWidget {
  const _ActionArea({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: t.border)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            // Bounded, so a long refusal at 200% text scrolls inside itself
            // instead of pushing the action off the screen.
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.22),
              child: const SingleChildScrollView(child: ActionErrorLine()),
            ),
            child,
          ],
        ),
      ),
    );
  }
}

/// Two buttons side by side, stacked when large text would squeeze them.
class ButtonPair extends StatelessWidget {
  const ButtonPair({super.key, required this.first, required this.second});

  final Widget first;
  final Widget second;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(16) / 16;
    if (scale > 1.35) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          first,
          const SizedBox(height: Space.sm),
          second,
        ],
      );
    }
    return Row(
      children: [
        Expanded(child: first),
        const SizedBox(width: Space.md),
        Expanded(child: second),
      ],
    );
  }
}
