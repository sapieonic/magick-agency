import { PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY } from '@magick-agency/contracts/api/platform/audit';
import { describe, expect, it } from 'vitest';
import { TELEPHONY_PROVIDER_ALIASES } from '@magick-agency/web-ui/telephonyProviders';
import {
  CONFIG_FIELD_LABEL,
  activityDetailKeyLabel,
  activityDetailSummary,
  activityDetailValue,
  activityTargetLabel,
  activityTargetPath,
  isActivityId,
  formatActivityTimestamp,
  partialNotice,
  retentionNotice,
  truncationNotice,
} from '../../utils/agencyActivityCopy';
import {
  activityActionLabel,
  activityActionLabels,
  groupActivityActions,
} from '../../types/agency-activity';
import type { ActivityRow } from '../../types/agency-activity';

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'core:c1',
    at: '2026-08-01T11:00:00.000Z',
    source: 'core',
    action: 'agency_campaign.auto_paused',
    actor: { type: 'system', system: true, user_id: null, api_key_id: null, display: 'system:abandonment-guardrail' },
    target: { type: 'agency_campaign', id: 'camp-1' },
    detail: {},
    ...over,
  };
}

describe('retentionNotice', () => {
  it('states the horizon when there is one', () => {
    const notice = retentionNotice({
      earliest_retained_at: '2026-05-01T00:00:00.000Z',
      source: 'partition_bound',
    });

    expect(notice).toMatch(/The dialler’s records go back to/);
    expect(notice).toMatch(/no longer stored/);
    // The horizon comes from the DIALER's partitions. Stating it unqualified
    // would claim a guarantee for dispositions, do-not-call marks and staffing
    // changes — records the console keeps on its own schedule — that nothing
    // has checked.
    expect(notice).toMatch(/Console records follow their own retention schedule/);
  });

  /** Nothing has aged out — there is genuinely nothing to warn about. */
  it('says nothing when the trail is unbounded', () => {
    expect(retentionNotice({ earliest_retained_at: null, source: 'unbounded' })).toBeNull();
  });

  /**
   * Silence would be read as "all of it". "We do not know how far back this
   * goes" is information, and on an audit surface it is the honest answer.
   */
  it.each([
    ['an unknown horizon', { earliest_retained_at: null, source: 'unknown' }],
    ['a bound with no date', { earliest_retained_at: null, source: 'partition_bound' }],
  ])('still says something for %s', (_name, retention) => {
    expect(retentionNotice(retention)).toMatch(/could not be determined/);
  });

  it('explains itself when the horizon is missing because the read was partial', () => {
    expect(retentionNotice(null)).toMatch(/could not be checked/);
  });
});

describe('partialNotice', () => {
  /**
   * "Some data is unavailable" is useless: a supervisor who does not know that
   * status changes and the automatic pause are the missing part cannot judge
   * whether what is on screen answers their question.
   */
  it.each([
    ['core_unreachable', /could not be reached/],
    ['core_error', /returned an error/],
    [null, /returned an error/],
  ])('names the cause (%s) and what is missing', (reason, causePattern) => {
    const notice = partialNotice(reason);

    expect(notice).toMatch(causePattern);
    expect(notice).toMatch(/status changes and any automatic pause/);
    expect(notice).toMatch(/Refresh/);
  });
});

describe('truncationNotice', () => {
  it('states the ceiling and the remedy', () => {
    expect(truncationNotice(5000)).toMatch(/most recent 5,000 entries/);
    expect(truncationNotice(5000)).toMatch(/Narrow the date range/);
  });

  /**
   * "Truncated, size unknown" is a real runtime state, not a formality: the
   * ceiling arrives in a response header, and a header that does not parse as a
   * count becomes `null` (see `parseRowLimit`). The sentence for it must still
   * be a sentence — the earlier copy substituted "the maximum" into the number's
   * slot and produced "Only the most recent the maximum entries were exported"
   * — and must still warn, because an export that cannot say HOW truncated it is
   * is still truncated.
   */
  it('degrades to a truthful sentence without inventing a number', () => {
    const notice = truncationNotice(null);

    expect(notice).not.toMatch(/most recent/);
    expect(notice).not.toMatch(/NaN|undefined|null/);
    expect(notice).toMatch(/does not contain every entry/);
    // The remedy is the half the operator acts on, and it does not depend on
    // knowing the ceiling.
    expect(notice).toMatch(/Narrow the date range/);
  });
});

