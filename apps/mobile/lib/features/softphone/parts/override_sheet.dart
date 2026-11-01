import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../softphone_copy.dart';

/// "Call anyway" for a Do Not Call hit (SP1) or a closed calling window (SP2):
/// a port of the console's `OverrideDialog`, as a sheet.
///
/// It says exactly what matched (the facts, already in words) and what calling
/// anyway costs, and asks for the reason: 10–500 characters after trimming,
/// counted as the server counts them, with a live counter. "Don't call" is the
/// primary action, because the safe answer is the default one; "Call anyway"
/// is the secondary one and stays disabled until the note is valid.
///
/// The sheet is the prompt's: it opens when [SoftphoneView.overridePrompt]
/// appears and closes when it goes (a cancel, or the redial it started). The
/// back gesture answers "Don't call"; a stray tap outside or a drag does
/// nothing, so a half-written reason is never thrown away.
Future<void> showOverrideSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    isDismissible: false,
    enableDrag: false,
    builder: (context) => const _OverrideSheet(),
  );
}

class _OverrideSheet extends ConsumerStatefulWidget {
  const _OverrideSheet();

  @override
  ConsumerState<_OverrideSheet> createState() => _OverrideSheetState();
}

class _OverrideSheetState extends ConsumerState<_OverrideSheet> {
  final _note = TextEditingController();
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    ref.listenManual<SoftphoneOverridePrompt?>(softphoneViewProvider.select((v) => v.overridePrompt), (prev, next) {
      if (next == null) {
        _close();
      } else if (prev != null && prev.kind != next.kind) {
        // The other refusal of the same dial: a new reason for a new question.
        // The first one is kept by the core and sent again with this one.
        _note.clear();
      }
    }, fireImmediately: true);
  }

  void _close() {
    if (_closing) return;
    _closing = true;
    Future.microtask(() {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      final navigator = Navigator.of(context);
      route.isCurrent ? navigator.pop() : navigator.removeRoute(route);
    });
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final prompt = ref.watch(softphoneViewProvider.select((v) => v.overridePrompt));
    if (prompt == null) return const SizedBox.shrink();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final actions = ref.read(softphoneActionsProvider);

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && !prompt.submitting) actions.cancelOverride();
      },
      child: SingleChildScrollView(
        key: Key('override-sheet-${prompt.kind.name}'),
        padding: EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(header: true, child: Text(prompt.title, style: text.titleLarge)),
            const SizedBox(height: Space.md),
            for (final f in prompt.facts)
              MergeSemantics(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Space.sm),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(f.label, style: text.labelSmall),
                      const SizedBox(height: 2),
                      Text(f.value, style: text.bodyMedium),
                    ],
                  ),
                ),
              ),
            const SizedBox(height: Space.xs),
            Text(
              prompt.consequence,
              key: const Key('override-consequence'),
              style: text.bodyMedium!.copyWith(color: t.textSecondary),
            ),
            const SizedBox(height: Space.lg),
            ListenableBuilder(
              listenable: _note,
              builder: (context, _) {
                final note = _note.text;
                final n = SoftphoneOverridePrompt.noteLength(note);
                final valid = SoftphoneOverridePrompt.noteValid(note);
                final problem = note.isEmpty || valid
                    ? null
                    : n < SoftphoneOverridePrompt.noteMin
                    ? SoftphoneCopy.noteTooShort(SoftphoneOverridePrompt.noteMin)
                    : SoftphoneCopy.noteTooLong(SoftphoneOverridePrompt.noteMax);
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      key: const Key('override-note'),
                      controller: _note,
                      autofocus: true,
                      enabled: !prompt.submitting,
                      minLines: 3,
                      maxLines: 6,
                      maxLength: SoftphoneOverridePrompt.noteMax + 50,
                      keyboardType: TextInputType.multiline,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(
                        label: Semantics(
                          label: '${prompt.noteLabel}, ${SoftphoneCopy.required}',
                          excludeSemantics: true,
                          child: Text.rich(
                            TextSpan(
                              children: [
                                TextSpan(text: prompt.noteLabel),
                                TextSpan(
                                  text: ' *',
                                  style: TextStyle(color: t.danger),
                                ),
                              ],
                            ),
                          ),
                        ),
                        alignLabelWithHint: true,
                        // The counter is ours: the server's count (code points after trimming).
                        counterText: '',
                        errorText: prompt.error,
                        errorMaxLines: 4,
                      ),
                    ),
                    const SizedBox(height: Space.xs),
                    Text(
                      [?problem, SoftphoneCopy.noteCounter(n, SoftphoneOverridePrompt.noteMax)].join(' '),
                      key: const Key('override-counter'),
                      style: text.labelSmall!.copyWith(color: problem == null ? t.textMuted : t.danger),
                    ),
                    const SizedBox(height: Space.lg),
                    FilledButton(
                      key: const Key('override-cancel'),
                      onPressed: prompt.submitting ? null : actions.cancelOverride,
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                      child: const Text(SoftphoneCopy.dontCall),
                    ),
                    const SizedBox(height: Space.sm),
                    OutlinedButton(
                      key: const Key('override-confirm'),
                      onPressed: valid && !prompt.submitting ? () => actions.confirmOverride(note) : null,
                      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                      child: Text(prompt.submitting ? SoftphoneCopy.calling : prompt.confirmLabel),
                    ),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
