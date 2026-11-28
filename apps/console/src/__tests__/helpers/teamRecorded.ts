import type { AgencyTeamPerformance } from '@magick-agency/contracts/api/agency/team-performance';

/**
 * Team performance answers for the console's tests (`docs/team-performance.md`), in the exact
 * shape of `GET /proxy/agency/team-performance`. Built ahead of the server (chunk C was built
 * beside chunk B): every row, total, median and finding was worked out by the shared rules the
 * server's assembly uses (`compareValue`, `cohortPercentiles` and `compareFindings` of
 * `@magick-agency/domain/agent-compare`) over one campaign's ten agents, so the figures agree
 * with each other as the real read's do. Kept at D beside the answers recorded from the real route
 * (`teamRouteRecorded.ts`): `utils/teamAnswer.test.ts` holds both to the server's rules.
 *
 * - {@link TEAM_ONE_CAMPAIGN}: one campaign, Today in Asia/Kolkata, promises labelled "Will pay";
 *   a gap on Mahesh B's rate and on his time to choose an outcome, Lakshmi P standing out; Pooja M
 *   has left and, with Farhan A, is under the floor of 20 calls.
 * - {@link TEAM_ALL_CAMPAIGNS}: every campaign over a week: not comparable, no findings, the label
 *   left to the console (two promise codes), a campaign worked that records no promises (`mixed`),
 *   12 soft-phone and inbound calls in the rate, allowed time differing by campaign, ten outcomes
 *   (three past the seventh, folded).
 */

