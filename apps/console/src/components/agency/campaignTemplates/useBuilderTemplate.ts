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
import { recordingPayload, type CampaignRecordingState } from '../../../utils/agencyCampaignRecording';
import { sameCarrier, type CarrierChoice } from '../../../utils/agencyCarriers';
import { samePool } from '../../../utils/campaignSettingsChanges';
import {
  cardKeys,
  dailyTargetError,
  factsFormOf,
  scriptErrors,
  scriptPayload,
  type FactsForm,
  type ScriptForm,
} from '../../../utils/agency/stationSettings';
import { breakReasonsErrors, type BreakReasonsForm } from '../../../utils/agency/breakLimits';
import {
  AGENCY_SCRIPT_PLACEHOLDERS,
  type AgencyAgentScript,
  type AgencyContextDisplay,
  type AgencyPhoneDisplay,
} from '@magick-agency/contracts/agency';
import { unknownPlaceholdersIn } from '@magick-agency/domain/fact-fields';
import { sameTemplateValue } from '@magick-agency/domain/campaign-templates';
import { BUILT_IN_START, useStartFrom } from './useStartFrom';
import { useTemplatesAccess } from './useTemplatesAccess';

/** What New campaign's own steps hold of a template's sections. */
export interface BuilderTemplateValues {
  config: CampaignConfigState;
  /** The record flag and the call summary profile: the template's recording section, whole (CT5). */
  recording: CampaignRecordingState;
  callerIds: string[];
  /** `null`: the page's default carrier stands. */
  chosenCarrier: CarrierChoice | null;
  /** The break limits (Agents & timing, under Advanced): the template's breaks section. */
  breakReasons: BreakReasonsForm;
  /**
   * The daily target and the number display (Agents & timing's agent screen): with the script,
   * which this hook holds, the template's agent screen section.
   */
  agentScreen: BuilderAgentScreen;
}

/** The two agent screen settings New campaign's own step edits. */
export interface BuilderAgentScreen {
  dailyTarget: string;
  phoneDisplay: AgencyPhoneDisplay;
}

export interface BuilderTemplateInput extends BuilderTemplateValues {
  /** The draft, once a roster upload or a save has made it: the picker is locked from then on. */
  campaignId: string | null;
  /** The carrier as the page would send it (the chosen one, else its default). */
  carrier: CarrierChoice;
  recordingEnabled: boolean;
  /** The account's `agency.analytics`: whether the create may carry a profile. */
  analyticsEnabled: boolean;
  assignmentEnabled: boolean;
  /**
   * Put values on the form. `baseline` is set when they are what a template fills in, the
   * starting point rather than an edit (the page's unsaved-input baseline and its analytics);
   * `outcomes` when the outcome list was replaced, so the editors that keep state of their own
   * about its rows (Purpose & buttons) start again on the new rows.
   */
  apply: (next: Partial<BuilderTemplateValues>, how: { baseline: BuilderTemplateValues | null; outcomes: boolean }) => void;
  /** A "Start from" read failed: the form keeps what it had. */
  onReadFailed: (message: string) => void;
}

/**
 * New campaign's campaign templates (`docs/campaign-templates.md` §7), as one hook the page
 * composes: the filled-in settings ("Start from" and its read), filling the form from them,
 * where each section now comes from (the chip at the block that edits it, CS18) and its Reset,
 * the "Replace your changes?" question, the template's script and its fix (CS19, CTC10), and
 * what the create sends (`template_id` and the sections, CT8, CT9). With the flag
 * off, or the reads failing, `startFrom` stays null and every part of it is inert: the page is as
 * it was before templates.
 */
