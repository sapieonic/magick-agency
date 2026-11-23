import { describe, expect, it } from 'vitest';
import {
  AGENCY_CAMPAIGN_COLUMN_DEFAULTS,
  AGENCY_CAMPAIGN_TEMPLATE_ACCOUNT_ONLY_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_ORGANISATION_EXCLUDED_FIELDS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  type AgencyCampaignTemplateConfig,
  type AgencyCampaignTemplateField,
} from '../src/agency';
import { AGENCY_FLAGS } from '../src/flags';
import { AgencyApi } from '../src/index';
import type { AgencyCampaign } from '../src/api/agency/agency-campaign';
import type { Equals } from './type-equals';

/**
 * Campaign templates' section map (docs/campaign-templates.md §3), the one list of which campaign
 * fields a template section holds. The type-level guards in the source (every field a key of
 * `AgencyCampaign`, no field in two sections) fail `pnpm lint`; this file holds the map to the
 * spec's table and checks the same rules at run time.
 */

/** SNAPSHOT of §3's table, written out by hand. */
const SPEC_TABLE: Record<string, string[]> = {
  outcomes: ['disposition_catalog', 'outcome_dispositions'],
  retries: ['retry_policy'],
  hours: ['calling_window_start', 'calling_window_end', 'calling_days', 'default_timezone'],
  wrapup: ['wrapup_seconds', 'wrapup_auto_return', 'allow_wrapup_redial'],
  breaks: ['break_reasons'],
  recording: ['record_calls', 'analysis_profile_id'],
  agent_screen: ['agent_script', 'phone_display', 'daily_target_calls'],
  safety: ['abandonment_ceiling_pct'],
  assignment: [
    'assignment_mode', 'on_unstaff', 'callback_owner_grace_minutes', 'callback_fallback',
    'allow_agent_retry', 'agent_retry_rounds', 'agent_retry_cooldown_minutes',
  ],
  inbound: ['inbound_sticky_enabled'],
  numbers: ['caller_ids', 'telephony_provider', 'telephony_credential_id'],
};

// The config type names exactly the sections' fields, each as the campaign types it.
const _configFields: Equals<keyof AgencyCampaignTemplateConfig, AgencyCampaignTemplateField> = true;
const _configTyped: Equals<AgencyCampaignTemplateConfig['daily_target_calls'], number | null> = true;
const _fieldsAreCampaign: AgencyCampaignTemplateField extends keyof AgencyCampaign ? true : false = true;
void [_configFields, _configTyped, _fieldsAreCampaign];

describe('campaign template sections', () => {
  it('are the spec table, section by section, in its order', () => {
    expect(AGENCY_CAMPAIGN_TEMPLATE_SECTIONS).toEqual(SPEC_TABLE);
    expect([...AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS]).toEqual(Object.keys(SPEC_TABLE));
  });

  it('put no field in two sections', () => {
    const fields = Object.values(AGENCY_CAMPAIGN_TEMPLATE_SECTIONS).flat();
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('leave out the name, the card display and the lifecycle (§3)', () => {
    const fields = new Set<string>(Object.values(AGENCY_CAMPAIGN_TEMPLATE_SECTIONS).flat());
    for (const f of ['name', 'context_display', 'status', 'parent_campaign_id', 'retry_selector', 'archived_at', 'template_source']) {
      expect(fields.has(f), f).toBe(false);
    }
  });

  it('keep the account\'s things off an organisation template (CT5, CT15)', () => {
    expect([...AGENCY_CAMPAIGN_TEMPLATE_ACCOUNT_ONLY_SECTIONS]).toEqual(['numbers']);
    expect([...AGENCY_CAMPAIGN_TEMPLATE_ORGANISATION_EXCLUDED_FIELDS]).toEqual(['analysis_profile_id']);
    expect(AGENCY_CAMPAIGN_TEMPLATE_SECTIONS.recording).toContain('analysis_profile_id');
  });

  it('gate assignment and inbound on their features\' flags', () => {
    expect(AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS).toEqual({
      assignment: 'agency_contact_assignment_enabled',
      inbound: 'agency_inbound_enabled',
    });
    for (const flag of Object.values(AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS)) expect(AGENCY_FLAGS[flag]).toBeDefined();
  });

  it('are the ones the console layer re-exports, not copies', () => {
    expect(AgencyApi.AGENCY_CAMPAIGN_TEMPLATE_SECTIONS).toBe(AGENCY_CAMPAIGN_TEMPLATE_SECTIONS);
    expect(AgencyApi.AGENCY_CAMPAIGN_COLUMN_DEFAULTS).toBe(AGENCY_CAMPAIGN_COLUMN_DEFAULTS);
  });
});

describe('the campaign column defaults', () => {
  it('are frozen, the calling days too', () => {
    expect(Object.isFrozen(AGENCY_CAMPAIGN_COLUMN_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(AGENCY_CAMPAIGN_COLUMN_DEFAULTS.calling_days)).toBe(true);
  });
});
