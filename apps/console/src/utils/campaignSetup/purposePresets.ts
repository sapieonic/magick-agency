import type { AgencyDispositionEntry } from '../../types/agency-campaign';
import {
  DEFAULT_DISPOSITIONS,
  DEFAULT_DISPOSITION_RETRY,
  isAutoDispositionEligible,
  type CampaignConfigState,
} from '../agencyCampaignConfigForm';
import { collectionsStarterOutcomes, withCollectionsStarter } from '../agency/collectionsStarter';

/**
 * Step 3's starting points (CS2): picking one fills the buttons, and everything stays editable.
 * They live here, in the console, and a save sends an ordinary catalogue. Pure.
 *
 *  - **Payment reminder** is the Collections set (AS4, `collectionsStarter.ts`), as it is.
 *  - **Sales / leads**, **Survey / feedback** and **Appointment** are six buttons each, with their
 *    tile pictures. Each keeps the built-in `callback` (the one way to book a call at a time the
 *    customer names) and `do_not_call` (the agent's way to stop calls) with the flags the server
 *    requires of those codes, and tries a call nobody spoke on again as the Collections set does.
 *  - **Start blank** is the server's own default: the three built-ins (Voicemail, Callback, Do not
 *    call). They are locked against removal in the editor, because each is a capability an agent
 *    needs; an empty list would mean "agents do not file outcomes on this campaign".
 */

export type PurposePresetId = 'payment' | 'sales' | 'survey' | 'appointment' | 'blank';

export interface PurposePreset {
  id: PurposePresetId;
  title: string;
  description: string;
  /** A fresh, unshared copy of the preset's buttons. */
  outcomes: () => AgencyDispositionEntry[];
}

const retry = () => ({ ...DEFAULT_DISPOSITION_RETRY });

const CALL_LATER: AgencyDispositionEntry = { code: 'callback', label: 'Call later', requires_datetime: true, icon: 'clock' };
const NO_ONE_SPOKE = (): AgencyDispositionEntry => ({ code: 'no_one_spoke', label: 'No one spoke', retry: retry(), icon: 'phone_missed' });
const WRONG_NUMBER: AgencyDispositionEntry = { code: 'wrong_number', label: 'Wrong number', terminal: true, icon: 'wrong_number' };
const DONT_CALL: AgencyDispositionEntry = { code: 'do_not_call', label: "Don't call again", suppress: true, icon: 'stop' };

function sales(): AgencyDispositionEntry[] {
  return [
    { code: 'interested', label: 'Interested', is_success: true, requires_note: true, icon: 'thumbs_up' },
    { ...CALL_LATER },
    NO_ONE_SPOKE(),
    { code: 'not_interested', label: 'Not interested', terminal: true, icon: 'thumbs_down' },
    { ...WRONG_NUMBER },
    { ...DONT_CALL },
  ];
}

function survey(): AgencyDispositionEntry[] {
  return [
    { code: 'survey_done', label: 'Survey done', is_success: true, requires_note: true, icon: 'check' },
    { ...CALL_LATER },
    NO_ONE_SPOKE(),
    { code: 'refused', label: 'Refused', terminal: true, icon: 'thumbs_down' },
    { ...WRONG_NUMBER },
    { ...DONT_CALL },
  ];
}

function appointment(): AgencyDispositionEntry[] {
  return [
    { code: 'confirmed', label: 'Confirmed', is_success: true, icon: 'check' },
    { code: 'rescheduled', label: 'Rescheduled', is_success: true, requires_note: true, icon: 'calendar' },
    { ...CALL_LATER },
    NO_ONE_SPOKE(),
    { code: 'cancelled', label: 'Cancelled', requires_note: true, terminal: true, icon: 'cross' },
    { ...DONT_CALL },
  ];
}

function blank(): AgencyDispositionEntry[] {
  return DEFAULT_DISPOSITIONS.map((entry) => ({ ...entry, ...(entry.retry ? { retry: { ...entry.retry } } : {}) }));
}

/** The five starting points, in the order the step shows them. */
export const PURPOSE_PRESETS: readonly PurposePreset[] = [
  { id: 'payment', title: 'Payment reminder', description: 'Collections, EMI, chit dues', outcomes: collectionsStarterOutcomes },
  { id: 'sales', title: 'Sales / leads', description: 'Offers, follow-ups, demos', outcomes: sales },
  { id: 'survey', title: 'Survey / feedback', description: 'NPS, service feedback', outcomes: survey },
  { id: 'appointment', title: 'Appointment', description: 'Confirm, reschedule, remind', outcomes: appointment },
  { id: 'blank', title: 'Start blank', description: 'Build your own buttons', outcomes: blank },
];

export function purposePreset(id: PurposePresetId): PurposePreset {
  return PURPOSE_PRESETS.find((preset) => preset.id === id)!;
}

export function isPurposePresetId(value: string): value is PurposePresetId {
  return PURPOSE_PRESETS.some((preset) => preset.id === value);
}

/**
 * The config with `id`'s buttons in place. An automatic outcome for unanswered calls whose code
 * the new buttons do not have, or may not be filed automatically, is dropped (the server refuses
 * either); every other setting is kept. Payment reminder is `withCollectionsStarter` itself.
 */
export function withPreset(config: CampaignConfigState, id: PurposePresetId): CampaignConfigState {
  if (id === 'payment') return withCollectionsStarter(config);
  const dispositions = purposePreset(id).outcomes();
  const outcomeDispositions = Object.fromEntries(
    Object.entries(config.outcomeDispositions).filter(
      ([, code]) => typeof code === 'string' && isAutoDispositionEligible(dispositions, code),
    ),
  ) as CampaignConfigState['outcomeDispositions'];
  return { ...config, dispositions, outcomeDispositions };
}

/**
 * Which starting point `dispositions` still is, or `null` when it is none of them (edited, or a
 * campaign made another way). Compared by meaning, not by spelling: key order, a `false` flag and
 * an absent one, and an `undefined` key are all the same.
 */
export function presetOf(dispositions: readonly AgencyDispositionEntry[]): PurposePresetId | null {
  const key = canonical(dispositions);
  return PURPOSE_PRESETS.find((preset) => canonical(preset.outcomes()) === key)?.id ?? null;
}

function canonical(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || v === false) continue;
      out[key] = normalise(v);
    }
    return out;
  }
  return value;
}
