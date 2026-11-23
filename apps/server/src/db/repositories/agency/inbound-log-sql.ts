/**
 * The inbound call as a row of a call list: one SELECT list for the campaign Call log's inbound
 * branch (`attempt.repository.ts`: the Call log, All calls, My calls, the inbound Call page) and
 * the customer history's inbound rows (`customer-history.repository.ts`, CL39), so an inbound
 * call's facts mean one thing on every list. A leaf: it imports nothing from this folder (a
 * repository file may not import a sibling repository file).
 */

/**
 * The call log's inbound branch, column for column with `ATTEMPT_ROW_SELECT_SQL` and the
 * soft-phone branch (NULL where an inbound call has no such thing), `arrived_at` as the list's
 * `created_at`. What only an inbound call has is one JSON object (`extra`, read by
 * `projectInboundLogRow`): how it came by the campaign, the route, the wait (arrival to the
 * agent's answer, else to the end: on a missed call that includes a voicemail, since nothing
 * records when the wait gave way to its prompt), whether it queued, whether the agent who answered is the
 * caller's sticky agent, the voicemail while the row names one, the Missed row, and the latest
 * soft-phone call DIALLED from its Call back (`idx_agency_manual_calls_callback_of`). Names the
 * inbound call `i`.
 */
export const INBOUND_LOG_SELECT_SQL = `'inbound'::text AS source, i.id, i.campaign_id, i.matched_contact_id AS contact_id,
               NULL::int AS attempt_number, i.from_e164 AS phone_e164, i.to_e164 AS caller_id,
               i.answered_by_user_id AS agent_user_id, NULL::uuid AS reserved_agent_id, i.state, i.outcome,
               i.disposition_code, NULL::varchar AS auto_disposition_code, i.notes, i.callback_at,
               i.promise_date::text AS promise_date, i.promise_amount,
               i.dispositioned_by_user_id, i.dispositioned_at, i.dispositioned_on_behalf,
               i.webrtc_call_id, NULL::timestamptz AS dialed_at, i.answered_at, i.bridged_at, i.ended_at,
               i.talk_seconds, NULL::int AS wrapup_seconds, NULL::uuid AS redial_of_attempt_id,
               NULL::int AS redial_number, i.arrived_at AS created_at,
               false AS dnc_overridden, false AS hours_overridden, i.settled_at,
               jsonb_build_object(
                 'campaign_source', i.campaign_source,
                 'route_name', (SELECT r.name FROM agency_inbound_routes r WHERE r.id = i.route_id),
                 'wait_seconds', GREATEST(0, floor(extract(epoch FROM
                   (COALESCE(i.bridged_at, i.ended_at, i.arrived_at) - i.arrived_at))))::int,
                 'queued', i.queued_at IS NOT NULL,
                 'via_sticky_agent', i.sticky_user_id IS NOT NULL AND i.sticky_user_id = i.answered_by_user_id,
                 'voicemail_seconds', CASE WHEN i.voicemail_key IS NOT NULL THEN i.voicemail_seconds END,
                 'follow_up_status', i.follow_up_status,
                 'follow_up_reason', i.follow_up_reason,
                 'closed_cause', i.closed_cause,
                 'assignee_user_id', i.follow_up_assignee_user_id,
                 'handled_reason', i.handled_reason,
                 'handled_at', i.handled_at,
                 'called_back', (SELECT jsonb_build_object('call_id', cb.id, 'at', cb.created_at)
                                   FROM agency_manual_calls cb
                                  WHERE cb.callback_of_inbound_call_id = i.id AND cb.tenant_id = i.tenant_id
                                    AND cb.dialed_at IS NOT NULL
                                  ORDER BY cb.created_at DESC, cb.id DESC LIMIT 1)
               ) AS extra`;
