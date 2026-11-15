/*
 * The one predicate for "this call has a recording" (RC1), in the two spellings its readers need:
 * SQL fragments for statements that read `agency_calls` themselves, and a row function for the
 * repository's returned rows. A leaf with no imports, so a module can build its SQL from it at
 * load time and a test that mocks the call repository still gets the real thing.
 */

/*
 * ─── A call that did not ask for a recording has none (RC1) ─────────────────
 *
 * `recording_requested` is decided once, at dial or arrival (the campaign's, the soft
 * phone's or the inbound route's `record_calls`, under the account's `allow_recording`).
 * A carrier may record anyway (VoiceLink is never told: its `add_lead` has no recording
 * field) and post a `recordingUrl`. That recording is not ours to keep or show:
 *
 *  - WRITE: `WebRtcCallRepository.update` (`repositories/agency-call.repository.ts`) stores
 *    a `recording_url` only on a row that asked for one (the bridge discards it first, logged
 *    and counted; this is the backstop for every other writer).
 *  - READ: every row that repository returns has `recording_url` (and its duration)
 *    nulled unless `recording_requested` ({@link honourRecordingRequest}), and raw SQL
 *    elsewhere reads it through {@link recordingUrlSql} / {@link hasRecordingSql}. So a
 *    row written before RC1 with a link it never asked for reads as "not recorded"
 *    everywhere (detail, playback, analysis, customer history, Insights, reports)
 *    without deleting anything (`docs/operations.md` "Recordings a call did not ask for").
 *
 * One predicate, three spellings of it: these two SQL helpers and the TS function.
 */

/** SQL: the call's recording URL when it asked for one, else NULL. `alias` is the `agency_calls` alias. */
export function recordingUrlSql(alias: string): string {
  return `(CASE WHEN ${alias}.recording_requested THEN ${alias}.recording_url END)`;
}

/** SQL: true when the call asked for a recording and has one. `alias` is the `agency_calls` alias. */
export function hasRecordingSql(alias: string): string {
  return `(${alias}.recording_requested AND ${alias}.recording_url IS NOT NULL)`;
}

/**
 * A call row as every reader sees it: `recording_url` and `recording_duration_seconds`
 * nulled unless the call asked for a recording. Returns a new object only when it changes one.
 */
export function honourRecordingRequest<T extends {
  recording_requested: boolean;
  recording_url: string | null;
  recording_duration_seconds?: number | null;
}>(row: T): T {
  if (row.recording_requested === true) return row;
  if (row.recording_url == null && row.recording_duration_seconds == null) return row;
  return {
    ...row,
    recording_url: null,
    ...(row.recording_duration_seconds !== undefined ? { recording_duration_seconds: null } : {}),
  };
}
