import { describe, it, expect } from 'vitest';
import { changedSettings, type CampaignSettingsForm } from '../../utils/campaignSettingsChanges';
import { configFromCampaign } from '../../utils/agencyCampaignConfigForm';
import type { AgencyCampaign } from '../../types/agency-campaign';

/** The unsaved-changes bar's count: one per setting a person would name, never a false one. */

const CAMPAIGN = {
  id: 'camp-1',
  name: 'Collections',
  status: 'paused',
  calling_window_start: '10:00',
  calling_window_end: '18:00',
  calling_days: [1, 2, 3],
  default_timezone: 'Asia/Kolkata',
  wrapup_seconds: 45,
  caller_ids: ['+912200000001', '+912200000002'],
  disposition_catalog: [
    { code: 'voicemail', label: 'Voicemail' },
    { code: 'callback', label: 'Callback', requires_datetime: true },
  ],
  retry_policy: { no_answer: { max_attempts: 3, delay_minutes: 30 } },
  abandonment_ceiling_pct: 3,
} as unknown as AgencyCampaign;

function form(): CampaignSettingsForm {
  return {
    name: CAMPAIGN.name,
    callerIds: [...(CAMPAIGN.caller_ids ?? [])],
    carrier: { telephony_provider: 'voicelink', telephony_credential_id: null },
    recording: { record: false, profileId: '' },
    config: configFromCampaign(CAMPAIGN),
  };
}

describe('changedSettings', () => {
  it('finds nothing in a form as loaded, or in an equal copy of it', () => {
    expect(changedSettings(form(), form())).toEqual([]);
  });

  it('names each changed setting once', () => {
    const now = form();
    now.name = 'Collections — September';
    now.config = { ...now.config, window: { ...now.config.window, start: '11:00', end: '19:00' }, wrapupSeconds: 60 };
    now.recording = { ...now.recording, record: true };
    expect(changedSettings(form(), now)).toEqual(['name', 'window.start', 'window.end', 'wrapupSeconds', 'recording.record']);
  });

  it('counts the outcome catalogue as one setting however many outcomes changed', () => {
    const now = form();
    now.config = {
      ...now.config,
      dispositions: now.config.dispositions.map((d) => ({ ...d, label: `${d.label}!` })),
    };
    expect(changedSettings(form(), now)).toEqual(['dispositions']);
  });

  it('ignores order where order means nothing: the caller-ID pool and the calling days', () => {
    const now = form();
    now.callerIds = [...now.callerIds].reverse();
    now.config = { ...now.config, window: { ...now.config.window, days: [3, 1, 2] } };
    expect(changedSettings(form(), now)).toEqual([]);
  });

  it('sees a reordered outcome catalogue, which changes what agents see', () => {
    const now = form();
    now.config = { ...now.config, dispositions: [...now.config.dispositions].reverse() };
    expect(changedSettings(form(), now)).toEqual(['dispositions']);
  });

  it('compares a retry policy by value, not by key order', () => {
    const saved = form();
    saved.config = { ...saved.config, retryPolicy: { busy: { max_attempts: 2, delay_minutes: 5 }, no_answer: { max_attempts: 3, delay_minutes: 30 } } as never };
    const now = form();
    now.config = { ...now.config, retryPolicy: { no_answer: { delay_minutes: 30, max_attempts: 3 }, busy: { delay_minutes: 5, max_attempts: 2 } } as never };
    expect(changedSettings(saved, now)).toEqual([]);
  });

  it('counts the carrier and the call summary, and not the remembered stored ceiling', () => {
    const now = form();
    now.carrier = { telephony_provider: 'twilio', telephony_credential_id: 'cred-1' };
    now.recording = { ...now.recording, profileId: 'prof-1' };
    now.config = { ...now.config, abandonmentCeilingStoredPct: 9 };
    expect(changedSettings(form(), now)).toEqual(['carrier', 'recording.profileId']);
  });

  it('counts a caller ID added or removed', () => {
    const now = form();
    now.callerIds = ['+912200000001'];
    expect(changedSettings(form(), now)).toEqual(['callerIds']);
  });
});
