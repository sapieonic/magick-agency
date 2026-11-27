import type { AgencyTeamPerformance } from '@magick-agency/contracts/api/agency/team-performance';

/**
 * Team performance answers recorded from the real route (`GET /proxy/agency/team-performance`, the
 * server over a seeded Postgres, 2026-11-27), kept exactly as the server sent them. The seed is the
 * server's integration test's (`apps/server/test/integration/api/team-performance.test.ts`): eight
 * agents of one account over five local days in Asia/Kolkata with a day off, one campaign recording
 * promises (Will pay) and one not, a departed agent, a thin one, soft-phone and inbound promises,
 * and a supervisor's soft-phone promise with no row (TP14).
 *
 * `__tests__/utils/teamAnswer.test.ts` holds these and the hand-made answers of `teamRecorded.ts`
 * to the same rules, so the page's tests run on answers shaped and summed as the real read's.
 */

/** One campaign (promises), comparable, with the seeded gaps and the one who stands out. */
export const TEAM_ROUTE_ONE_CAMPAIGN: AgencyTeamPerformance = {
  campaign_id: "1b1ff810-4dad-4096-a54e-d98a18afafa4",
  from: "2026-11-22",
  to: "2026-11-26",
  timezone: "Asia/Kolkata",
  as_of: "2026-11-27T18:28:59.680Z",
  rollup_as_of: "2026-11-27T18:28:59.564Z",
  main_outcome: {"kind": "promises", "codes": ["will_pay"], "label": "Will pay"},
  totals: {
    agents: 8,
    calls_handled: 231,
    main: {"value": 0.1759656652360515, "numerator": 41, "denominator": 233, "reportable": true, "interval": [0.13244070030666602, 0.23000238401635828], "withheld": null},
    other_conversations: 2,
    avg_call_seconds: 63.077922077922075,
    choose_seconds: 31.87012987012987,
    wrapup_allowed: {"seconds": 30, "varies": false},
    callbacks: {"due": 3, "on_time": 1, "late": 0, "missed": 1, "pending_due": 1, "upcoming": 0},
  },
  medians: {"calls_handled": 32, "main_rate": 0.125, "avg_call_seconds": 63.5, "choose_seconds": 23.875},
  outcomes: [
    {"code": "not_interested", "label": "Not interested", "icon": null, "conversations": 74},
    {"code": "interested", "label": "Interested", "icon": null, "conversations": 53},
    {"code": "will_pay", "label": "Will pay", "icon": null, "conversations": 39},
    {"code": null, "label": null, "icon": null, "conversations": 33},
    {"code": "voicemail", "label": "Voicemail", "icon": null, "conversations": 29},
    {"code": "callback", "label": "Call back", "icon": null, "conversations": 3},
  ],
  trend: {"span": "last_working_days", "dates": ["2026-11-18", "2026-11-22", "2026-11-23", "2026-11-25", "2026-11-26"], "counts": [4, 11, 10, 12, 9]},
  agents: [
    {"agent_user_id": "03dca0ad-056e-4cbf-889a-f72d85f1fb4c", "agent_name": "agent 0.3", "departed": false, "calls_handled": 32, "main": {"value": 0.5, "numerator": 16, "denominator": 32, "reportable": true, "interval": [0.33630614316859386, 0.6636938568314061], "withheld": null}, "talk_seconds": 2016, "avg_call_seconds": 63, "wrapup_seconds": 764, "measured_wrapups": 32, "choose": {"value": 23.875, "numerator": 764, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
    {"agent_user_id": "07a6cad6-d991-4847-8c0c-6d62217f32d6", "agent_name": "agent 0.2", "departed": false, "calls_handled": 34, "main": {"value": 0.17647058823529413, "numerator": 6, "denominator": 34, "reportable": true, "interval": [0.08348855603569685, 0.33514067740052156], "withheld": null}, "talk_seconds": 2108, "avg_call_seconds": 62, "wrapup_seconds": 780, "measured_wrapups": 34, "choose": {"value": 22.941176470588236, "numerator": 780, "denominator": 34, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 122400},
    {"agent_user_id": "1ab34d50-6988-4169-8c10-139ce5742b5c", "agent_name": "agent 0.7", "departed": false, "calls_handled": 5, "main": {"value": 0.2, "numerator": 1, "denominator": 5, "reportable": false, "interval": [0.03622316096978745, 0.6244717358814613], "withheld": "too_few"}, "talk_seconds": 335, "avg_call_seconds": 67, "wrapup_seconds": 138, "measured_wrapups": 5, "choose": {"value": 27.6, "numerator": 138, "denominator": 5, "reportable": false, "interval": null, "withheld": "too_few"}, "break_seconds": 1800, "shift_seconds": 28800},
    {"agent_user_id": "48b0cfb7-b6a4-4c7a-9a7b-700b58e1389c", "agent_name": "agent 0.6", "departed": false, "calls_handled": 32, "main": {"value": 0.125, "numerator": 4, "denominator": 32, "reportable": true, "interval": [0.04970053844474301, 0.2806864978482796], "withheld": null}, "talk_seconds": 2112, "avg_call_seconds": 66, "wrapup_seconds": 2640, "measured_wrapups": 32, "choose": {"value": 82.5, "numerator": 2640, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
    {"agent_user_id": "4dd3a9be-2667-4d7b-bd5b-54adf273957b", "agent_name": "agent 0.0", "departed": false, "calls_handled": 32, "main": {"value": 0.058823529411764705, "numerator": 2, "denominator": 34, "reportable": true, "interval": [0.016282313063842452, 0.1909393688946371], "withheld": null}, "talk_seconds": 1920, "avg_call_seconds": 60, "wrapup_seconds": 720, "measured_wrapups": 32, "choose": {"value": 22.5, "numerator": 720, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
    {"agent_user_id": "6c6455cb-4c2e-4b93-a09c-ed5f3893e729", "agent_name": "agent 0.1", "departed": false, "calls_handled": 32, "main": {"value": 0.125, "numerator": 4, "denominator": 32, "reportable": true, "interval": [0.04970053844474301, 0.2806864978482796], "withheld": null}, "talk_seconds": 1952, "avg_call_seconds": 61, "wrapup_seconds": 708, "measured_wrapups": 32, "choose": {"value": 22.125, "numerator": 708, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
    {"agent_user_id": "9fb3478d-01ee-4549-997a-e30d14ead584", "agent_name": "agent 0.5", "departed": false, "calls_handled": 32, "main": {"value": 0.125, "numerator": 4, "denominator": 32, "reportable": true, "interval": [0.04970053844474301, 0.2806864978482796], "withheld": null}, "talk_seconds": 2080, "avg_call_seconds": 65, "wrapup_seconds": 820, "measured_wrapups": 32, "choose": {"value": 25.625, "numerator": 820, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
    {"agent_user_id": "c791bc27-5ac6-4edd-85f4-d03449b63620", "agent_name": "agent 0.4", "departed": true, "calls_handled": 32, "main": {"value": 0.125, "numerator": 4, "denominator": 32, "reportable": true, "interval": [0.04970053844474301, 0.2806864978482796], "withheld": null}, "talk_seconds": 2048, "avg_call_seconds": 64, "wrapup_seconds": 792, "measured_wrapups": 32, "choose": {"value": 24.75, "numerator": 792, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
  ],
  comparable: true,
  findings: [
    {"baseline": 0.19597989949748743, "interval": [0.016282313063842452, 0.1909393688946371], "ratio": null, "count": 34, "next_step": "listen_recent", "agent_user_id": "4dd3a9be-2667-4d7b-bd5b-54adf273957b", "metric": "promises_rate", "value": 0.058823529411764705, "code": "clear_gap"},
    {"baseline": 23.875, "interval": null, "ratio": 3.4554973821989527, "count": 32, "next_step": "message_outcome_tip", "code": "clear_gap", "agent_user_id": "48b0cfb7-b6a4-4c7a-9a7b-700b58e1389c", "metric": "choose_time", "value": 82.5},
    {"baseline": 0.12437810945273632, "interval": [0.33630614316859386, 0.6636938568314061], "ratio": null, "count": 32, "next_step": "share_best_call", "agent_user_id": "03dca0ad-056e-4cbf-889a-f72d85f1fb4c", "metric": "promises_rate", "value": 0.5, "code": "stands_out"},
  ],
};

/** All campaigns: a mixed scope (promises), not comparable, allowed time differing by campaign. */
export const TEAM_ROUTE_ALL_CAMPAIGNS: AgencyTeamPerformance = {
  campaign_id: null,
  from: "2026-11-22",
  to: "2026-11-26",
  timezone: "Asia/Kolkata",
  as_of: "2026-11-27T18:28:59.858Z",
  rollup_as_of: "2026-11-27T18:28:59.564Z",
  main_outcome: {"kind": "promises", "codes": ["will_pay"], "label": "Will pay"},
  totals: {
    agents: 8,
    calls_handled: 243,
    main: {"value": 0.1673469387755102, "numerator": 41, "denominator": 245, "reportable": true, "interval": [0.12581845961468804, 0.21914636941711377], "withheld": null},
    other_conversations: 2,
    avg_call_seconds: 62.4320987654321,
    choose_seconds: 31.530864197530864,
    wrapup_allowed: {"seconds": null, "varies": true},
    callbacks: {"due": 3, "on_time": 1, "late": 0, "missed": 1, "pending_due": 1, "upcoming": 0},
  },
  medians: {"calls_handled": 32, "main_rate": 0.125, "avg_call_seconds": 62.815789473684205, "choose_seconds": 23.875},
  outcomes: [
    {"code": "not_interested", "label": "Not interested", "icon": null, "conversations": 78},
    {"code": "interested", "label": "Interested", "icon": null, "conversations": 59},
    {"code": "will_pay", "label": "Will pay", "icon": null, "conversations": 39},
    {"code": null, "label": null, "icon": null, "conversations": 33},
    {"code": "voicemail", "label": "Voicemail", "icon": null, "conversations": 31},
    {"code": "callback", "label": "Call back", "icon": null, "conversations": 3},
  ],
  trend: {"span": "last_working_days", "dates": ["2026-11-18", "2026-11-22", "2026-11-23", "2026-11-25", "2026-11-26"], "counts": [4, 11, 10, 12, 9]},
  agents: [
    {"agent_user_id": "03dca0ad-056e-4cbf-889a-f72d85f1fb4c", "agent_name": "agent 0.3", "departed": false, "calls_handled": 32, "main": {"value": 0.5, "numerator": 16, "denominator": 32, "reportable": true, "interval": [0.33630614316859386, 0.6636938568314061], "withheld": null}, "talk_seconds": 2016, "avg_call_seconds": 63, "wrapup_seconds": 764, "measured_wrapups": 32, "choose": {"value": 23.875, "numerator": 764, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
    {"agent_user_id": "07a6cad6-d991-4847-8c0c-6d62217f32d6", "agent_name": "agent 0.2", "departed": false, "calls_handled": 34, "main": {"value": 0.17647058823529413, "numerator": 6, "denominator": 34, "reportable": true, "interval": [0.08348855603569685, 0.33514067740052156], "withheld": null}, "talk_seconds": 2108, "avg_call_seconds": 62, "wrapup_seconds": 780, "measured_wrapups": 34, "choose": {"value": 22.941176470588236, "numerator": 780, "denominator": 34, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 122400},
    {"agent_user_id": "1ab34d50-6988-4169-8c10-139ce5742b5c", "agent_name": "agent 0.7", "departed": false, "calls_handled": 5, "main": {"value": 0.2, "numerator": 1, "denominator": 5, "reportable": false, "interval": [0.03622316096978745, 0.6244717358814613], "withheld": "too_few"}, "talk_seconds": 335, "avg_call_seconds": 67, "wrapup_seconds": 138, "measured_wrapups": 5, "choose": {"value": 27.6, "numerator": 138, "denominator": 5, "reportable": false, "interval": null, "withheld": "too_few"}, "break_seconds": 1800, "shift_seconds": 28800},
    {"agent_user_id": "48b0cfb7-b6a4-4c7a-9a7b-700b58e1389c", "agent_name": "agent 0.6", "departed": false, "calls_handled": 32, "main": {"value": 0.125, "numerator": 4, "denominator": 32, "reportable": true, "interval": [0.04970053844474301, 0.2806864978482796], "withheld": null}, "talk_seconds": 2112, "avg_call_seconds": 66, "wrapup_seconds": 2640, "measured_wrapups": 32, "choose": {"value": 82.5, "numerator": 2640, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
    {"agent_user_id": "4dd3a9be-2667-4d7b-bd5b-54adf273957b", "agent_name": "agent 0.0", "departed": false, "calls_handled": 32, "main": {"value": 0.058823529411764705, "numerator": 2, "denominator": 34, "reportable": true, "interval": [0.016282313063842452, 0.1909393688946371], "withheld": null}, "talk_seconds": 1920, "avg_call_seconds": 60, "wrapup_seconds": 720, "measured_wrapups": 32, "choose": {"value": 22.5, "numerator": 720, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
    {"agent_user_id": "6c6455cb-4c2e-4b93-a09c-ed5f3893e729", "agent_name": "agent 0.1", "departed": false, "calls_handled": 38, "main": {"value": 0.10526315789473684, "numerator": 4, "denominator": 38, "reportable": true, "interval": [0.041701897932665793, 0.24130831200194466], "withheld": null}, "talk_seconds": 2252, "avg_call_seconds": 59.26315789473684, "wrapup_seconds": 858, "measured_wrapups": 38, "choose": {"value": 22.57894736842105, "numerator": 858, "denominator": 38, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 122400},
    {"agent_user_id": "9fb3478d-01ee-4549-997a-e30d14ead584", "agent_name": "agent 0.5", "departed": false, "calls_handled": 38, "main": {"value": 0.10526315789473684, "numerator": 4, "denominator": 38, "reportable": true, "interval": [0.041701897932665793, 0.24130831200194466], "withheld": null}, "talk_seconds": 2380, "avg_call_seconds": 62.63157894736842, "wrapup_seconds": 970, "measured_wrapups": 38, "choose": {"value": 25.526315789473685, "numerator": 970, "denominator": 38, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 122400},
    {"agent_user_id": "c791bc27-5ac6-4edd-85f4-d03449b63620", "agent_name": "agent 0.4", "departed": true, "calls_handled": 32, "main": {"value": 0.125, "numerator": 4, "denominator": 32, "reportable": true, "interval": [0.04970053844474301, 0.2806864978482796], "withheld": null}, "talk_seconds": 2048, "avg_call_seconds": 64, "wrapup_seconds": 792, "measured_wrapups": 32, "choose": {"value": 24.75, "numerator": 792, "denominator": 32, "reportable": true, "interval": null, "withheld": null}, "break_seconds": 7200, "shift_seconds": 115200},
  ],
  comparable: false,
  findings: [],
};
