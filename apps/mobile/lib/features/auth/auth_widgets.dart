import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/theme/tokens.dart';
import '../../ui/primitives.dart';

/// The frame every getting-in screen shares: the brand mark, a title, and a
/// single scrolling column no wider than a phone (tablets and landscape keep
/// a readable measure). Scrolls rather than clips at 200 % text.
class AuthLayout extends StatelessWidget {
  const AuthLayout({
    super.key,
    required this.title,
    this.subtitle,
    required this.children,
    this.showLogo = true,
    this.eyebrow,
  });

  final String title;
  final String? subtitle;
  final List<Widget> children;
  final bool showLogo;

  /// A small pill above the title ("Invitation").
  final Widget? eyebrow;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(Space.xl, Space.xxl, Space.xl, Space.xl),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (showLogo) ...[
                    Center(
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(Radii.lg),
                        child: Image.asset(
                          'assets/brand/logo.png',
                          width: 56,
                          height: 56,
                          filterQuality: FilterQuality.medium,
                          excludeFromSemantics: true,
                        ),
                      ),
                    ),
                    const SizedBox(height: Space.xl),
                  ],
                  if (eyebrow != null) ...[Align(alignment: Alignment.centerLeft, child: eyebrow), const SizedBox(height: Space.md)],
                  Semantics(
                    header: true,
                    child: Text(title, style: text.headlineMedium, textAlign: showLogo ? TextAlign.center : TextAlign.start),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: Space.xs),
                    Text(
                      subtitle!,
                      style: text.bodyMedium!.copyWith(color: context.tokens.textSecondary),
                      textAlign: showLogo ? TextAlign.center : TextAlign.start,
                    ),
                  ],
                  const SizedBox(height: Space.xl),
                  ...children,
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The one message slot on a form. A live region, so a refusal is read out
/// wherever focus is (usually still inside the password field).
class FormMessage extends StatelessWidget {
  const FormMessage(this.message, {super.key, this.tone = Tone.danger});

  final String message;
  final Tone tone;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      liveRegion: true,
      child: DecoratedBox(
        decoration: BoxDecoration(color: tone.bg(t), borderRadius: BorderRadius.circular(Radii.sm)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.sm + 2),
          child: Text(message, style: Theme.of(context).textTheme.bodyMedium!.copyWith(color: tone.fg(t))),
        ),
      ),
    );
  }
}

/// A primary button that shows its in-flight label and cannot double-fire.
class BusyButton extends StatelessWidget {
  const BusyButton({
    super.key,
    required this.label,
    required this.busyLabel,
    required this.busy,
    required this.onPressed,
    this.outlined = false,
    this.leading,
  });

  final String label;
  final String busyLabel;
  final bool busy;
  final VoidCallback? onPressed;
  final bool outlined;
  final Widget? leading;

  @override
  Widget build(BuildContext context) {
    final child = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (busy)
          const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))
        else
          ?leading,
        if (busy || leading != null) const SizedBox(width: Space.sm),
        Flexible(child: Text(busy ? busyLabel : label, textAlign: TextAlign.center)),
      ],
    );
    final onTap = busy ? null : onPressed;
    const size = Size.fromHeight(52);
    return outlined
        ? OutlinedButton(onPressed: onTap, style: OutlinedButton.styleFrom(minimumSize: size), child: child)
        : FilledButton(onPressed: onTap, style: FilledButton.styleFrom(minimumSize: size), child: child);
  }
}

/// The Google "G", drawn in text so no third-party asset ships with the app.
class GoogleMark extends StatelessWidget {
  const GoogleMark({super.key});

  @override
  Widget build(BuildContext context) => const ExcludeSemantics(
        child: Text('G', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: Color(0xFF4285F4))),
      );
}

/// "or", between two ways in.
class OrDivider extends StatelessWidget {
  const OrDivider({super.key, this.label = 'or'});
  final String label;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: Space.md),
        child: Row(
          children: [
            const Expanded(child: Divider()),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.md),
              child: Text(label, style: Theme.of(context).textTheme.labelMedium),
            ),
            const Expanded(child: Divider()),
          ],
        ),
      );
}

/// Opens a link outside the app (a store page). Overridden in tests.
final externalLinkProvider = Provider<Future<bool> Function(Uri)>(
  (ref) => (uri) => launchUrl(uri, mode: LaunchMode.externalApplication),
);
