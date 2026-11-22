import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  type AgencyCampaignTemplateEffective,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSectionSource,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { trackAgencyCampaignTemplateStartedFrom } from '../../../analytics/events';
import { CAMPAIGN_TEMPLATES_PATH, campaignTemplatePath } from '../../../utils/consoleNav';
import {
  campaignFieldsOfForm,
  formOfConfig,
  sameSection,
  withSectionFrom,
  type TemplateForm,
} from '../../../utils/agency/campaignTemplates/templateForm';
import { buildConfigPayload, validateConfig, type CampaignConfigState } from '../../../utils/agencyCampaignConfigForm';
import { NO_ANALYSIS_PROFILE, recordingPayload } from '../../../utils/agencyCampaignRecording';
import type { CarrierChoice } from '../../../utils/agencyCarriers';
import { BUILT_IN_START, useStartFrom } from './useStartFrom';
import { useTemplatesAccess } from './useTemplatesAccess';

/** What New campaign's own steps hold of a template's sections. */
export interface BuilderTemplateValues {
  config: CampaignConfigState;
  recordCalls: boolean;
  callerIds: string[];
  /** `null`: the page's default carrier stands. */
  chosenCarrier: CarrierChoice | null;
}

export interface BuilderTemplateInput extends BuilderTemplateValues {
  /** The draft, once a roster upload or a save has made it: the picker is locked from then on. */
  campaignId: string | null;
  /** The carrier as the page would send it (the chosen one, else its default). */
  carrier: CarrierChoice;
  recordingEnabled: boolean;
  assignmentEnabled: boolean;
  /**
   * Put values on the form. `baseline` is set when they are what a template fills in, the
   * starting point rather than an edit (the page's unsaved-input baseline and its analytics);
   * `outcomes` when the outcome list was replaced, so its editors remount.
   */
  apply: (next: Partial<BuilderTemplateValues>, how: { baseline: BuilderTemplateValues | null; outcomes: boolean }) => void;
  /** A "Start from" read failed: the form keeps what it had. */
  onReadFailed: (message: string) => void;
}

/**
 * New campaign's campaign templates (`docs/campaign-templates.md` §7), as one hook the page
 * composes: the filled-in settings ("Start from" and its read), filling the form from them,
 * where each section now comes from (Review's chips) and its Reset, the "Replace your changes?"
 * question, and what the create sends (`template_id` and the sections, CT8, CT9). With the flag
 * off, or the reads failing, `startFrom` stays null and every part of it is inert: the page is as
 * it was before templates.
 */
