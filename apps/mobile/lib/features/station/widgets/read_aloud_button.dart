import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/speech/read_aloud.dart';
import '../station_copy.dart';

/// The small speaker that reads [text] aloud through the phone's own voice (AS13): on What
/// happened?'s tiles and the script. 48 dp to the touch, drawn small.
class ReadAloudButton extends ConsumerWidget {
  const ReadAloudButton({super.key, required this.text, this.color});

  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return IconButton(
      tooltip: '${StationCopy.readAloud}: $text',
      visualDensity: VisualDensity.compact,
      style: IconButton.styleFrom(minimumSize: const Size(Space.touch, Space.touch)),
      onPressed: () => unawaited(ref.read(readAloudProvider).speak(text)),
      icon: Icon(Icons.volume_up_outlined, size: 20, color: color ?? context.tokens.textSecondary),
    );
  }
}
