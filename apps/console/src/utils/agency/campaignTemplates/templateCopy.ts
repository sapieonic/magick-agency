import {
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  type AgencyCampaignTemplateConfig,
  type AgencyCampaignTemplateNote,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSectionSource,
  type AgencyCampaignTemplateSections,
  type AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { normaliseSection, type TemplateSectionDiff } from '@magick-agency/domain/campaign-templates';
import type { AgencyCampaignActor } from '@magick-agency/contracts/agency';
import { describeIsoDays } from '../../format/weekdays';
import { ASSIGNMENT_MODE_COPY } from '../../agencyAssignmentCopy';
import { ceilingSummary } from '../abandonmentCeiling';
import { PHONE_DISPLAY_LABELS } from '../stationSettings';
import { carrierName } from '../../agencyCarriers';
import { plural } from '../../format/number';
import { errorCode } from '../../agencyErrors';
import { FIELD_LABELS, SECTION_LABELS } from './templateForm';

/**
 * The words campaign templates are shown in: a section's one-line summary, a version stamp, a
 * comparison, the notes on a filled-in form and the refusals. Simple Indian English, British
 * spelling, "organisation" (never the wire's other word for it).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `09:00` or `09:00:00` → `9:00 AM`. Anything else as given. */
export function clockTime(value: string): string {
  const m = /^(\d{2}):(\d{2})/.exec(value);
  if (!m) return value;
  const hour = Number(m[1]);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m[2]} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** An instant as `18 Nov, 4:12 PM`, on the reader's clock. */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = clockTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

/** Who did something, or null when nobody can be named. */
export function actorLabel(actor: AgencyCampaignActor | null | undefined): string | null {
  return actor?.name?.trim() || null;
}

/** "Changed by Priya on 18 Nov, 4:12 PM · version 4". */
export function changedLine(template: Pick<AgencyCampaignTemplateSummary, 'updated_by' | 'updated_at' | 'version'>): string {
  const who = actorLabel(template.updated_by);
  return `${who ? `Changed by ${who}` : 'Changed'} on ${formatStamp(template.updated_at)} · version ${template.version}`;
}

/** Days as a phrase: `Mon to Sat`, `Every day`, `Mon, Wed`. */
function daysPhrase(days: readonly number[]): string {
  return (describeIsoDays(days) ?? 'No days').replace('–', ' to ');
}

/** Section `key` of a config or a template's sections, in one line of plain words. */
export function sectionSummary(
  key: AgencyCampaignTemplateSectionKey,
  source: AgencyCampaignTemplateConfig | AgencyCampaignTemplateSections | Record<string, unknown>,
): string {
  const sections = source as Record<string, unknown>;
  // A template's sections hold the section under its key (no field is named as a section is); a
  // config holds its fields directly.
  const raw = key in sections ? sections[key] : source;
  const values = normaliseSection(key, raw as Record<string, unknown>) as Record<string, unknown>;
  switch (key) {
    case 'outcomes': {
      const catalog = (values.disposition_catalog as Array<{ code: string; label?: string }>) ?? [];
      const names = catalog.map((d) => d.label || d.code);
      return names.length === 0 ? 'No outcomes' : `${plural(names.length, 'outcome')}: ${names.join(', ')}`;
    }
    case 'retries': {
      const rules = Object.keys((values.retry_policy as Record<string, unknown>) ?? {}).length;
      return rules === 0 ? 'The built-in retry rules' : `Own rules for ${plural(rules, 'call result')}`;
    }
    case 'hours':
      return `${clockTime(String(values.calling_window_start))}–${clockTime(String(values.calling_window_end))} · ${daysPhrase(
        values.calling_days as number[],
      )} · ${String(values.default_timezone)}`;
    case 'wrapup':
      return wrapupSummary(Number(values.wrapup_seconds), values.wrapup_auto_return === true, values.allow_wrapup_redial === true);
    case 'breaks': {
      const reasons = (values.break_reasons as Array<{ limit_minutes?: number }>) ?? [];
      if (reasons.length === 0) return 'The built-in break reasons, no limits';
      const limited = reasons.filter((r) => typeof r.limit_minutes === 'number').length;
      return `${plural(reasons.length, 'break reason')}, ${limited === 0 ? 'no limits' : `${limited} with a limit`}`;
    }
    case 'recording':
      return `${values.record_calls === true ? 'Every call is recorded' : 'Off'}${
        typeof values.analysis_profile_id === 'string' ? ' · Call summary on' : ''
      }`;
    case 'agent_screen': {
      const target = values.daily_target_calls;
      const script = values.agent_script as { opening?: string; steps?: unknown[] } | undefined;
      const steps = script?.steps?.length ?? 0;
      const scriptWords = steps > 0 ? `Script with ${plural(steps, 'step')}` : script?.opening ? 'Script with an opening line' : 'No script';
      return `${PHONE_DISPLAY_LABELS[(values.phone_display as 'full' | 'masked') ?? 'full']} · ${
        typeof target === 'number' ? `Target ${target} calls a day` : 'No daily target'
      } · ${scriptWords}`;
    }
    case 'safety':
      return ceilingSummary(Number(values.abandonment_ceiling_pct));
    case 'assignment': {
      const mode = values.assignment_mode as keyof typeof ASSIGNMENT_MODE_COPY;
      return `${ASSIGNMENT_MODE_COPY[mode]?.label ?? String(mode)}${values.allow_agent_retry === true ? ' · Agents may retry missed contacts' : ''}`;
    }
    case 'inbound':
      return values.inbound_sticky_enabled === true ? 'Put through to their agent first' : 'Go to the whole team';
    case 'numbers': {
      const ids = (values.caller_ids as string[]) ?? [];
      const carrier = carrierName({
        telephony_provider: String(values.telephony_provider),
        telephony_credential_id: (values.telephony_credential_id as string | null) ?? null,
      });
      return ids.length === 0 ? `No numbers · ${carrier}` : `${plural(ids.length, 'number')} on ${carrier}`;
    }
  }
}

/** Wrap-up in words, as New campaign's Review says it. */
export function wrapupSummary(seconds: number, autoReturn: boolean, redial: boolean): string {
  return `${
    seconds === 0
      ? 'None — agents go straight back to available.'
      : `${seconds}s${autoReturn ? ', then agents return on their own' : ', then agents mark themselves ready'}`
  }${redial ? ' · Redial from wrap-up allowed' : ''}`;
}

/** One difference between two sets of sections, in words: "Set", "No longer set", "Changed: the days and the time zone". */
export function diffWords(diff: TemplateSectionDiff, names: { from: string; to: string }): string {
  if (diff.change === 'set') return `Set in ${names.to}, not in ${names.from}`;
  if (diff.change === 'unset') return `Set in ${names.from}, not in ${names.to}`;
  const fields = diff.fields.map((f) => FIELD_LABELS[f] ?? f);
  const joined = fields.length <= 1 ? (fields[0] ?? '') : `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`;
  return `Changed: ${joined}`;
}

/** The words for where a section came from (New campaign's Review chips). */
export const SOURCE_CHIP_LABELS: Readonly<Record<AgencyCampaignTemplateSectionSource, string>> = {
  account: 'Account template',
  organisation: 'Organisation template',
  builtin: 'Built-in',
  campaign: 'Changed for this campaign',
};

/** A note on a filled-in form, as a sentence (CT5, CT15). */
export function noteSentence(note: AgencyCampaignTemplateNote): string {
  switch (note.code) {
    case 'recording_not_allowed':
      return 'Recording is off for this account, so this campaign starts with recording off.';
    case 'analysis_profile_unavailable':
      return 'The template’s call summary profile is no longer available, so this campaign starts with no summary.';
    case 'numbers_unavailable':
      return note.numbers && note.numbers.length > 0
        ? `These numbers of the template can no longer be used by this account, so they are left out: ${note.numbers.join(', ')}.`
        : 'Some numbers of the template can no longer be used by this account, so they are left out.';
    case 'carrier_unavailable':
      return 'The template’s carrier account is no longer active for this account, so pick the numbers to call from yourself.';
    case 'section_flag_off':
      return `${SECTION_LABELS[note.section]} is not turned on for this account, so it starts with the built-in settings.`;
    case 'outcome_overrides_off':
      return 'Contact assignment is not turned on for this account, so the outcomes start without their agent overrides.';
  }
}

/** The sentence the server's refusal body carries, or null. */
function serverSentence(err: unknown): string | null {
  const details = (err as { details?: unknown } | null)?.details;
  const message = details && typeof details === 'object' ? (details as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.trim() !== '' ? message : null;
}

/**
 * What a template refusal says, by its code; the server's sentence for anything else. A template
 * that is archived or not found may be the one named or the organisation template it is based
 * on, which only the server's sentence tells apart (C5), so those keep it.
 */
export function templateRefusal(err: unknown, fallback: string): string {
  switch (errorCode(err)) {
    case 'campaign_template_changed':
      return 'Someone else saved this template after you opened it. Reload the latest version to see their changes.';
    case 'campaign_template_name_taken':
      return 'Another template here already has this name. Choose another name.';
    case 'campaign_template_in_use':
      return 'Account templates are based on this template, so it cannot be archived yet.';
    case 'campaign_template_archived':
      return serverSentence(err) ?? 'This template has been archived. Restore it first.';
    case 'campaign_template_not_found':
      return serverSentence(err) ?? 'This template no longer exists.';
    case 'tenant_wide_membership_required':
      return 'Only an organisation admin with access to every account can change organisation templates.';
    default:
      return err instanceof Error && err.message ? err.message : fallback;
  }
}

/** `text` as a sentence: trimmed, with a full stop unless it already ends one. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * A refusal's field details (`{ field: message }`, a list of messages, or such a map nested) as
 * sentences, each once, in order. The server's field messages are plain words; their keys are
 * field paths and are not shown.
 */
export function detailSentences(details: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.trim() !== '') out.push(asSentence(value));
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(details);
  return [...new Set(out)];
}

/** The field details of a refused request (the body's `details`, `ApiError.details.details`) as sentences. */
export function refusalDetails(err: unknown): string[] {
  const body = (err as { details?: unknown } | null)?.details;
  const details = body !== null && typeof body === 'object' ? (body as { details?: unknown }).details : undefined;
  return details !== null && typeof details === 'object' ? detailSentences(details) : [];
}