describe('formatActivityTimestamp', () => {
  /**
   * The shared `formatDate` stops at minutes and names no zone, which is fine
   * for "updated 5 minutes ago" and useless here: a whole audit flush shares one
   * displayed minute with no ordering cue, and a reviewer comparing the screen
   * against the ISO-UTC CSV has nothing to reconcile them by.
   */
  it('carries seconds and a named timezone', () => {
    const rendered = formatActivityTimestamp('2026-08-01T11:00:07.000Z');

    expect(rendered).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(rendered).toMatch(/[A-Z]{2,5}|GMT|UTC/);
  });

  // The run's locale is en-US (vite.config.ts), so a formatter that follows the browser
  // prints `Aug 1, 2026, 11:00:07 AM UTC` here and fails.
  it('uses the console display locale, not the browser one', () => {
    expect(formatActivityTimestamp('2026-08-01T11:00:07.000Z')).toBe('1 Aug 2026, 11:00:07 am UTC');
  });

  it('falls back to the raw value rather than rendering "Invalid Date"', () => {
    expect(formatActivityTimestamp('not-a-date')).toBe('not-a-date');
  });
});

describe('activityDetailSummary', () => {
  /**
   * The row this whole view exists for. "Paused" without the rate it measured
   * and the ceiling it broke tells a compliance reviewer nothing.
   */
  it('reads out the measured rate and the ceiling on an auto-pause', () => {
    expect(
      activityDetailSummary(row({ detail: { measured_pct: 4.2, ceiling_pct: 3 } })),
    ).toBe('Abandonment reached 4.2%, over the 3% ceiling.');
  });

  it('falls back to the reason when the numbers are absent', () => {
    expect(activityDetailSummary(row({ detail: { reason: 'abandonment_ceiling' } })))
      .toBe('Reason: abandonment_ceiling');
  });

  it('says what to do when the carrier refused the account’s credentials', () => {
    expect(activityDetailSummary(row({ detail: { reason: 'carrier_auth' } })))
      .toBe('Paused: the carrier refused this account’s credentials. Contact support to have them checked.');
  });

  it('says what to do when the campaign’s carrier account is no longer active', () => {
    expect(activityDetailSummary(row({ detail: { reason: 'carrier_account_unavailable' } })))
      .toBe('Paused: this campaign’s carrier account is no longer active. Contact support to have it re-enabled, or choose another carrier.');
  });

  it('says what to do when the carrier refused several calls in a row', () => {
    expect(activityDetailSummary(row({ detail: { reason: 'carrier_refusing_calls' } })))
      .toBe('Paused: the carrier refused several of this campaign’s calls in a row. Contact support to have the carrier account’s destinations, balance and caller IDs checked, then resume.');
  });

  it('names a move to another carrier account in a config change', () => {
    expect(activityDetailSummary(row({
      action: 'agency_campaign.config_changed',
      detail: { fields: ['telephony_provider', 'telephony_credential_id'] },
    }))).toBe('Changed carrier and carrier account.');
  });

  it('names the carrier by its alias and the carrier account by its label, never a vendor or an id', () => {
    const CRED = '6f1c2a40-9d7e-4b8a-a1c3-0e5f7d2b9c11';
    const moved = row({
      action: 'agency_campaign.config_changed',
      detail: {
        fields: ['telephony_provider', 'telephony_credential_id'],
        changes: {
          telephony_provider: { from: 'voicelink', to: 'plivo' },
          telephony_credential_id: { from: null, to: CRED, to_label: 'Acme main' },
        },
      },
    });
    expect(activityDetailSummary(moved))
      .toBe('Changed carrier (Swar → Pravah) and carrier account (the default account → “Acme main”).');

    const account = (change: Record<string, unknown>) => activityDetailSummary(row({
      action: 'agency_campaign.config_changed',
      detail: { fields: ['telephony_credential_id'], changes: { telephony_credential_id: change } },
    }));
    // The server found no such account when the change was made.
    expect(account({ from: CRED, to: null, from_label: null }))
      .toBe('Changed carrier account (an account no longer available → the default account).');
    // A row written before labels were recorded.
    expect(account({ from: CRED, to: null }))
      .toBe('Changed carrier account (your own account → the default account).');
  });

  /** The audit case `on_behalf` exists for is called out, not buried. */
  it('says when a disposition was filed for another agent', () => {
    const filed = row({
      action: 'agency_disposition.created',
      detail: { disposition_code: 'promise_to_pay', on_behalf: true },
    });

    expect(activityDetailSummary(filed)).toMatch(/on behalf of the agent who took the call/);
    expect(activityDetailSummary({ ...filed, detail: { disposition_code: 'promise_to_pay' } }))
      .toBe('Filed “promise_to_pay”.');
  });

  it('reports the scope of a do-not-call mark and its reversal', () => {
    expect(activityDetailSummary(row({ action: 'dnc_entry.created', detail: { scope: 'campaign' } })))
      .toBe('Suppressed, scope: campaign.');
    expect(activityDetailSummary(row({ action: 'dnc_entry.deleted', detail: { scope: 'tenant' } })))
      .toBe('Un-suppressed, scope: tenant.');
  });

  it('names every changed setting, with before and after where the row carries them (IN8)', () => {
    const changed = row({
      source: 'master',
      action: 'agency_campaign.config_changed',
      detail: {
        campaign_id: 'camp-1',
        fields: ['calling_window_end', 'record_calls', 'calling_days', 'retry_policy', 'brand_new_setting'],
        changes: {
          calling_window_end: { from: '20:00:00', to: '21:00:00' },
          record_calls: { from: false, to: true },
          calling_days: { from: [1, 2, 3, 4, 5], to: [1, 2, 3, 4, 5, 6] },
        },
      },
    });
    expect(activityDetailSummary(changed)).toBe(
      'Changed calling hours end (20:00:00 → 21:00:00), call recording (off → on), '
      + 'calling days (1, 2, 3, 4, 5 → 1, 2, 3, 4, 5, 6), retry policy and brand new setting.',
    );
    // One field reads as a sentence too, and a row naming nothing falls back to the raw detail.
    expect(activityDetailSummary({ ...changed, detail: { fields: ['retry_policy'] } }))
      .toBe('Changed retry policy.');
    // The unanswered-call mapping (OD1–OD8) is named, not spelled out from its wire name.
    expect(activityDetailSummary({ ...changed, detail: { fields: ['retry_policy', 'outcome_dispositions'] } }))
      .toBe('Changed retry policy and automatic outcomes for unanswered calls.');
    expect(activityDetailSummary({ ...changed, detail: { fields: [] } })).toBeNull();
  });

  it('reads out a roster upload: the file and its rule, then how it ended (IN8)', () => {
    const started = row({
      source: 'master',
      action: 'agency_campaign.roster_upload_started',
      detail: { file_name: 'may.csv', mode: 'append', dedupe_column: 'Loan No', dedupe_phones: true },
    });
    expect(activityDetailSummary(started))
      .toBe('Uploaded “may.csv”, adding to the roster, duplicates found on “Loan No”.');
    expect(activityDetailSummary({ ...started, detail: { file_name: 'may.csv', mode: 'replace', dedupe_column: null } }))
      .toBe('Uploaded “may.csv”, replacing the roster, duplicates found on the phone number.');
    // Since 0031 the row carries the key's columns; a combination names each.
    expect(activityDetailSummary({ ...started, detail: { file_name: 'may.csv', mode: 'append', dedupe_columns: ['Loan No', 'Branch'] } }))
      .toBe('Uploaded “may.csv”, adding to the roster, duplicates found on “Loan No” + “Branch”.');
    expect(activityDetailSummary({ ...started, detail: { file_name: 'may.csv', mode: 'append', dedupe_columns: null, dedupe_phones: false } }))
      .toBe('Uploaded “may.csv”, adding to the roster, no duplicate check.');

    const counts = { rows_read: 1200, accepted: 1150, rejected: 50, duplicates: 20 };
    expect(activityDetailSummary(row({ action: 'agency_campaign.roster_upload_completed', detail: { status: 'completed', ...counts } })))
      .toBe('1,200 rows read: 1,150 accepted, 50 rejected (20 duplicates).');
    expect(activityDetailSummary(row({
      action: 'agency_campaign.roster_upload_failed',
      detail: { status: 'failed', error_code: 'dnc_unavailable', rows_read: 0, accepted: 0, rejected: 0, duplicates: 0 },
    }))).toBe('Failed: dnc_unavailable. 0 rows read: 0 accepted, 0 rejected.');
    expect(activityDetailSummary(row({ action: 'agency_campaign.roster_upload_failed', detail: { status: 'cancelled' } })))
      .toBe('Cancelled.');
  });

  it('says how many contacts a roster clear removed, or that it could not tell', () => {
    expect(activityDetailSummary(row({ action: 'agency_campaign.roster_cleared', detail: { roster_state: 'cleared', cleared: 4210 } })))
      .toBe('4,210 contacts removed from the roster.');
    expect(activityDetailSummary(row({ action: 'agency_campaign.roster_cleared', detail: { roster_state: 'unconfirmed', cleared: null } })))
      .toMatch(/could not be confirmed/);
  });

  it('renders a status transition generically', () => {
    expect(activityDetailSummary(row({ action: 'agency_campaign.stopped', detail: { from: 'running', to: 'stopping' } })))
      .toBe('running → stopping');
  });

  /**
   * `null` means "show the raw detail", which is the point: an action this
   * build does not recognise must not be summarised away, because the
   * unanticipated row is exactly the one an audit needs.
   */
  it('declines to summarise an action it does not know', () => {
    expect(activityDetailSummary(row({ action: 'something.new', detail: { odd: 1 } }))).toBeNull();
  });

  it('ignores a non-numeric rate rather than printing it', () => {
    expect(
      activityDetailSummary(row({ detail: { measured_pct: 'lots', ceiling_pct: 3 } })),
    ).toBeNull();
  });
});

