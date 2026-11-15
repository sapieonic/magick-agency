-- 0043_recording_honours_request.sql — Insights recounts "recorded" without the recordings a
-- call did not ask for (RC1).
--
-- From this release a call that did not ask for a recording (`agency_calls.recording_requested`
-- false: recording off for its campaign, soft phone or inbound route, or `allow_recording` off
-- for its account) has none: the bridge discards a recording URL the carrier sends for it, the
-- repository refuses to store one, and every read takes the URL only when the call asked for it
-- (`recordingUrlSql` / `hasRecordingSql` / `honourRecordingRequest` in
-- `agency-call.repository.ts`). Rows written before it may still hold such a URL (VoiceLink is
-- never told whether to record and posts one anyway); they now read as "not recorded" in the
-- call detail, playback, analysis, customer history and reports, at read time.
--
-- The Insights rollup is the one reader that stored the old answer: its `recorded_connected`
-- counted those calls. This migration marks the bucket of every attempt whose call holds a URL it
-- did not ask for, so the rollup job recomputes it with the new rule (recompute, never increment:
-- 0012's header). Nothing else is written: the URLs stay on the rows. Nulling them is an opt-in
-- step for operators (`docs/operations.md` "Recordings a call did not ask for"), and the audio
-- itself stays at the carrier.
--
-- ── Cost ──────────────────────────────────────────────────────────────────────
-- One read of agency_calls (no index covers `recording_url IS NOT NULL AND NOT
-- recording_requested`; the planner scans it) joined to the attempts by `idx_agency_attempts_webrtc`,
-- and one insert per affected bucket into agency_insights_rollup_dirty. No lock beyond the
-- read's and the insert's; the server is stopped while migrations run.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Nothing to undo: the marks are work the rollup job consumes, and a recompute is idempotent.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
SELECT DISTINCT a.campaign_id, agency_insights_bucket(a.dialed_at)
  FROM agency_calls k
  JOIN agency_call_attempts a ON a.webrtc_call_id = k.id
 WHERE k.recording_url IS NOT NULL
   AND NOT k.recording_requested
   AND a.dialed_at IS NOT NULL;

-- Down Migration

-- The marks are consumed by the rollup job; a recompute is idempotent, so there is nothing to undo.
SELECT 1;
