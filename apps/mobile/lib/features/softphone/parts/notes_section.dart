import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../core/station/station_view.dart';
import '../../station/station_copy.dart';
import '../softphone_copy.dart';

/// The call's notes and their save status: the station's notes field, fed by
/// the soft phone. Every keystroke goes to [SoftphoneActions.setNotes] (the
/// core debounces the save and keeps unsent text on the phone); the status line
/// is the truthful one, never a static "Saved".
///
/// The panel keys this on the call, so a new call starts with an empty box.
class NotesSection extends ConsumerStatefulWidget {
  const NotesSection({super.key});

  @override
  ConsumerState<NotesSection> createState() => _NotesSectionState();
}

class _NotesSectionState extends ConsumerState<NotesSection> {
  late final TextEditingController _controller = TextEditingController(text: ref.read(softphoneViewProvider).notes.text);
  final _focus = FocusNode(debugLabel: 'softphone-notes');

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(
      softphoneViewProvider.select(
        (v) => (
          notes: v.notes,
          enabled: v.notesEnabled,
          reason: v.notesDisabledReason,
          required: v.outcomes.any((o) => o.code == v.outcomeCode && o.requiresNote),
        ),
      ),
    );
    // A restore (the core read the call again) reaches the box only while the
    // agent is not typing in it: mid-sentence it would move their cursor.
    ref.listen(softphoneViewProvider.select((v) => v.notes.text), (_, next) {
      if (next != _controller.text && !_focus.hasFocus) {
        _controller.value = TextEditingValue(
          text: next,
          selection: TextSelection.collapsed(offset: next.length),
        );
      }
    });
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final status = s.notes.status;
    final (Color color, FontWeight weight) = switch (status) {
      NotesStatus.retrying => (t.warning, FontWeight.w500),
      NotesStatus.failed => (t.danger, FontWeight.w600),
      NotesStatus.saved => (t.success, FontWeight.w400),
      _ => (t.textMuted, FontWeight.w400),
    };
    final label = s.required ? SoftphoneCopy.notesRequired : SoftphoneCopy.notes;
    final enabled = s.enabled && status != NotesStatus.closed;

    return Column(
      key: const Key('softphone-notes'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: Space.sm,
          children: [
            Text(label, style: text.labelMedium),
            Semantics(
              liveRegion: status == NotesStatus.failed || status == NotesStatus.retrying,
              child: Text(
                enabled ? StationCopy.notesStatus(status) : (s.reason ?? StationCopy.notesStatus(NotesStatus.closed)),
                key: const Key('softphone-notes-status'),
                style: text.labelSmall!.copyWith(color: color, fontWeight: weight),
              ),
            ),
          ],
        ),
        const SizedBox(height: Space.xs),
        Semantics(
          label: label,
          child: TextField(
            key: const Key('softphone-notes-field'),
            controller: _controller,
            focusNode: _focus,
            enabled: enabled,
            minLines: 3,
            maxLines: 6,
            keyboardType: TextInputType.multiline,
            textCapitalization: TextCapitalization.sentences,
            onChanged: (value) => ref.read(softphoneActionsProvider).setNotes(value),
            decoration: InputDecoration(
              hintText: SoftphoneCopy.notesHint,
              enabledBorder: s.required && _controller.text.trim().isEmpty
                  ? OutlineInputBorder(
                      borderRadius: BorderRadius.circular(Radii.sm),
                      borderSide: BorderSide(color: t.warning),
                    )
                  : null,
            ),
          ),
        ),
        if (s.notes.changedElsewhere) ...[
          const SizedBox(height: Space.xs),
          Text(StationCopy.notesChangedElsewhere, style: text.labelSmall!.copyWith(color: t.warning)),
        ],
      ],
    );
  }
}