/**
 * The vocabulary as the API serves it, in miniature. Nothing here is a copy of
 * the API's real list — that is exactly what this rework removed — so the labels
 * are deliberately not the production ones: what is under test is that the
 * rendered copy comes from the RESPONSE, not from anything in this repository.
 */
const SERVED = [
  { value: 'agency_campaign.auto_paused', label: 'Halted on its own', group: 'Campaign' },
  { value: 'agency_campaign.paused', label: 'Paused', group: 'Campaign' },
  { value: 'dnc_entry.created', label: 'Marked do-not-call', group: 'Calls' },
];

describe('activityActionLabel', () => {
  it('translates an action the server sent a label for', () => {
    expect(activityActionLabel('agency_campaign.auto_paused', activityActionLabels(SERVED)))
      .toBe('Halted on its own');
  });

  /**
   * An unrecognised row must still be legible, and must be obvious as
   * unrecognised rather than dressed up as something else. Hiding it is the one
   * omission this view cannot afford — and the served list is the set of actions
   * worth OFFERING as a filter, never a claim about what the trail can contain.
   */
  it('falls back to the raw name for an action the server did not name', () => {
    expect(activityActionLabel('agency_campaign.teleported', activityActionLabels(SERVED)))
      .toBe('agency_campaign.teleported');
  });

  /**
   * The case an older server produces. Every row falls back to its raw name
   * rather than rendering blank — which is why the label resolver is separate
   * from the filter, and why the filter is the only thing that disappears.
   */
  it('labels every row by its raw name when no vocabulary was served', () => {
    const none = activityActionLabels(undefined);
    expect(activityActionLabel('agency_campaign.auto_paused', none))
      .toBe('agency_campaign.auto_paused');
  });
});

