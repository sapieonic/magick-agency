import 'package:magick_agency_agent/core/station/notes_autosave.dart';

/// A [NotesStore] in memory, for tests.
final class MemoryNotesStore implements NotesStore {
  final Map<String, ({String notes, DateTime at})> entries = {};

  @override
  Future<String?> read(String attemptId) async => entries[attemptId]?.notes;

  @override
  Future<void> write(String attemptId, String notes, DateTime at) async => entries[attemptId] = (notes: notes, at: at);

  @override
  Future<void> sweep(DateTime now, {Duration maxAge = const Duration(hours: 24)}) async =>
      entries.removeWhere((_, v) => now.difference(v.at) >= maxAge);
}
