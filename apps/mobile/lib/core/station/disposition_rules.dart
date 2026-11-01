import 'package:agency_wire/agency_wire.dart';

import 'station_copy.dart';

/// The disposition form's rules (port of `agencyDispositionForm.ts`) and the
/// catalog re-sync (`agencyCatalogSync.ts`). The server enforces all of this;
/// the app checks first so an agent is never left pressing a button that will fail.

Disposition? findDisposition(List<Disposition> catalog, String? code) {
  if (code == null) return null;
  for (final d in catalog) {
    if (d.code == code) return d;
  }
  return null;
}

/// Why the form cannot be saved yet, or null when it can.
DispositionBlock? dispositionBlock(
  List<Disposition> catalog, {
  required String? code,
  required String notes,
  required DateTime? callbackAt,
  required DateTime now,
}) {
  final entry = findDisposition(catalog, code);
  if (entry == null) return DispositionBlock.noSelection;
  if (entry.noteRequired && notes.trim().isEmpty) return DispositionBlock.noteRequired;
  if (entry.datetimeRequired) {
    if (callbackAt == null) return DispositionBlock.datetimeRequired;
    if (!callbackAt.isAfter(now)) return DispositionBlock.callbackInPast;
  }
  return null;
}

/// The request for a valid form, or null. Notes are trimmed and sent only when
/// non-empty; `callback_at` only for an outcome that asks for one.
DispositionRequest? buildDispositionRequest(
  List<Disposition> catalog, {
  required String code,
  required String notes,
  required DateTime? callbackAt,
  required DateTime now,
}) {
  if (dispositionBlock(catalog, code: code, notes: notes, callbackAt: callbackAt, now: now) != null) return null;
  final trimmed = notes.trim();
  final entry = findDisposition(catalog, code)!;
  return DispositionRequest(
    dispositionCode: code,
    notes: trimmed.isEmpty ? null : trimmed,
    callbackAt: entry.datetimeRequired ? callbackAt : null,
  );
}

/// Rebuilds a catalog from the server's `allowed_codes`: their order, known
/// entries kept as they are, unknown codes given readable labels, duplicates
/// dropped. Lets a stale catalog recover in one round trip mid-shift.
List<T> resyncCatalog<T>(
  List<T> current,
  List<String> allowedCodes, {
  required String Function(T entry) codeOf,
  required T Function(String code, String label) make,
}) {
  final known = {for (final e in current) codeOf(e): e};
  final seen = <String>{};
  final next = <T>[];
  for (final code in allowedCodes) {
    if (code.isEmpty || !seen.add(code)) continue;
    next.add(known[code] ?? make(code, humaniseCode(code)));
  }
  return List.unmodifiable(next);
}

List<Disposition> resyncDispositions(List<Disposition> current, List<String> allowed) => resyncCatalog(
      current,
      allowed,
      codeOf: (d) => d.code,
      make: (code, label) => Disposition(code: code, label: label),
    );

List<BreakReason> resyncBreakReasons(List<BreakReason> current, List<String> allowed) => resyncCatalog(
      current,
      allowed,
      codeOf: (b) => b.code,
      make: (code, label) => BreakReason(code: code, label: label),
    );