describe('groupActivityActions', () => {
  /**
   * Server order is kept as-is: re-sorting would put "Auto-paused" beside
   * "Created" alphabetically, which reads as noise to someone scanning for the
   * pause.
   */
  it('keeps the served order, splitting on the group it was given', () => {
    expect(groupActivityActions(SERVED)).toEqual([
      {
        label: 'Campaign',
        actions: [SERVED[0], SERVED[1]],
      },
      { label: 'Calls', actions: [SERVED[2]] },
    ]);
  });

  /** No vocabulary means no groups — and the page renders no filter at all. */
  it('yields nothing for a missing or empty vocabulary', () => {
    expect(groupActivityActions(undefined)).toEqual([]);
    expect(groupActivityActions([])).toEqual([]);
  });
});

/**
 * Vendor names never reach the Activity trail (the carrier aliases, B18): every setting
 * the summary names, with carrier values from every carrier the aliases know.
 */
describe('the config-change summary is vendor-free and id-free for every setting', () => {
  const VENDOR = /twilio|plivo|exotel|vobiz|telnyx|voice\s?link|z99|generic[\s_]sip/i;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const slugs = Object.keys(TELEPHONY_PROVIDER_ALIASES);
  const CRED_A = '6f1c2a40-9d7e-4b8a-a1c3-0e5f7d2b9c11';
  const CRED_B = '0b7d3e55-1a2b-4c3d-8e9f-112233445566';

  /** A changed value for each field: carrier fields get the values the server stores. */
  function changeFor(field: string, i: number): Record<string, unknown> {
    if (field === 'telephony_provider') return { from: slugs[i % slugs.length], to: slugs[(i + 1) % slugs.length] };
    if (field === 'telephony_credential_id') return { from: CRED_A, to: CRED_B };
    return { from: 1, to: 2 };
  }

  for (const [i, field] of Object.keys(CONFIG_FIELD_LABEL).entries()) {
    it(`${field}`, () => {
      const fields = [field, 'telephony_provider', 'telephony_credential_id'];
      for (const labels of [{}, { from_label: null, to_label: null }, { from_label: 'Main', to_label: 'Backup' }]) {
        const summary = activityDetailSummary(row({
          action: 'agency_campaign.config_changed',
          detail: {
            fields,
            changes: Object.fromEntries(fields.map((f) => [
              f, f === 'telephony_credential_id' ? { ...changeFor(f, i), ...labels } : changeFor(f, i),
            ])),
          },
        }));
        expect(summary).toBeTruthy();
        expect(summary).not.toMatch(VENDOR);
        expect(summary).not.toMatch(UUID);
      }
    });
  }

  it('every carrier the aliases know reads as its alias', () => {
    for (const slug of slugs) {
      const summary = activityDetailSummary(row({
        action: 'agency_campaign.config_changed',
        detail: { fields: ['telephony_provider'], changes: { telephony_provider: { from: slug, to: slug.toUpperCase() } } },
      }));
      const alias = TELEPHONY_PROVIDER_ALIASES[slug]!;
      expect(summary).toBe(`Changed carrier (${alias} → ${alias}).`);
    }
  });
});