export function useBuilderTemplate(input: BuilderTemplateInput) {
  const { campaignId, config, recordCalls, callerIds, carrier, recordingEnabled, assignmentEnabled } = input;
  const inputRef = useRef(input);
  inputRef.current = input;
  /** The config the page opened with: still this object, nothing on the form has been edited. */
  const openingConfigRef = useRef(config);

  const access = useTemplatesAccess();
  const read = useStartFrom(access.use);
  /** The filled-in settings the form was last filled from; null without templates. */
  const [startFrom, setStartFrom] = useState<AgencyCampaignTemplateEffective | null>(null);
  /** A "Start from" choice waiting on "replace your changes?". */
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  /*
    The form as a template's sections see it (the parts New campaign does not edit, the break
    limits, what agents see and the summary profile, are the filled-in template's), and where each
    section now comes from: the filled-in source while it is unchanged, `campaign` once changed
    (compared by the domain's normalisation, as the server records it, CT9).
  */
  const startForm = useMemo(() => (startFrom ? formOfConfig(startFrom.config) : null), [startFrom]);
  const builderForm = useMemo<TemplateForm | null>(
    () => (startForm
      ? { ...startForm, config, recording: { ...startForm.recording, record: recordCalls }, callerIds, carrier }
      : null),
    [startForm, config, recordCalls, callerIds, carrier],
  );
  const builderFields = useMemo(() => (builderForm ? campaignFieldsOfForm(builderForm) : null), [builderForm]);
  const sectionSource = useCallback(
    (key: AgencyCampaignTemplateSectionKey): AgencyCampaignTemplateSectionSource | null => {
      if (!startFrom || !builderFields) return null;
      return sameSection(key, builderFields, startFrom.config) ? startFrom.sources[key] : 'campaign';
    },
    [startFrom, builderFields],
  );
  const changedSections = startFrom
    ? AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.filter((k) => sectionSource(k) === 'campaign')
    : [];

  /*
    With a template in play the create names it (`template_id`, null for the built-in settings) and
    carries every section New campaign shows, when they pass their checks, plus the filled-in break
    limits, agent screen and summary profile: so the server records each section's source as it is
    at the create (CT9), and nothing is left to a default chain the picker moved away from. Sections
    still being fixed are left out and filled in from the template; Save campaign sends them.
  */
  const createFields = useMemo(() => {
    if (!startFrom || !builderFields) return {};
    if (Object.keys(validateConfig(config)).length > 0) return { template_id: startFrom.template?.id ?? null };
    const { record_calls } = recordingPayload({
      recordingEnabled,
      analyticsEnabled: false,
      next: { record: recordCalls, profileId: NO_ANALYSIS_PROFILE },
    });
    return {
      template_id: startFrom.template?.id ?? null,
      ...buildConfigPayload(config, assignmentEnabled ? 'all' : 'none'),
      ...(record_calls !== undefined ? { record_calls, analysis_profile_id: builderFields.analysis_profile_id ?? null } : {}),
      break_reasons: builderFields.break_reasons,
      agent_script: builderFields.agent_script,
      phone_display: builderFields.phone_display,
      daily_target_calls: builderFields.daily_target_calls,
    };
  }, [startFrom, builderFields, config, recordingEnabled, recordCalls, assignmentEnabled]);

  /** Fill the form from `effective`: every section New campaign edits, as if it had been typed. */
  const fillFrom = useCallback((effective: AgencyCampaignTemplateEffective, preselected: boolean) => {
    const form = formOfConfig(effective.config);
    openingConfigRef.current = form.config;
    // A template's numbers when it sets them; the built-in "none yet" otherwise (Basics asks).
    const ownNumbers = effective.sources.numbers !== 'builtin';
    const values: BuilderTemplateValues = {
      config: form.config,
      recordCalls: form.recording.record,
      callerIds: ownNumbers ? form.callerIds : [],
      chosenCarrier: ownNumbers ? form.carrier : null,
    };
    // Before a draft exists, what the template fills in is the starting point, not an edit.
    inputRef.current.apply(values, { baseline: values, outcomes: true });
    setStartFrom(effective);
    trackAgencyCampaignTemplateStartedFrom({
      source: effective.template?.scope ?? 'builtin',
      preselected,
      note_count: effective.notes.length,
    });
  }, []);

  // Open on the default chain, unless something was typed into the settings first.
  const filledInitialRef = useRef(false);
  useEffect(() => {
    if (filledInitialRef.current || read.status !== 'ready' || !read.initial) return;
    filledInitialRef.current = true;
    const now = inputRef.current;
    if (now.campaignId !== null || now.config !== openingConfigRef.current || now.recordCalls || now.callerIds.length > 0) return;
    fillFrom(read.initial, true);
  }, [read.status, read.initial, fillFrom]);

  const switchStart = useCallback(
    async (choice: string) => {
      setPendingStart(null);
      setSwitching(true);
      try {
        fillFrom(await read.read(choice), false);
      } catch {
        inputRef.current.onReadFailed('Could not read that template. The form still holds what it had.');
      } finally {
        setSwitching(false);
      }
    },
    [fillFrom, read],
  );

  /** Put section `key` back as the template filled it in (Review's Reset). */
  const resetSection = useCallback(
    (key: AgencyCampaignTemplateSectionKey) => {
      if (!startFrom || !startForm || !builderForm) return;
      const next = withSectionFrom(builderForm, startForm, key);
      inputRef.current.apply(
        {
          config: next.config,
          recordCalls: next.recording.record,
          ...(key === 'numbers'
            ? { callerIds: next.callerIds, chosenCarrier: startFrom.sources.numbers === 'builtin' ? null : next.carrier }
            : {}),
        },
        { baseline: null, outcomes: key === 'outcomes' },
      );
    },
    [startFrom, startForm, builderForm],
  );

  /** "View template": the template's editor, or the list where the reader may read it; null when neither. */
  const viewPath = (() => {
    const t = startFrom?.template;
    if (!t) return null;
    if (t.scope === 'account') return access.manage ? campaignTemplatePath('account', t.id) : null;
    if (access.manageOrganisation) return campaignTemplatePath('organisation', t.id);
    return access.manage ? CAMPAIGN_TEMPLATES_PATH : null;
  })();

  const current = startFrom?.template?.id ?? BUILT_IN_START;
  const panel = startFrom && read.status === 'ready'
    ? {
      templates: read.templates,
      effective: startFrom,
      value: current,
      onChange: (choice: string) => {
        if (choice === current) return;
        if (changedSections.length > 0) setPendingStart(choice);
        else void switchStart(choice);
      },
      disabled: campaignId !== null || switching,
      lockedNote: campaignId !== null ? 'The draft is made. Change its settings in the steps below.' : null,
      viewPath,
    }
    : null;

  const count = changedSections.length;
  const confirm = {
    open: pendingStart !== null,
    message: `You changed ${count === 1 ? 'a section' : `${count} sections`} of these settings. Starting from another template replaces ${
      count === 1 ? 'it' : 'them'
    } with that template’s.`,
    onConfirm: () => void switchStart(pendingStart!),
    onCancel: () => setPendingStart(null),
  };

  /** A Review row's source chip and Reset, for the section it shows; nothing without templates. */
  const sourceProps = (key: AgencyCampaignTemplateSectionKey) =>
    startFrom ? { source: sectionSource(key), onReset: () => resetSection(key) } : {};

  return { startFrom, builderFields, panel, confirm, sourceProps, createFields };
}
