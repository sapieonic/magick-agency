import { useMemo } from 'react';
import type {
  AgencyCampaignTemplateScope,
  AgencyCampaignTemplateSectionKey,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import type { AgencyCarrier } from '@magick-agency/contracts/api/agency/agency-campaign';
import { CampaignBehaviourSection, type BehaviourSectionId } from '../../../pages/campaigns/agency/CampaignBehaviourSection';
import { BreakLimitsEditor } from '../../../pages/campaigns/agency/BreakLimitsEditor';
import { AgentScreenFields } from '../../../pages/campaigns/agency/AgentScreenFields';
import { ScriptEditor } from '../../../pages/campaigns/agency/ScriptEditor';
import { useConfigFieldErrors } from '../../../pages/campaigns/agency/configFieldErrors';
import { CallerIdPicker } from '../../../pages/agency/CallerIdPicker';
import { CampaignCarrierField } from '../CampaignCarrierField';
import { CampaignRecordingField } from '../CampaignRecordingField';
import { CallSummaryProfileField } from '../CallSummaryProfileField';
import { carrierActive, carrierOptions, sameCarrier } from '../../../utils/agencyCarriers';
import { dailyTargetError } from '../../../utils/agency/stationSettings';
import {
  TEMPLATE_FACTS,
  templateScriptErrors,
  templateScriptKeys,
  type TemplateForm,
} from '../../../utils/agency/campaignTemplates/templateForm';
import styles from './CampaignTemplates.module.css';

/** The editor each config section is, cut from campaign Settings' editors (`CampaignBehaviourSection`). */
const BEHAVIOUR_EDITOR: Partial<Record<AgencyCampaignTemplateSectionKey, BehaviourSectionId>> = {
  outcomes: 'outcomeList',
  retries: 'retryRules',
  hours: 'hours',
  wrapup: 'wrapup',
  safety: 'ceiling',
  assignment: 'assignment',
  inbound: 'sticky',
};

export interface TemplateSectionEditorsProps {
  section: AgencyCampaignTemplateSectionKey;
  form: TemplateForm;
  onChange: (next: TemplateForm) => void;
  scope: AgencyCampaignTemplateScope;
  /** The server's refusal of the last save, by campaign field path (CT4). */
  fieldErrors: Record<string, string>;
  /** The account may record (`agency.recording`); an organisation template may set it either way. */
  recordingEnabled: boolean;
  /** The account has call summaries (`agency.analytics`). */
  analyticsEnabled: boolean;
  carriers: readonly AgencyCarrier[] | null;
  /** Remount key for the outcome editors after their list is replaced (Copy from a campaign). */
  epoch?: number;
}

/**
 * One template section's editors: the ones campaign Settings and New campaign use, fed from the
 * template's form (`utils/agency/campaignTemplates/templateForm.ts`).
 */
export function TemplateSectionEditors({
  section,
  form,
  onChange,
  scope,
  fieldErrors,
  recordingEnabled,
  analyticsEnabled,
  carriers,
  epoch = 0,
}: TemplateSectionEditorsProps) {
  const behaviour = BEHAVIOUR_EDITOR[section];
  const stationErrors = useMemo(() => {
    const live: Record<string, string> = { ...templateScriptErrors(form.station.script) };
    const target = dailyTargetError(form.station.dailyTarget);
    if (target) live['daily_target_calls'] = target;
    return { ...live, ...fieldErrors };
  }, [form.station, fieldErrors]);
  const errors = useConfigFieldErrors(stationErrors);
  const scriptKeys = useMemo(() => templateScriptKeys(), []);
  const choices = useMemo(() => carrierOptions(carriers ?? [], form.carrier), [carriers, form.carrier]);

  if (behaviour) {
    return (
      <CampaignBehaviourSection
        key={section === 'outcomes' ? epoch : undefined}
        state={form.config}
        onChange={(config) => onChange({ ...form, config })}
        fieldErrors={fieldErrors}
        layout="plain"
        include={[behaviour]}
        assignment={section === 'assignment' ? { modeLocked: false } : undefined}
        inbound={section === 'inbound'}
      />
    );
  }

  switch (section) {
    case 'breaks':
      return (
        <BreakLimitsEditor
          value={form.breakReasons}
          onChange={(breakReasons) => onChange({ ...form, breakReasons })}
          serverError={fieldErrors['break_reasons'] ?? null}
          icons
          fieldErrors={fieldErrors}
        />
      );
    case 'recording':
      return (
        <div className={styles.cardBody}>
          <CampaignRecordingField
            checked={form.recording.record}
            onChange={(record) => onChange({ ...form, recording: { ...form.recording, record } })}
            capabilityEnabled={scope === 'organisation' || recordingEnabled}
            error={fieldErrors['record_calls']}
          />
          {/* An organisation template holds no account's profile (CT5). */}
          {scope === 'account' ? (
            <CallSummaryProfileField
              id={`template-analysis-profile`}
              subject="template"
              profileId={form.recording.profileId}
              onChange={(profileId) => onChange({ ...form, recording: { ...form.recording, profileId } })}
              analyticsEnabled={analyticsEnabled}
              error={fieldErrors['analysis_profile_id']}
            />
          ) : null}
        </div>
      );
    case 'agent_screen':
      return (
        <div className={styles.cardBody}>
          <AgentScreenFields
            dailyTarget={form.station.dailyTarget}
            phoneDisplay={form.station.phoneDisplay}
            onChange={(patch) => onChange({ ...form, station: { ...form.station, ...patch } })}
            errors={errors}
          />
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
        </div>
      );
    case 'numbers':
      return (
        <div className={styles.cardBody}>
          {choices.length > 1 ? (
            <CampaignCarrierField
              options={choices}
              value={form.carrier}
              onChange={(carrier) => onChange({ ...form, carrier })}
              error={fieldErrors['telephony_credential_id'] ?? fieldErrors['telephony_provider']}
            />
          ) : null}
          {/* The picker is a list of checkboxes, each with its own label: the group is named, not a field. */}
          <fieldset className={styles.checks}>
            {/* The card's heading says it; the group still has its name (U8). */}
            <legend className={styles.srOnly}>Numbers to call from</legend>
            <CallerIdPicker
              selected={form.callerIds}
              onChange={(callerIds) => onChange({ ...form, callerIds })}
              carrier={form.carrier}
              carrierLabel={carriers?.find((c) => sameCarrier(c, form.carrier))?.label ?? null}
              carrierActive={carrierActive(carriers, form.carrier)}
            />
            {fieldErrors['caller_ids'] ? (
              <p className={styles.fieldError} data-field-error>
                {fieldErrors['caller_ids']}
              </p>
            ) : null}
          </fieldset>
        </div>
      );
    default:
      return null;
  }
}