describe('History row words', () => {
  it('names a record type, and an unknown one as "Record", never its code', () => {
    expect(activityTargetLabel('agency_manual_call')).toBe('Soft-phone call');
    expect(activityTargetLabel('agency_session')).toBe('Agent session');
    expect(activityTargetLabel('call')).toBe('Call');
    expect(activityTargetLabel('something_new')).toBe('Record');
    expect(activityTargetLabel(null)).toBe('Record');
  });

  it('names every audit resource type as the Audit Log filter does (the contract’s labels)', () => {
    for (const { value, label } of PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY) {
      expect(activityTargetLabel(value), value).toBe(label);
    }
    expect(activityTargetLabel('agency_disposition')).toBe('Call disposition');
    expect(activityTargetLabel('dnc_entry')).toBe('Do-not-call entry');
  });

  it('opens a call, a contact and a soft-phone call on their own pages; nothing else', () => {
    expect(activityTargetPath({ type: 'agency_attempt', id: 'a1' }, 'c1')).toBe('/agency/campaigns/c1/attempts/a1');
    expect(activityTargetPath({ type: 'agency_disposition', id: 'a1' }, 'c1')).toBe('/agency/campaigns/c1/attempts/a1');
    expect(activityTargetPath({ type: 'agency_contact', id: 'k1' }, 'c1')).toBe('/agency/campaigns/c1/contacts/k1');
    expect(activityTargetPath({ type: 'agency_manual_call', id: 'm1' }, 'c1')).toBe('/agency/softphone/calls/m1');
    expect(activityTargetPath({ type: 'agency_session', id: 's1' }, 'c1')).toBeNull();
    expect(activityTargetPath({ type: 'agency_attempt', id: null }, 'c1')).toBeNull();
  });

  it('names a detail key in words, a known one by name and any other in sentence case', () => {
    expect(activityDetailKeyLabel('session_id')).toBe('Agent session');
    expect(activityDetailKeyLabel('call_id')).toBe('Call');
    expect(activityDetailKeyLabel('retry_count')).toBe('Retry count');
  });

  it('reads a flag as yes or no and spots an id', () => {
    expect(activityDetailValue(true)).toBe('Yes');
    expect(activityDetailValue(false)).toBe('No');
    expect(activityDetailValue(3)).toBe('3');
    expect(isActivityId('8c1dab83-bba7-477c-abad-1271ba787ddc')).toBe(true);
    expect(isActivityId('not an id')).toBe(false);
  });
});
