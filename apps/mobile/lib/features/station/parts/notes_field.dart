import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../station_copy.dart';

/// The call's notes and their save status.
///
/// The controller belongs to the station screen (one per call), so the text,
/// cursor and keyboard survive the move from "On call" to "Wrap-up". The core
/// debounces and saves; this field reports every keystroke and shows the
/// truthful status line, never a static "Saved".
class StationNotesField extends ConsumerStatefulWidget {
  const StationNotesField({super.key, required this.controller, this.required = false});

  final TextEditingController controller;

  /// The chosen outcome needs a note.
  final bool required;

  @override
  ConsumerState<StationNotesField> createState() => _StationNotesFieldState();
}

class _StationNotesFieldState extends ConsumerState<StationNotesField> {
  final _focus = FocusNode(debugLabel: 'station-notes');

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final notes = ref.watch(stationViewProvider.select((v) => v?.notes ?? const NotesView()));
    // A supervisor's edit (or a restore after reconnect) reaches the field
    // only while the agent is not typing in it; mid-sentence it would move
    // their cursor, so it waits and the "changed elsewhere" line says why.
    ref.listen(stationViewProvider.select((v) => v?.notes.text), (prev, next) {
      if (next != null && next != widget.controller.text && !_focus.hasFocus) {
        widget.controller.value = TextEditingValue(
          text: next,
          selection: TextSelection.collapsed(offset: next.length),
        );
      }
    });

    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final closed = notes.status == NotesStatus.closed;
    final (Color color, FontWeight weight) = switch (notes.status) {
      NotesStatus.retrying => (t.warning, FontWeight.w500),
      NotesStatus.failed => (t.danger, FontWeight.w600),
      NotesStatus.saved => (t.success, FontWeight.w400),
      _ => (t.textMuted, FontWeight.w400),
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: Space.sm,
          children: [
            Text(widget.required ? StationCopy.notesRequired : StationCopy.notes, style: text.labelMedium),
            Semantics(
              liveRegion: notes.status == NotesStatus.failed || notes.status == NotesStatus.retrying,
              child: Text(
                StationCopy.notesStatus(notes.status),
                key: const Key('notes-status'),
                style: text.labelSmall!.copyWith(color: color, fontWeight: weight),
              ),
            ),
          ],
        ),
        const SizedBox(height: Space.xs),
        Semantics(
          label: widget.required ? StationCopy.notesRequired : StationCopy.notes,
          child: TextField(
            key: const Key('notes-field'),
            controller: widget.controller,
            focusNode: _focus,
            enabled: !closed,
            minLines: 3,
            maxLines: 6,
            keyboardType: TextInputType.multiline,
            textCapitalization: TextCapitalization.sentences,
            onChanged: (value) => ref.read(stationActionsProvider).updateNotes(value),
            decoration: InputDecoration(
              hintText: StationCopy.notesHint,
              enabledBorder: widget.required && widget.controller.text.trim().isEmpty
                  ? OutlineInputBorder(
                      borderRadius: BorderRadius.circular(Radii.sm),
                      borderSide: BorderSide(color: t.warning),
                    )
                  : null,
            ),
          ),
        ),
        if (notes.changedElsewhere) ...[
          const SizedBox(height: Space.xs),
          Text(
            StationCopy.notesChangedElsewhere,
            key: const Key('notes-elsewhere'),
            style: text.labelSmall!.copyWith(color: t.warning),
          ),
        ],
      ],
    );
  }
}