export function useBuilderTemplate(input: BuilderTemplateInput) {
  const {
    campaignId, config, recording, callerIds, carrier, breakReasons, agentScreen, recordingEnabled, analyticsEnabled, assignmentEnabled,
  } = input;
  const inputRef = useRef(input);
  inputRef.current = input;

  const access = useTemplatesAccess();
  const read = useStartFrom(access.use);
  /** The filled-in settings the form was last filled from; null without templates. */
  const [startFrom, setStartFrom] = useState<AgencyCampaignTemplateEffective | null>(null);
  const [switching, setSwitching] = useState(false);

  /*
    The form as a template's sections see it (every section is on one of New campaign's steps;
    the script, which the page does not hold, is this hook's), and where each section now comes from: the filled-in source while it is unchanged, `campaign` once changed
    (compared by the domain's normalisation, as the server records it, CT9).
  */
  const startForm = useMemo(() => (startFrom ? formOfConfig(startFrom.config) : null), [startFrom]);
  /**
   * The script, shown and edited on Purpose & buttons (CS19), and held back there when the
   * roster's card lacks a key it uses (CTC10); the filled-in template's until it is changed.
   */
  const [script, setScript] = useState<ScriptForm | null>(null);
  const builderForm = useMemo<TemplateForm | null>(
    () => (startForm
      ? typedForm(
        script ? { ...startForm, station: { ...startForm.station, script } } : startForm,
        { config, recording, breakReasons, agentScreen, callerIds, carrier },
      )
      : null),
    [startForm, config, recording, breakReasons, agentScreen, script, callerIds, carrier],
  );
  const builderFields = useMemo(() => (builderForm ? campaignFieldsOfForm(builderForm) : null), [builderForm]);
  const sectionSource = useCallback(
    (key: AgencyCampaignTemplateSectionKey): AgencyCampaignTemplateSectionSource | null => {
      if (!startFrom || !builderFields) return null;
      // Numbers a start leaves built-in are the operator's to pick: not the template's, and not a change (CTC2).
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
    carries every section New campaign shows, when they pass their checks (the script included):
    so the server records each section's source as it is at the create
    (CT9), and nothing is left to a default chain the picker moved away from. Sections still being
    fixed are left out and filled in from the template; Save campaign sends them.

    The recording section goes whole or not at all: a section sent with a field left out takes that
    field's BUILT-IN value on the server, so a flag sent without the profile would drop the
    template's profile. It is left out (the template's, as the server filled it in) when either
    field would be refused: recording switched on, or a profile set, where the account may not.
  */
  const scriptNow = builderForm?.station.script ?? null;
  const createFields = useMemo(() => {
    if (!startFrom || !builderFields) return {};
    const fixing = Object.keys(validateConfig(config)).length > 0
      || Object.keys(breakReasonsErrors(breakReasons)).length > 0
      || dailyTargetError(agentScreen.dailyTarget) !== null
      // Before the import saves a card the script takes the keys a script with no card takes.
      || (scriptNow !== null && Object.keys(scriptErrors(scriptNow, [...AGENCY_SCRIPT_PLACEHOLDERS])).length > 0);
    if (fixing) return { template_id: startFrom.template?.id ?? null };
    const recordingFields = recordingPayload({ recordingEnabled, analyticsEnabled, next: recording });
    const wholeRecording = recordingFields.record_calls !== undefined && recordingFields.analysis_profile_id !== undefined;
    return {
      template_id: startFrom.template?.id ?? null,
      ...buildConfigPayload(config, assignmentEnabled ? 'all' : 'none'),
      ...(wholeRecording ? recordingFields : {}),
      break_reasons: builderFields.break_reasons,
      agent_script: builderFields.agent_script,
      phone_display: builderFields.phone_display,
      daily_target_calls: builderFields.daily_target_calls,
    };
  }, [startFrom, builderFields, config, breakReasons, agentScreen, scriptNow, recordingEnabled, analyticsEnabled, recording, assignmentEnabled]);

  /**
   * The numbers the last filling-in put on Basics (the template's, or none when it leaves them
   * built-in): anything else there was picked by the operator.
   */
  const filledNumbersRef = useRef<Numbers>(NO_NUMBERS);
  const pickedNumbers = useCallback(() => !sameNumbers(inputRef.current, filledNumbersRef.current), []);

  /**
   * Fill the form from `effective`, as if it had been typed: every section New campaign edits,
   * except those in `keep`, which stay as the operator left them. The numbers follow their own
   * rule (CTC2): a start that sets them puts its own, unless `keepNumbers`; a start that leaves
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
      let next: TemplateForm = {
        ...typed,
        config: filled.config,
        recording: filled.recording,
        breakReasons: filled.breakReasons,
        station: filled.station,
      };
      for (const key of how.keep) next = withSectionFrom(next, typed, key);
      const templateNumbers = numbersOf(effective, filled);
      const numbers = how.keepNumbers ? { callerIds: now.callerIds, chosenCarrier: now.chosenCarrier } : templateNumbers;
      filledNumbersRef.current = templateNumbers;
      now.apply(
        { config: next.config, recording: next.recording, breakReasons: next.breakReasons, agentScreen: agentScreenOf(next), ...numbers },
        // What the template fills in is the starting point, not an edit; kept sections stay edits.
        {
          baseline: {
            config: filled.config,
            recording: filled.recording,
            breakReasons: filled.breakReasons,
            agentScreen: agentScreenOf(filled),
            ...templateNumbers,
          },
          outcomes: true,
        },
      );
      setScript(next.station.script);
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
    Open on the default chain. When the read lands after the operator has started (CTC8), the
    sections they have touched stay as typed (their chips then read "Changed for this
    campaign"), the rest are filled in, and the picker is offered all the same, so the create
    names the template it was filled from. Nothing typed is overwritten. A draft already made
    keeps what it has: nothing is filled into it.
  */
  const openingRef = useRef({ config, recording, breakReasons, agentScreen });
  const filledInitialRef = useRef(false);
  useEffect(() => {
    if (filledInitialRef.current || read.status !== 'ready' || !read.initial) return;
    filledInitialRef.current = true;
    const now = inputRef.current;
    if (now.campaignId !== null) return;
    const filled = formOfConfig(read.initial.config);
    const opening = campaignFieldsOfForm(typedForm(filled, { ...now, ...openingRef.current }));
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
   * Put section `key` back as the template filled it in (its Reset, CS18). The numbers go back to
   * the template's: never to an empty pool, and not at all when it leaves them built-in.
   */
  const resetSection = useCallback(
    (key: AgencyCampaignTemplateSectionKey) => {
      if (!startFrom || !startForm || !builderForm) return;
      const next = withSectionFrom(builderForm, startForm, key);
      if (key === 'agent_screen') setScript(next.station.script);
      const now = inputRef.current;
      now.apply(
        {
          config: next.config,
          recording: next.recording,
          breakReasons: next.breakReasons,
          agentScreen: agentScreenOf(next),
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

  /** A section's source chip and Reset, for the block that edits it (CS18); nothing without templates. */
  const sourceProps = (key: AgencyCampaignTemplateSectionKey) =>
    startFrom ? { source: sectionSource(key), onReset: () => resetSection(key) } : {};

  /*
    The script and the roster's card (CTC10, AS19). A template's script may use `{amount_due}` and
    `{due_date}`, which a campaign without a card allows (the legacy keys, so the create takes
    it), but the card the import saves has its own keys: a card without those facts would be
    refused for taking away keys the draft's script uses, and the import with it. So the card's
    save then carries an empty script (the draft has none for now), and Purpose & buttons says
    why, opens the script editor on the card's keys and marks its step, and Save as draft and
    Start wait until the script fits (CS19); the save then sends it.
  */
  /** The card the import saved on the draft; null while it has none (the legacy keys). */
  const [card, setCard] = useState<FactsForm | null>(null);
  /** The script the draft holds, as last sent; null before the draft exists or without templates. */
  const draftScriptRef = useRef<AgencyAgentScript | null>(null);
  const allowedKeys = useMemo(() => (card ? cardKeys(card) : [...AGENCY_SCRIPT_PLACEHOLDERS]), [card]);
  const scriptErrs = useMemo(
    () => (startFrom && script ? scriptErrors(script, allowedKeys) : {}),
    [startFrom, script, allowedKeys],
  );
  /*
    Shown on Purpose & buttons when the template brings a script, or one is held back or typed: a
    template with no script leaves New campaign without one, as before (Settings has the editor).
  */
  const scriptShown = startForm !== null && script !== null
    && (hasText(startForm.station.script) || hasText(script) || Object.keys(scriptErrs).length > 0);
  const scriptFix = scriptShown
    ? { value: script!, onChange: setScript, errors: scriptErrs, allowed: allowedKeys, facts: card ?? EMPTY_CARD }
    : null;
  const latestRef = useRef({ builderFields, script });
  latestRef.current = { builderFields, script };
  const startScriptRef = useRef<AgencyAgentScript | null>(null);
  startScriptRef.current = startForm ? scriptPayload(startForm.station.script) : null;
  const draft = useMemo(() => ({
    /**
     * The draft was created with `sent` (the create's template fields): its script is the one
     * sent, else the template's, which the server filled in.
     */
    created: (sent: { agent_script?: unknown }) => {
      if (!latestRef.current.builderFields) {
        draftScriptRef.current = null;
        return;
      }
      draftScriptRef.current = (sent.agent_script as AgencyAgentScript | undefined) ?? startScriptRef.current;
    },
    /** What the PATCH that saves the card `display` also sends: an empty script when the draft's would not fit it. */
    cardFields: (display: AgencyContextDisplay): { agent_script?: AgencyAgentScript } => {
      if (!display.facts) return {};
      const nextCard = factsFormOf(display, null);
      setCard(nextCard);
      const held = draftScriptRef.current;
      if (!held || unknownPlaceholdersIn(scriptTextOf(held), cardKeys(nextCard)).length === 0) return {};
      draftScriptRef.current = {};
      return { agent_script: {} };
    },
    /** What Save as draft's PATCH also sends: the script, when it is not what the draft holds. */
    saveFields: (): { agent_script?: AgencyAgentScript } => {
      const { script } = latestRef.current;
      if (!script || draftScriptRef.current === null) return {};
      const next = scriptPayload(script);
      return sameTemplateValue(next, draftScriptRef.current) ? {} : { agent_script: next };
    },
    /** Save as draft went through with `sent`. */
    saved: (sent: { agent_script?: AgencyAgentScript }) => {
      if (sent.agent_script) draftScriptRef.current = sent.agent_script;
    },
  }), []);

  return {
    startFrom,
    panel,
    confirm,
    sourceProps,
    createFields,
    script: scriptFix,
    /** The script does not fit (the card's keys, or its own checks): the saves wait for its fix on Purpose & buttons. */
    scriptBlocked: Object.keys(scriptErrs).length > 0,
    draft,
  };
}

type Numbers = Pick<BuilderTemplateValues, 'callerIds' | 'chosenCarrier'>;
const NO_NUMBERS: Numbers = { callerIds: [], chosenCarrier: null };

/** The sections New campaign's own steps edit: what a late filling-in keeps when typed (CTC8). */
const TYPED_SECTIONS: readonly AgencyCampaignTemplateSectionKey[] = [
  'outcomes', 'retries', 'hours', 'wrapup', 'breaks', 'recording', 'agent_screen', 'safety', 'assignment', 'inbound',
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

/** The form as typed, with the script (which the page does not hold) as `filled` has it. */
function typedForm(
  filled: TemplateForm,
  now: Pick<BuilderTemplateInput, 'config' | 'recording' | 'breakReasons' | 'agentScreen' | 'callerIds' | 'carrier'>,
): TemplateForm {
  return {
    ...filled,
    config: now.config,
    recording: now.recording,
    breakReasons: now.breakReasons,
    station: { ...filled.station, dailyTarget: now.agentScreen.dailyTarget, phoneDisplay: now.agentScreen.phoneDisplay },
    callerIds: now.callerIds,
    carrier: now.carrier,
  };
}

/** The agent screen settings the page holds, out of a form. */
function agentScreenOf(form: TemplateForm): BuilderAgentScreen {
  return { dailyTarget: form.station.dailyTarget, phoneDisplay: form.station.phoneDisplay };
}

/** A card with no facts: the script editor's `facts` before the import saves one. */
const EMPTY_CARD: FactsForm = Object.freeze({ name: '', place: null, list: [], types: {} }) as FactsForm;

/** Whether a script form says anything. */
function hasText(script: ScriptForm): boolean {
  return script.opening.trim() !== '' || script.steps.some((step) => step.trim() !== '');
}

/** Every text of a stored script, one per line. */
function scriptTextOf(script: AgencyAgentScript): string {
  return [script.opening ?? '', ...(script.steps ?? []).map((step) => step.text)].join('\n');
}
