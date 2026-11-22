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
import { sameCarrier, type CarrierChoice } from '../../../utils/agencyCarriers';
import { samePool } from '../../../utils/campaignSettingsChanges';
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

  const access = useTemplatesAccess();
  const read = useStartFrom(access.use);
  /** The filled-in settings the form was last filled from; null without templates. */
  const [startFrom, setStartFrom] = useState<AgencyCampaignTemplateEffective | null>(null);
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
      // Numbers a start leaves built-in are the operator's to pick: not the template's, and not a change (C2).
      if (key === 'numbers' && leavesNumbers(startFrom)) return null;
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

  /**
   * The numbers the last filling-in put on Basics (the template's, or none when it leaves them
   * built-in): anything else there was picked by the operator.
   */
  const filledNumbersRef = useRef<Numbers>(NO_NUMBERS);
  const pickedNumbers = useCallback(() => !sameNumbers(inputRef.current, filledNumbersRef.current), []);

  /**
   * Fill the form from `effective`, as if it had been typed: every section New campaign edits,
   * except those in `keep`, which stay as the operator left them. The numbers follow their own
   * rule (C2): a start that sets them puts its own, unless `keepNumbers`; a start that leaves
   * them built-in keeps the operator's when they picked some, and otherwise leaves Basics empty.
   */
  const fill = useCallback(
    (
      effective: AgencyCampaignTemplateEffective,
      how: { keep: readonly AgencyCampaignTemplateSectionKey[]; keepNumbers: boolean; preselected: boolean },
    ) => {
      const now = inputRef.current;
      const filled = formOfConfig(effective.config);
      const typed = typedForm(filled, now);
      let next: TemplateForm = { ...typed, config: filled.config, recording: filled.recording };
      for (const key of how.keep) next = withSectionFrom(next, typed, key);
      const templateNumbers = numbersOf(effective, filled);
      const numbers = how.keepNumbers ? { callerIds: now.callerIds, chosenCarrier: now.chosenCarrier } : templateNumbers;
      filledNumbersRef.current = templateNumbers;
      now.apply(
        { config: next.config, recordCalls: next.recording.record, ...numbers },
        // What the template fills in is the starting point, not an edit; kept sections stay edits.
        { baseline: { config: filled.config, recordCalls: filled.recording.record, ...templateNumbers }, outcomes: true },
      );
      setStartFrom(effective);
      trackAgencyCampaignTemplateStartedFrom({
        source: effective.template?.scope ?? 'builtin',
        preselected: how.preselected,
        note_count: effective.notes.length,
      });
    },
    [],
  );

  /*
    Open on the default chain. When the read lands after the operator has started (C8), the
    sections they have touched stay as typed (their chips then read "Changed for this
    campaign"), the rest are filled in, and the picker is offered all the same, so the create
    names the template it was filled from. Nothing typed is overwritten. A draft already made
    keeps what it has: nothing is filled into it.
  */
  const openingRef = useRef({ config, recordCalls });
  const filledInitialRef = useRef(false);
  useEffect(() => {
    if (filledInitialRef.current || read.status !== 'ready' || !read.initial) return;
    filledInitialRef.current = true;
    const now = inputRef.current;
    if (now.campaignId !== null) return;
    const filled = formOfConfig(read.initial.config);
    const opening = campaignFieldsOfForm({
      ...typedForm(filled, now),
      config: openingRef.current.config,
      recording: { ...filled.recording, record: openingRef.current.recordCalls },
    });
    const typed = campaignFieldsOfForm(typedForm(filled, now));
    fill(read.initial, {
      keep: TYPED_SECTIONS.filter((key) => !sameSection(key, opening, typed)),
      keepNumbers: now.callerIds.length > 0 || now.chosenCarrier !== null,
      preselected: true,
    });
  }, [read.status, read.initial, fill]);

  const changedRef = useRef<AgencyCampaignTemplateSectionKey[]>([]);
  changedRef.current = changedSections;
  /** A "Start from" read, waiting on "Replace your changes?", with how many sections it replaces. */
  const [pending, setPending] = useState<{ effective: AgencyCampaignTemplateEffective; count: number } | null>(null);

  /**
   * Switch "Start from": read the choice, then ask first when it would replace something the
   * operator changed. That is a changed section, or numbers they picked when the new start sets
   * different ones; numbers it leaves built-in are kept, so they are never asked about.
   */
  const switchStart = useCallback(
    async (choice: string) => {
      setSwitching(true);
      try {
        const effective = await read.read(choice);
        const filled = formOfConfig(effective.config);
        const replaced: AgencyCampaignTemplateSectionKey[] = changedRef.current.filter((k) => k !== 'numbers');
        const now = inputRef.current;
        if (
          !leavesNumbers(effective)
          && pickedNumbers()
          && !(samePool(now.callerIds, filled.callerIds) && sameCarrier(now.carrier, filled.carrier))
        ) {
          replaced.push('numbers');
        }
        if (replaced.length > 0) setPending({ effective, count: replaced.length });
        else fill(effective, { keep: [], keepNumbers: leavesNumbers(effective) && pickedNumbers(), preselected: false });
      } catch {
        inputRef.current.onReadFailed('Could not read that template. The form still holds what it had.');
      } finally {
        setSwitching(false);
      }
    },
    [fill, read, pickedNumbers],
  );

  /**
   * Put section `key` back as the template filled it in (Review's Reset). The numbers go back to
   * the template's: never to an empty pool, and not at all when it leaves them built-in.
   */
  const resetSection = useCallback(
    (key: AgencyCampaignTemplateSectionKey) => {
      if (!startFrom || !startForm || !builderForm) return;
      const next = withSectionFrom(builderForm, startForm, key);
      const now = inputRef.current;
      now.apply(
        {
          config: next.config,
          recordCalls: next.recording.record,
          ...(key === 'numbers' && !leavesNumbers(startFrom)
            ? { callerIds: next.callerIds.length > 0 ? next.callerIds : now.callerIds, chosenCarrier: next.carrier }
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
        if (choice !== current) void switchStart(choice);
      },
      disabled: campaignId !== null || switching,
      lockedNote: campaignId !== null ? 'The draft is made. Change its settings in the steps below.' : null,
      viewPath,
    }
    : null;

  const count = pending?.count ?? 0;
  const confirm = {
    open: pending !== null,
    message: `You changed ${count === 1 ? 'a section' : `${count} sections`} of these settings. Starting from another template replaces ${
      count === 1 ? 'it' : 'them'
    } with that template’s.`,
    onConfirm: () => {
      if (!pending) return;
      setPending(null);
      fill(pending.effective, { keep: [], keepNumbers: leavesNumbers(pending.effective) && pickedNumbers(), preselected: false });
    },
    onCancel: () => setPending(null),
  };

  /** A Review row's source chip and Reset, for the section it shows; nothing without templates. */
  const sourceProps = (key: AgencyCampaignTemplateSectionKey) =>
    startFrom ? { source: sectionSource(key), onReset: () => resetSection(key) } : {};

  return { startFrom, builderFields, panel, confirm, sourceProps, createFields };
}

type Numbers = Pick<BuilderTemplateValues, 'callerIds' | 'chosenCarrier'>;
const NO_NUMBERS: Numbers = { callerIds: [], chosenCarrier: null };

/** The sections New campaign's own steps edit: what a late filling-in keeps when typed (C8). */
const TYPED_SECTIONS: readonly AgencyCampaignTemplateSectionKey[] = [
  'outcomes', 'retries', 'hours', 'wrapup', 'recording', 'safety', 'assignment', 'inbound',
];

/** The start leaves the numbers to the operator: an organisation template, the built-in settings, or an account template that sets none. */
function leavesNumbers(effective: AgencyCampaignTemplateEffective): boolean {
  return effective.sources.numbers === 'builtin';
}

/** The numbers a start puts on Basics: its own, or none yet when it leaves them built-in (Basics asks). */
function numbersOf(effective: AgencyCampaignTemplateEffective, filled: TemplateForm): Numbers {
  return leavesNumbers(effective) ? NO_NUMBERS : { callerIds: filled.callerIds, chosenCarrier: filled.carrier };
}

function sameNumbers(a: Numbers, b: Numbers): boolean {
  if (!samePool(a.callerIds, b.callerIds)) return false;
  if (a.chosenCarrier === null || b.chosenCarrier === null) return a.chosenCarrier === b.chosenCarrier;
  return sameCarrier(a.chosenCarrier, b.chosenCarrier);
}

/** The form as typed, with the parts New campaign does not edit as `filled` has them. */
function typedForm(filled: TemplateForm, now: BuilderTemplateInput): TemplateForm {
  return {
    ...filled,
    config: now.config,
    recording: { ...filled.recording, record: now.recordCalls },
    callerIds: now.callerIds,
    carrier: now.carrier,
  };
}
