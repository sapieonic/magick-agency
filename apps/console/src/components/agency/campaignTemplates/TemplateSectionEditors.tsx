import { useMemo } from 'react';
import type {
  AgencyCampaignTemplateScope,
  AgencyCampaignTemplateSectionKey,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import type { AgencyCarrier } from '@magick-agency/contracts/api/agency/agency-campaign';
import { SetupSection } from '../../campaign-setup';
import { BreakLimitsEditor } from '../../../pages/campaigns/agency/BreakLimitsEditor';
import { ScriptEditor } from '../../../pages/campaigns/agency/ScriptEditor';
import { RetryPolicyTable } from '../../../pages/campaigns/agency/RetryPolicyTable';
import { WrapupFields } from '../../../pages/campaigns/agency/WrapupFields';
import { AbandonmentCeilingFields } from '../../../pages/campaigns/agency/AbandonmentCeilingFields';
import { AssignmentFields } from '../../../pages/campaigns/agency/AssignmentFields';
import { InboundStickyField } from '../../../pages/campaigns/agency/InboundStickyField';
import { useConfigFieldErrors, type ConfigFieldErrors } from '../../../pages/campaigns/agency/configFieldErrors';
import { PurposeButtonsStep } from '../../../pages/campaigns/agency/setup/PurposeButtonsStep';
import { CallingHoursBlock } from '../../../pages/campaigns/agency/setup/CallingHoursBlock';
import { UnansweredRuleBlock } from '../../../pages/campaigns/agency/setup/UnansweredRuleBlock';
import { AgentScreenRows, RecordingRows, WrapupRow } from '../../../pages/campaigns/agency/setup/AgentScreenRows';
import { CallerNumbersBlock } from '../../../pages/campaigns/agency/setup/CallerNumbersBlock';
import stepStyles from '../../../pages/campaigns/agency/setup/AgentsTimingStep.module.css';
import { useCallAnalysisProfiles } from '../../../hooks/useCallAnalysisProfiles';
import { carrierActive, carrierOptions, sameCarrier } from '../../../utils/agencyCarriers';
import {
  TEMPLATE_FACTS,
  templateScriptKeys,
  type TemplateForm,
} from '../../../utils/agency/campaignTemplates/templateForm';

export interface TemplateSectionEditorsProps {
  section: AgencyCampaignTemplateSectionKey;
  form: TemplateForm;
  onChange: (next: TemplateForm) => void;
  scope: AgencyCampaignTemplateScope;
  /** The form's own findings for the sections the template sets (`templateFormErrors`): shown quietly. */
  liveErrors: Record<string, string>;
  /** The server's refusal of the last save, by campaign field path (CT4); wins over a live finding. */
  serverErrors: Record<string, string>;
  /** The account may record (`agency.recording`); an organisation template may set it either way. */
  recordingEnabled: boolean;
  /** The account has call summaries (`agency.analytics`). */
  analyticsEnabled: boolean;
  carriers: readonly AgencyCarrier[] | null;
  /** Bumped when the outcomes were replaced from outside (Copy from a campaign, Discard). */
  epoch?: number;
  /** The call summary profile the saved template holds: keeps "Remove" reachable with analytics off. */
  savedProfileId?: string | null;
}

/**
 * One template section's editors (CS21): the campaign setup steps' own blocks, the ones New
 * campaign and campaign Settings show, fed from the template's form
 * (`utils/agency/campaignTemplates/templateForm.ts`). The rules stay in the forms' modules; this
 * only picks the block that edits exactly the section:
 *
 *  - outcomes: Purpose & buttons whole (starting points, the buttons as sentences, the agent's
 *    view, and under Advanced the full editor and the unanswered calls);
 *  - hours: "When to call" (`CallingHoursBlock`);
 *  - retries: the one "doesn't pick up" sentence (`UnansweredRuleBlock`) and the full table;
 *  - wrapup, recording, agent_screen: Agents & timing's rows (`WrapupRow`, `RecordingRows`,
 *    `AgentScreenRows`), with wrap-up's other two settings and the script (CT22's keys) under them;
 *  - breaks, safety, assignment, inbound: the blocks Agents & timing keeps under Advanced;
 *  - numbers: Name & number's carrier and numbers (`CallerNumbersBlock`).
 */
export function TemplateSectionEditors({
  section,
  form,
  onChange,
  scope,
  liveErrors,
  serverErrors,
  recordingEnabled,
  analyticsEnabled,
  carriers,
  epoch = 0,
  savedProfileId = null,
}: TemplateSectionEditorsProps) {
  const merged = useMemo(() => ({ ...liveErrors, ...serverErrors }), [liveErrors, serverErrors]);
  const quiet = useMemo(
    () => new Set(Object.keys(liveErrors).filter((field) => !(field in serverErrors))),
    [liveErrors, serverErrors],
  );
  const errors = useConfigFieldErrors(merged, quiet);
  const scriptKeys = useMemo(() => templateScriptKeys(), []);
  const config = form.config;
  const setConfig = (next: TemplateForm['config']) => onChange({ ...form, config: next });

  switch (section) {
    case 'outcomes':
      return (
        <PurposeButtonsStep
          framed={false}
          mode="create"
          config={config}
          onChange={setConfig}
          fieldErrors={serverErrors}
          buttonsReplaced={epoch}
        />
      );
    case 'hours':
      return (
        <CallingHoursBlock window={config.window} onChange={(window) => setConfig({ ...config, window })} errors={errors} />
      );
    case 'retries':
      return (
        <>
          <UnansweredRuleBlock retryPolicy={config.retryPolicy} onChange={(retryPolicy) => setConfig({ ...config, retryPolicy })} />
          <RetryPolicyTable
            retryPolicy={config.retryPolicy}
            onChange={(retryPolicy) => setConfig({ ...config, retryPolicy })}
            errors={errors}
          />
        </>
      );
    case 'wrapup':
      return (
        <>
          <div className={stepStyles.rows}>
            <WrapupRow
              wrapupSeconds={config.wrapupSeconds}
              autoReturn={config.autoReturn}
              onChange={(wrapupSeconds) => setConfig({ ...config, wrapupSeconds })}
              errors={errors}
            />
          </div>
          <WrapupFields
            wrapupSeconds={config.wrapupSeconds}
            autoReturn={config.autoReturn}
            allowRedial={config.allowWrapupRedial}
            onChange={(patch) => setConfig({ ...config, ...patch })}
            errors={errors}
            seconds={false}
          />
        </>
      );
    case 'recording':
      return (
        <TemplateRecording
          form={form}
          onChange={onChange}
          scope={scope}
          recordingEnabled={recordingEnabled}
          analyticsEnabled={analyticsEnabled}
          savedProfileId={savedProfileId}
          errors={errors}
        />
      );
    case 'agent_screen':
      return (
        <>
          <div className={stepStyles.rows}>
            <AgentScreenRows
              dailyTarget={form.station.dailyTarget}
              phoneDisplay={form.station.phoneDisplay}
              onChange={(patch) => onChange({ ...form, station: { ...form.station, ...patch } })}
              errors={errors}
            />
          </div>
          <SetupSection
            title="Script"
            helper="What agents say on a call, step by step, beside the buttons they pick."
            testId="template-script"
          >
            <ScriptEditor
              value={form.station.script}
              onChange={(script) => onChange({ ...form, station: { ...form.station, script } })}
              errors={errors}
              facts={TEMPLATE_FACTS}
              offered={scriptKeys}
              allowed={scriptKeys}
              phoneDisplay={form.station.phoneDisplay}
              keysHint="A template has no customer card, so its script can use only the keys below. Each campaign fills them in from its contacts."
            />
          </SetupSection>
        </>
      );
    case 'breaks':
      return (
        <BreakLimitsEditor
          value={form.breakReasons}
          onChange={(breakReasons) => onChange({ ...form, breakReasons })}
          serverError={serverErrors['break_reasons'] ?? null}
          icons
          fieldErrors={serverErrors}
        />
      );
    case 'safety':
      return (
        <AbandonmentCeilingFields
          ceilingPct={config.abandonmentCeilingPct}
          storedPct={config.abandonmentCeilingStoredPct}
          onChange={(abandonmentCeilingPct) => setConfig({ ...config, abandonmentCeilingPct })}
          errors={errors}
        />
      );
    case 'assignment':
      return (
        <AssignmentFields
          assignment={config.assignment}
          onChange={(assignment) => setConfig({ ...config, assignment })}
          errors={errors}
          modeLocked={false}
        />
      );
    case 'inbound':
      return (
        <InboundStickyField checked={config.inboundSticky} onChange={(inboundSticky) => setConfig({ ...config, inboundSticky })} />
      );
    case 'numbers':
      return (
        <CallerNumbersBlock
          carrierChoices={carrierOptions(carriers ?? [], form.carrier)}
          carrier={form.carrier}
          onCarrier={(carrier) => onChange({ ...form, carrier })}
          carrierError={merged['telephony_credential_id'] ?? merged['telephony_provider']}
          carrierLabel={carriers?.find((c) => sameCarrier(c, form.carrier))?.label ?? null}
          carrierActive={carrierActive(carriers, form.carrier)}
          callerIds={form.callerIds}
          onCallerIds={(callerIds) => onChange({ ...form, callerIds })}
          callerIdsError={merged['caller_ids'] ?? null}
        />
      );
    default:
      return null;
  }
}

/**
 * The recording section: Agents & timing's record and call summary rows. An organisation template
 * holds no account's profile, so it has the record row only (CT5), and may set it either way; the
 * account's profiles are read only for an account template.
 */
function TemplateRecording({
  form,
  onChange,
  scope,
  recordingEnabled,
  analyticsEnabled,
  savedProfileId,
  errors,
}: {
  form: TemplateForm;
  onChange: (next: TemplateForm) => void;
  scope: AgencyCampaignTemplateScope;
  recordingEnabled: boolean;
  analyticsEnabled: boolean;
  savedProfileId: string | null;
  errors: ConfigFieldErrors;
}) {
  const account = scope === 'account';
  const { profiles, loading, error } = useCallAnalysisProfiles({ enabled: account && analyticsEnabled });
  return (
    <div className={stepStyles.rows}>
      <RecordingRows
        recording={{
          state: form.recording,
          onChange: (recording) => onChange({ ...form, recording }),
          recordingEnabled: !account || recordingEnabled,
          analyticsEnabled,
          profiles,
          profilesLoading: loading,
          profilesError: error,
          savedProfileId,
        }}
        errors={errors}
        callSummary={account}
        profilesErrorConsequence="Saving without changing this leaves the template’s current profile alone."
      />
    </div>
  );
}