export const TEAM_ONE_CAMPAIGN: AgencyTeamPerformance = {
  campaign_id: 'be5fd3d1-bb78-4395-aeb5-2c59ea873338',
  from: '2026-11-17',
  to: '2026-11-17',
  timezone: 'Asia/Kolkata',
  as_of: '2026-11-17T08:45:12.000Z',
  rollup_as_of: '2026-11-17T08:40:00.000Z',
  main_outcome: {
    kind: 'promises',
    codes: [
      'will_pay'
    ],
    label: 'Will pay',
    mixed: false,
    bar_conversations: 96
  },
  totals: {
    agents: 10,
    calls_handled: 360,
    main: {
      value: 0.2722222222222222,
      numerator: 98,
      denominator: 360,
      reportable: true,
      interval: [
        0.2288277076456753,
        0.32042669317050393
      ],
      withheld: null
    },
    other_conversations: 0,
    avg_call_seconds: 176.54166666666666,
    choose_seconds: 19.150724637681158,
    wrapup_allowed: {
      seconds: 30,
      varies: false
    },
    callbacks: {
      due: 28,
      on_time: 21,
      late: 4,
      missed: 1,
      pending_due: 2,
      upcoming: 6
    }
  },
  medians: {
    calls_handled: 39,
    main_rate: 0.2763888888888889,
    avg_call_seconds: 177.5,
    choose_seconds: 18.5
  },
  outcomes: [
    {
      code: 'will_pay',
      label: 'Will pay',
      icon: 'rupee',
      conversations: 96
    },
    {
      code: 'no_one_spoke',
      label: 'No one spoke',
      icon: 'phone_missed',
      conversations: 88
    },
    {
      code: 'call_later',
      label: 'Call later',
      icon: 'clock',
      conversations: 71
    },
    {
      code: 'refused',
      label: 'Refused',
      icon: 'thumbs_down',
      conversations: 54
    },
    {
      code: 'wrong_number',
      label: 'Wrong number',
      icon: 'wrong_number',
      conversations: 31
    },
    {
      code: 'dnc',
      label: 'Don’t call again',
      icon: 'stop',
      conversations: 20
    }
  ],
  trend: {
    span: 'last_working_days',
    dates: [
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-16',
      '2026-11-17'
    ],
    counts: [
      86,
      95,
      87,
      106,
      74,
      95,
      98
    ]
  },
  agents: [
    {
      agent_user_id: 'a1b2c3d4-0001-4000-8000-000000000001',
      agent_name: 'Lakshmi P',
      departed: false,
      calls_handled: 51,
      main: {
        value: 0.47058823529411764,
        numerator: 24,
        denominator: 51,
        reportable: true,
        interval: [
          0.34052771426416406,
          0.6047692865527341
        ],
        withheld: null
      },
      talk_seconds: 7650,
      avg_call_seconds: 150,
      wrapup_seconds: 700,
      measured_wrapups: 50,
      choose: {
        value: 14,
        numerator: 700,
        denominator: 50,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1080,
      shift_seconds: 19800
    },
    {
      agent_user_id: 'a1b2c3d4-0002-4000-8000-000000000002',
      agent_name: 'Swapna K',
      departed: false,
      calls_handled: 47,
      main: {
        value: 0.2978723404255319,
        numerator: 14,
        denominator: 47,
        reportable: true,
        interval: [
          0.18651084151016262,
          0.439779440463654
        ],
        withheld: null
      },
      talk_seconds: 7990,
      avg_call_seconds: 170,
      wrapup_seconds: 675,
      measured_wrapups: 45,
      choose: {
        value: 15,
        numerator: 675,
        denominator: 45,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 900,
      shift_seconds: 19200
    },
    {
      agent_user_id: 'a1b2c3d4-0003-4000-8000-000000000003',
      agent_name: 'Ravi Kumar',
      departed: false,
      calls_handled: 42,
      main: {
        value: 0.2857142857142857,
        numerator: 12,
        denominator: 42,
        reportable: true,
        interval: [
          0.1716685874457567,
          0.43567496077245566
        ],
        withheld: null
      },
      talk_seconds: 6720,
      avg_call_seconds: 160,
      wrapup_seconds: 720,
      measured_wrapups: 40,
      choose: {
        value: 18,
        numerator: 720,
        denominator: 40,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1200,
      shift_seconds: 18600
    },
    {
      agent_user_id: 'a1b2c3d4-0004-4000-8000-000000000004',
      agent_name: 'Kiran J',
      departed: false,
      calls_handled: 36,
      main: {
        value: 0.2777777777777778,
        numerator: 10,
        denominator: 36,
        reportable: true,
        interval: [
          0.15848170025813796,
          0.43992800216345146
        ],
        withheld: null
      },
      talk_seconds: 7200,
      avg_call_seconds: 200,
      wrapup_seconds: 665,
      measured_wrapups: 35,
      choose: {
        value: 19,
        numerator: 665,
        denominator: 35,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1260,
      shift_seconds: 18000
    },
    {
      agent_user_id: 'a1b2c3d4-0005-4000-8000-000000000005',
      agent_name: 'Divya S',
      departed: false,
      calls_handled: 40,
      main: {
        value: 0.275,
        numerator: 11,
        denominator: 40,
        reportable: true,
        interval: [
          0.1610785343314309,
          0.4283525083312457
        ],
        withheld: null
      },
      talk_seconds: 7400,
      avg_call_seconds: 185,
      wrapup_seconds: 836,
      measured_wrapups: 38,
      choose: {
        value: 22,
        numerator: 836,
        denominator: 38,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1320,
      shift_seconds: 19500
    },
    {
      agent_user_id: 'a1b2c3d4-0006-4000-8000-000000000006',
      agent_name: 'Arjun T',
      departed: false,
      calls_handled: 44,
      main: {
        value: 0.2727272727272727,
        numerator: 12,
        denominator: 44,
        reportable: true,
        interval: [
          0.16346223395491324,
          0.41849154685509304
        ],
        withheld: null
      },
      talk_seconds: 7260,
      avg_call_seconds: 165,
      wrapup_seconds: 840,
      measured_wrapups: 42,
      choose: {
        value: 20,
        numerator: 840,
        denominator: 42,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 960,
      shift_seconds: 18900
    },
    {
      agent_user_id: 'a1b2c3d4-0007-4000-8000-000000000007',
      agent_name: 'Sandeep R',
      departed: false,
      calls_handled: 33,
      main: {
        value: 0.2727272727272727,
        numerator: 9,
        denominator: 33,
        reportable: true,
        interval: [
          0.15067272656322814,
          0.44217883254386814
        ],
        withheld: null
      },
      talk_seconds: 5775,
      avg_call_seconds: 175,
      wrapup_seconds: 527,
      measured_wrapups: 31,
      choose: {
        value: 17,
        numerator: 527,
        denominator: 31,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 2280,
      shift_seconds: 17400
    },
    {
      agent_user_id: 'a1b2c3d4-0008-4000-8000-000000000008',
      agent_name: 'Mahesh B',
      departed: false,
      calls_handled: 38,
      main: {
        value: 0.05263157894736842,
        numerator: 2,
        denominator: 38,
        reportable: true,
        interval: [
          0.014553902448536798,
          0.17285766881068843
        ],
        withheld: null
      },
      talk_seconds: 8170,
      avg_call_seconds: 215,
      wrapup_seconds: 1008,
      measured_wrapups: 36,
      choose: {
        value: 28,
        numerator: 1008,
        denominator: 36,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1500,
      shift_seconds: 18300
    },
    {
      agent_user_id: 'a1b2c3d4-0009-4000-8000-000000000009',
      agent_name: 'Pooja M',
      departed: true,
      calls_handled: 17,
      main: {
        value: 0.11764705882352941,
        numerator: 2,
        denominator: 17,
        reportable: false,
        interval: [
          0.03287908001292092,
          0.3433684249770991
        ],
        withheld: 'too_few'
      },
      talk_seconds: 3230,
      avg_call_seconds: 190,
      wrapup_seconds: 384,
      measured_wrapups: 16,
      choose: {
        value: 24,
        numerator: 384,
        denominator: 16,
        reportable: false,
        interval: null,
        withheld: 'too_few'
      },
      break_seconds: 1380,
      shift_seconds: 9000
    },
    {
      agent_user_id: 'a1b2c3d4-0010-4000-8000-000000000010',
      agent_name: 'Farhan A',
      departed: false,
      calls_handled: 12,
      main: {
        value: 0.16666666666666666,
        numerator: 2,
        denominator: 12,
        reportable: false,
        interval: [
          0.04696414761482223,
          0.44803635738467273
        ],
        withheld: 'too_few'
      },
      talk_seconds: 2160,
      avg_call_seconds: 180,
      wrapup_seconds: 252,
      measured_wrapups: 12,
      choose: {
        value: 21,
        numerator: 252,
        denominator: 12,
        reportable: false,
        interval: null,
        withheld: 'too_few'
      },
      break_seconds: 600,
      shift_seconds: 5400
    }
  ],
  comparable: true,
  findings: [
    {
      baseline: 0.2981366459627329,
      interval: [
        0.014553902448536798,
        0.17285766881068843
      ],
      ratio: null,
      count: 38,
      next_step: 'listen_recent',
      agent_user_id: 'a1b2c3d4-0008-4000-8000-000000000008',
      metric: 'promises_rate',
      value: 0.05263157894736842,
      code: 'clear_gap'
    },
    {
      baseline: 18.5,
      interval: null,
      ratio: 1.5135135135135136,
      count: 36,
      next_step: 'message_outcome_tip',
      code: 'clear_gap',
      agent_user_id: 'a1b2c3d4-0008-4000-8000-000000000008',
      metric: 'choose_time',
      value: 28
    },
    {
      baseline: 0.23948220064724918,
      interval: [
        0.34052771426416406,
        0.6047692865527341
      ],
      ratio: null,
      count: 51,
      next_step: 'share_best_call',
      agent_user_id: 'a1b2c3d4-0001-4000-8000-000000000001',
      metric: 'promises_rate',
      value: 0.47058823529411764,
      code: 'stands_out'
    }
  ]
};

export const TEAM_ALL_CAMPAIGNS: AgencyTeamPerformance = {
  campaign_id: null,
  from: '2026-11-11',
  to: '2026-11-17',
  timezone: 'Asia/Kolkata',
  as_of: '2026-11-17T08:45:12.000Z',
  rollup_as_of: '2026-11-17T08:38:00.000Z',
  main_outcome: {
    kind: 'promises',
    codes: [
      'promise_to_pay',
      'will_pay'
    ],
    label: null,
    mixed: true,
    bar_conversations: 96
  },
  totals: {
    agents: 10,
    calls_handled: 360,
    main: {
      value: 0.26344086021505375,
      numerator: 98,
      denominator: 372,
      reportable: true,
      interval: [
        0.22125846663261275,
        0.3104591505763391
      ],
      withheld: null
    },
    other_conversations: 12,
    avg_call_seconds: 176.54166666666666,
    choose_seconds: 19.150724637681158,
    wrapup_allowed: {
      seconds: null,
      varies: true
    },
    callbacks: {
      due: 41,
      on_time: 33,
      late: 5,
      missed: 1,
      pending_due: 2,
      upcoming: 6
    }
  },
  medians: {
    calls_handled: 39,
    main_rate: 0.2736185383244207,
    avg_call_seconds: 177.5,
    choose_seconds: 18.5
  },
  outcomes: [
    {
      code: 'no_one_spoke',
      label: 'No one spoke',
      icon: 'phone_missed',
      conversations: 81
    },
    {
      code: 'will_pay',
      label: 'Will pay',
      icon: 'rupee',
      conversations: 74
    },
    {
      code: 'call_later',
      label: 'Call later',
      icon: 'clock',
      conversations: 66
    },
    {
      code: 'refused',
      label: 'Refused',
      icon: 'thumbs_down',
      conversations: 48
    },
    {
      code: 'wrong_number',
      label: 'Wrong number',
      icon: 'wrong_number',
      conversations: 29
    },
    {
      code: 'promise_to_pay',
      label: 'Promise to pay',
      icon: 'check',
      conversations: 22
    },
    {
      code: 'dnc',
      label: 'Don’t call again',
      icon: 'stop',
      conversations: 18
    },
    {
      code: 'language',
      label: 'Other language',
      icon: 'language',
      conversations: 12
    },
    {
      code: 'legacy_paid',
      label: null,
      icon: null,
      conversations: 6
    },
    {
      code: null,
      label: null,
      icon: null,
      conversations: 4
    }
  ],
  trend: {
    span: 'window',
    dates: [
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-16',
      '2026-11-17'
    ],
    counts: [
      95,
      87,
      106,
      74,
      95,
      98
    ]
  },
  agents: [
    {
      agent_user_id: 'a1b2c3d4-0001-4000-8000-000000000001',
      agent_name: 'Lakshmi P',
      departed: false,
      calls_handled: 51,
      main: {
        value: 0.47058823529411764,
        numerator: 24,
        denominator: 51,
        reportable: true,
        interval: [
          0.34052771426416406,
          0.6047692865527341
        ],
        withheld: null
      },
      talk_seconds: 7650,
      avg_call_seconds: 150,
      wrapup_seconds: 700,
      measured_wrapups: 50,
      choose: {
        value: 14,
        numerator: 700,
        denominator: 50,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1080,
      shift_seconds: 19800
    },
    {
      agent_user_id: 'a1b2c3d4-0002-4000-8000-000000000002',
      agent_name: 'Swapna K',
      departed: false,
      calls_handled: 47,
      main: {
        value: 0.27450980392156865,
        numerator: 14,
        denominator: 51,
        reportable: true,
        interval: [
          0.1711412201054317,
          0.4094691194907873
        ],
        withheld: null
      },
      talk_seconds: 7990,
      avg_call_seconds: 170,
      wrapup_seconds: 675,
      measured_wrapups: 45,
      choose: {
        value: 15,
        numerator: 675,
        denominator: 45,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 900,
      shift_seconds: 19200
    },
    {
      agent_user_id: 'a1b2c3d4-0003-4000-8000-000000000003',
      agent_name: 'Ravi Kumar',
      departed: false,
      calls_handled: 42,
      main: {
        value: 0.2857142857142857,
        numerator: 12,
        denominator: 42,
        reportable: true,
        interval: [
          0.1716685874457567,
          0.43567496077245566
        ],
        withheld: null
      },
      talk_seconds: 6720,
      avg_call_seconds: 160,
      wrapup_seconds: 720,
      measured_wrapups: 40,
      choose: {
        value: 18,
        numerator: 720,
        denominator: 40,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1200,
      shift_seconds: 18600
    },
    {
      agent_user_id: 'a1b2c3d4-0004-4000-8000-000000000004',
      agent_name: 'Kiran J',
      departed: false,
      calls_handled: 36,
      main: {
        value: 0.2564102564102564,
        numerator: 10,
        denominator: 39,
        reportable: true,
        interval: [
          0.14568625843452188,
          0.410819567678415
        ],
        withheld: null
      },
      talk_seconds: 7200,
      avg_call_seconds: 200,
      wrapup_seconds: 665,
      measured_wrapups: 35,
      choose: {
        value: 19,
        numerator: 665,
        denominator: 35,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1260,
      shift_seconds: 18000
    },
    {
      agent_user_id: 'a1b2c3d4-0005-4000-8000-000000000005',
      agent_name: 'Divya S',
      departed: false,
      calls_handled: 40,
      main: {
        value: 0.275,
        numerator: 11,
        denominator: 40,
        reportable: true,
        interval: [
          0.1610785343314309,
          0.4283525083312457
        ],
        withheld: null
      },
      talk_seconds: 7400,
      avg_call_seconds: 185,
      wrapup_seconds: 836,
      measured_wrapups: 38,
      choose: {
        value: 22,
        numerator: 836,
        denominator: 38,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1320,
      shift_seconds: 19500
    },
    {
      agent_user_id: 'a1b2c3d4-0006-4000-8000-000000000006',
      agent_name: 'Arjun T',
      departed: false,
      calls_handled: 44,
      main: {
        value: 0.2608695652173913,
        numerator: 12,
        denominator: 46,
        reportable: true,
        interval: [
          0.15600735194449333,
          0.402594298082793
        ],
        withheld: null
      },
      talk_seconds: 7260,
      avg_call_seconds: 165,
      wrapup_seconds: 840,
      measured_wrapups: 42,
      choose: {
        value: 20,
        numerator: 840,
        denominator: 42,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 960,
      shift_seconds: 18900
    },
    {
      agent_user_id: 'a1b2c3d4-0007-4000-8000-000000000007',
      agent_name: 'Sandeep R',
      departed: false,
      calls_handled: 33,
      main: {
        value: 0.2727272727272727,
        numerator: 9,
        denominator: 33,
        reportable: true,
        interval: [
          0.15067272656322814,
          0.44217883254386814
        ],
        withheld: null
      },
      talk_seconds: 5775,
      avg_call_seconds: 175,
      wrapup_seconds: 527,
      measured_wrapups: 31,
      choose: {
        value: 17,
        numerator: 527,
        denominator: 31,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 2280,
      shift_seconds: 17400
    },
    {
      agent_user_id: 'a1b2c3d4-0008-4000-8000-000000000008',
      agent_name: 'Mahesh B',
      departed: false,
      calls_handled: 38,
      main: {
        value: 0.04878048780487805,
        numerator: 2,
        denominator: 41,
        reportable: true,
        interval: [
          0.013480662282573552,
          0.16139266962351367
        ],
        withheld: null
      },
      talk_seconds: 8170,
      avg_call_seconds: 215,
      wrapup_seconds: 1008,
      measured_wrapups: 36,
      choose: {
        value: 28,
        numerator: 1008,
        denominator: 36,
        reportable: true,
        interval: null,
        withheld: null
      },
      break_seconds: 1500,
      shift_seconds: 18300
    },
    {
      agent_user_id: 'a1b2c3d4-0009-4000-8000-000000000009',
      agent_name: 'Pooja M',
      departed: true,
      calls_handled: 17,
      main: {
        value: 0.11764705882352941,
        numerator: 2,
        denominator: 17,
        reportable: false,
        interval: [
          0.03287908001292092,
          0.3433684249770991
        ],
        withheld: 'too_few'
      },
      talk_seconds: 3230,
      avg_call_seconds: 190,
      wrapup_seconds: 384,
      measured_wrapups: 16,
      choose: {
        value: 24,
        numerator: 384,
        denominator: 16,
        reportable: false,
        interval: null,
        withheld: 'too_few'
      },
      break_seconds: 1380,
      shift_seconds: 9000
    },
    {
      agent_user_id: 'a1b2c3d4-0010-4000-8000-000000000010',
      agent_name: 'Farhan A',
      departed: false,
      calls_handled: 12,
      main: {
        value: 0.16666666666666666,
        numerator: 2,
        denominator: 12,
        reportable: false,
        interval: [
          0.04696414761482223,
          0.44803635738467273
        ],
        withheld: 'too_few'
      },
      talk_seconds: 2160,
      avg_call_seconds: 180,
      wrapup_seconds: 252,
      measured_wrapups: 12,
      choose: {
        value: 21,
        numerator: 252,
        denominator: 12,
        reportable: false,
        interval: null,
        withheld: 'too_few'
      },
      break_seconds: 600,
      shift_seconds: 5400
    }
  ],
  comparable: false,
  findings: []
};

/** An answer with nobody in the cohort: no calls in the period. */
export const TEAM_EMPTY: AgencyTeamPerformance = {
  ...TEAM_ONE_CAMPAIGN,
  rollup_as_of: null,
  main_outcome: { ...TEAM_ONE_CAMPAIGN.main_outcome, bar_conversations: 0 },
  totals: {
    agents: 0,
    calls_handled: 0,
    main: { value: null, numerator: 0, denominator: 0, reportable: false, interval: null, withheld: 'too_few' },
    other_conversations: 0,
    avg_call_seconds: null,
    choose_seconds: null,
    wrapup_allowed: { seconds: null, varies: false },
    callbacks: { due: 0, on_time: 0, late: 0, missed: 0, pending_due: 0, upcoming: 0 },
  },
  medians: { calls_handled: null, main_rate: null, avg_call_seconds: null, choose_seconds: null },
  outcomes: [],
  trend: { span: 'last_working_days', dates: [], counts: [] },
  agents: [],
  findings: [],
};

/** {@link TEAM_ONE_CAMPAIGN}'s agents' ids by name. */
export const TEAM_AGENT: Readonly<Record<string, string>> = Object.fromEntries(
  TEAM_ONE_CAMPAIGN.agents.map((a) => [a.agent_name ?? '', a.agent_user_id]),
);
