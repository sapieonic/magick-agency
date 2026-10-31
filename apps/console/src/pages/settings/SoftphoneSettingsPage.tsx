import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { PageDescription } from '../../components/common/PageDescription';
import { useTenant } from '../../contexts/TenantContext';
import { getSoftphoneSettings, putSoftphoneSettings } from '../../api/softphone';
import { useCallAnalysisProfiles } from '../../hooks/useCallAnalysisProfiles';
import { usePhoneNumbers } from '../../hooks/usePhoneNumbers';
import { usePermission } from '../../hooks/usePermission';
import { DispositionCatalogEditor } from '../campaigns/agency/DispositionCatalogEditor';
import { useConfigFieldErrors } from '../campaigns/agency/configFieldErrors';
import { DEFAULT_DISPOSITIONS } from '../../utils/agencyCampaignConfigForm';
import {
  CALL_FIELD_TYPE_LABELS,
  editFieldRows,
  removedSavedKeys,
  type FieldRowEdit,
} from '../../utils/softphone/fieldSettings';
import {
  draftFromSettings,
  payloadFromDraft,
  settingsChanged,
  settingsErrorsFromDetails,
  validateSettingsDraft,
  type SoftphoneSettingsDraft,
} from '../../utils/softphone/settingsForm';
import { formatDialNumber } from '../../utils/softphone/phoneInput';
import { refusalCopy } from '../../utils/softphone/refusalCopy';
import {
  AGENCY_CALL_FIELD_TYPES,
  SOFTPHONE_CALL_FIELDS_MAX,
  type AgencyCallFieldType,
  type AgencySoftphoneSettings,
} from '../../types/softphone';
import styles from './SoftphoneSettingsPage.module.css';

/**
 * Settings → Soft phone (`docs/softphone.md` §3, §7): what a soft-phone call uses
 * when it is NOT logged to a campaign (its outcomes, recording, summary profile,
 * caller ID), and the call details every soft-phone call asks for.
 *
 * Editing is `agency.softphone.manage` (account admin); anyone who reaches the
 * page without it reads the same settings with every control disabled, because
 * a supervisor explaining an agent's screen should be able to see what drives it.
 */
export default function SoftphoneSettingsPage() {
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();
  const canEdit = usePermission('agency.softphone.manage');
  const mayReadProfiles = usePermission('agency.analysis_profiles.read');
  const { profiles } = useCallAnalysisProfiles({ enabled: mayReadProfiles });
  const { phoneNumbers } = usePhoneNumbers();

  const [saved, setSaved] = useState<AgencySoftphoneSettings | null>(null);
  const [draft, setDraft] = useState<SoftphoneSettingsDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !accountId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const settings = await getSoftphoneSettings(tenantId, accountId);
      setSaved(settings);
      setDraft(draftFromSettings(settings));
      setTouched(false);
    } catch (err) {
      setLoadError(getErrorMessage(err, 'We couldn’t load the soft-phone settings.'));
    } finally {
      setLoading(false);
    }
  }, [tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const clientErrors = useMemo(() => (draft ? validateSettingsDraft(draft) : {}), [draft]);
  const fieldErrors = { ...serverErrors, ...(touched ? clientErrors : {}) };
  const errors = useConfigFieldErrors(fieldErrors);
  const changed = saved && draft ? settingsChanged(saved, draft) : false;
  const invalid = Object.keys(clientErrors).length > 0;

  const update = (patch: Partial<SoftphoneSettingsDraft>) => {
    setTouched(true);
    setServerErrors({});
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  const editRows = (edit: FieldRowEdit) => {
    if (!draft) return;
    update({ fieldRows: editFieldRows(draft.fieldRows, edit) });
  };

  const save = async () => {
    if (!draft || !canEdit) return;
    setTouched(true);
    if (invalid) {
      setSaveError('Fix the highlighted fields before saving.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await putSoftphoneSettings(payloadFromDraft(draft), tenantId ?? undefined, accountId ?? undefined);
    setSaving(false);
    if (result.ok) {
      setSaved(result.value);
      setDraft(draftFromSettings(result.value));
      setTouched(false);
      setServerErrors({});
      showToast('Soft-phone settings saved.', 'success');
      return;
    }
    const refusal = result.refusal;
    if (refusal.code === 'settings_invalid') setServerErrors(settingsErrorsFromDetails(refusal.details));
    setSaveError(refusalCopy(refusal));
  };

  if (loading) return <LoadingSpinner />;
  if (loadError || !draft || !saved) {
    return (
      <div className={styles.page}>
        <PageHeader title="Soft phone" />
        <ErrorAlert message={loadError ?? 'We couldn’t load the soft-phone settings.'} onRetry={() => void load()} />
      </div>
    );
  }

  const removed = removedSavedKeys(saved.call_fields, draft.fieldRows);
  const usingBuiltIn = draft.catalog.length === 0;
  const callerOptions = phoneNumbers.map((n) => n.phone_number);
  if (draft.defaultCallerId && !callerOptions.includes(draft.defaultCallerId)) callerOptions.unshift(draft.defaultCallerId);
  const profileKnown = draft.profileId === null || profiles.some((p) => p.id === draft.profileId);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Soft phone"
        actions={
          canEdit ? (
            <div className={styles.headerActions}>
              {changed ? <span className={styles.unsaved}>Unsaved changes</span> : null}
              <button
                type="button"
                className={`btn-primary ${styles.saveButton}`}
                onClick={() => void save()}
                disabled={saving || !changed}
                data-testid="softphone-settings-save"
              >
                <Save size={15} aria-hidden="true" />
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          ) : undefined
        }
      />
      <PageDescription
        pageKey="softphone-settings"
        description={
          'What the soft phone uses when an agent does not log a call to a campaign, and the call details '
          + 'every soft-phone call asks for. A call logged to a campaign uses that campaign’s outcomes, '
          + 'caller IDs, recording and summary profile.'
        }
      />

      {!canEdit ? (
        <p className={styles.readOnly} data-testid="softphone-settings-readonly">
          You can see these settings. Changing them needs an account admin.
        </p>
      ) : null}
      {saveError ? <ErrorAlert message={saveError} /> : null}

      <div className={styles.grid}>
        <div className={styles.stack}>
          <section className="card" aria-labelledby="sp-defaults">
            <h2 className={styles.cardTitle} id="sp-defaults">
              Access and defaults
            </h2>
            <p className={styles.cardLead}>For calls that are not logged to a campaign.</p>
            <div className={styles.row}>
              <div className={styles.rowText}>
                <p className={styles.rowLabel}>The soft phone is on for this account</p>
                <span className={styles.rowHint} id="sp-access-hint">
                  Every agent in the account sees “Soft phone”. Your platform administrator turns it on and off for the
                  account; it isn’t a setting on this page.
                </span>
              </div>
              <span className={styles.onPill} aria-describedby="sp-access-hint" data-testid="softphone-settings-access">
                On
              </span>
            </div>
            <div className={styles.row}>
              <div className={styles.rowText}>
                <p className={styles.rowLabel} id="sp-record-label">
                  Record calls that are not logged to a campaign
                </p>
                <span className={styles.rowHint}>
                  Only recorded calls are summarised. Logged calls follow their campaign’s setting, and the account’s
                  own recording permission still applies.
                </span>
              </div>
              <label className={styles.switch}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-labelledby="sp-record-label"
                  checked={draft.record}
                  disabled={!canEdit}
                  onChange={(e) => update({ record: e.target.checked })}
                  data-testid="softphone-settings-record"
                />
                {draft.record ? 'On' : 'Off'}
              </label>
            </div>
            <div className={styles.row}>
              <div className={styles.rowText}>
                <label className={styles.rowLabel} htmlFor="sp-profile">
                  Summary profile
                </label>
                <span className={styles.rowHint}>Used when no campaign is picked.</span>
              </div>
              <select
                id="sp-profile"
                className={styles.rowControl}
                value={draft.profileId ?? ''}
                disabled={!canEdit}
                onChange={(e) => update({ profileId: e.target.value || null })}
                aria-describedby={errors.describedBy('analysis_profile_id')}
                data-testid="softphone-settings-profile"
              >
                <option value="">The account’s default</option>
                {profileKnown ? null : <option value={draft.profileId!}>Current profile</option>}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            {errors.render('analysis_profile_id')}
            <div className={styles.row}>
              <div className={styles.rowText}>
                <label className={styles.rowLabel} htmlFor="sp-caller">
                  Default caller ID
                </label>
                <span className={styles.rowHint}>From the numbers assigned to this account.</span>
              </div>
              <select
                id="sp-caller"
                className={styles.rowControl}
                value={draft.defaultCallerId ?? ''}
                disabled={!canEdit}
                onChange={(e) => update({ defaultCallerId: e.target.value || null })}
                aria-describedby={errors.describedBy('default_caller_id')}
                data-testid="softphone-settings-caller"
              >
                <option value="">The first assigned number</option>
                {callerOptions.map((n) => (
                  <option key={n} value={n}>
                    {formatDialNumber(n)}
                  </option>
                ))}
              </select>
            </div>
            {errors.render('default_caller_id')}
          </section>

          <section className="card" aria-labelledby="sp-outcomes" data-testid="softphone-settings-outcomes">
            <h2 className={styles.cardTitle} id="sp-outcomes">
              Outcomes when not logged to a campaign
            </h2>
            {usingBuiltIn ? (
              <>
                <p className={styles.cardLead}>The built-in outcomes are in use. Agents press 1–9 to pick one.</p>
                <ol className={styles.builtIn}>
                  {DEFAULT_DISPOSITIONS.map((entry, index) => (
                    <li key={entry.code} className={styles.builtInItem}>
                      <span className={styles.kbd} aria-hidden="true">
                        {index + 1}
                      </span>
                      {entry.label}
                    </li>
                  ))}
                </ol>
                {canEdit ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => update({ catalog: DEFAULT_DISPOSITIONS.map((d) => ({ ...d })) })}
                    data-testid="softphone-settings-customise"
                  >
                    Customise the outcomes
                  </button>
                ) : null}
              </>
            ) : (
              <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
                <DispositionCatalogEditor
                  dispositions={draft.catalog}
                  onChange={(next) => update({ catalog: next })}
                  errors={errors}
                />
                {canEdit ? (
                  <button type="button" className="btn-secondary" onClick={() => update({ catalog: [] })}>
                    Use the built-in outcomes instead
                  </button>
                ) : null}
              </fieldset>
            )}
          </section>
        </div>

        <section className="card" aria-labelledby="sp-fields" data-testid="softphone-settings-fields">
          <h2 className={styles.cardTitle} id="sp-fields">
            Call details fields
          </h2>
          <p className={styles.cardLead}>
            Shown to agents on every soft-phone call, saved with the call and shown beside its summary.
          </p>
          {removed.length > 0 ? (
            <p className={styles.warning} data-testid="softphone-settings-removed">
              Removing {removed.map((k) => `‘${k}’`).join(', ')} stops agents filling {removed.length === 1 ? 'it' : 'them'} in. Values
              already saved on past calls stay on those calls.
            </p>
          ) : null}
          {errors.render('call_fields')}
          <ul className={styles.fieldRows}>
            {draft.fieldRows.map((row, index) => {
              const at = `call_fields[${index}]`;
              const name = row.label.trim() || `Field ${index + 1}`;
              return (
                <li key={index} className={styles.fieldRow} data-testid={`field-row-${index}`}>
                  <div className={styles.fieldRowTop}>
                    <div className={styles.small}>
                      <label htmlFor={`${at}-label`}>Label</label>
                      <input
                        id={`${at}-label`}
                        value={row.label}
                        disabled={!canEdit}
                        placeholder="What the agent sees"
                        onChange={(e) => editRows({ type: 'label', index, label: e.target.value })}
                        aria-describedby={errors.describedBy(`${at}.label`)}
                      />
                      {errors.render(`${at}.label`)}
                    </div>
                    <div className={styles.small}>
                      <label htmlFor={`${at}-key`}>Key</label>
                      {row.saved ? (
                        <span
                          className={styles.keyLocked}
                          id={`${at}-key`}
                          title="A saved field’s key can’t change: past calls store their values under it."
                          data-testid={`field-key-locked-${index}`}
                        >
                          <Lock size={11} aria-hidden="true" />
                          {row.key}
                        </span>
                      ) : (
                        <input
                          id={`${at}-key`}
                          value={row.key}
                          disabled={!canEdit}
                          placeholder="snake_case"
                          onChange={(e) => editRows({ type: 'key', index, key: e.target.value })}
                          aria-describedby={errors.describedBy(`${at}.key`)}
                          data-testid={`field-key-${index}`}
                        />
                      )}
                      {errors.render(`${at}.key`)}
                    </div>
                    <div className={styles.small}>
                      <label htmlFor={`${at}-type`}>Type</label>
                      <select
                        id={`${at}-type`}
                        value={row.type}
                        disabled={!canEdit}
                        onChange={(e) =>
                          editRows({ type: 'patch', index, patch: { type: e.target.value as AgencyCallFieldType } })
                        }
                      >
                        {AGENCY_CALL_FIELD_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {CALL_FIELD_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => editRows({ type: 'move', index, delta: -1 })}
                        disabled={!canEdit || index === 0}
                        aria-label={`Move ${name} up`}
                      >
                        <ArrowUp size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => editRows({ type: 'move', index, delta: 1 })}
                        disabled={!canEdit || index === draft.fieldRows.length - 1}
                        aria-label={`Move ${name} down`}
                      >
                        <ArrowDown size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => editRows({ type: 'remove', index })}
                        disabled={!canEdit}
                        aria-label={`Remove ${name}`}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div className={styles.fieldRowBottom}>
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        checked={row.required}
                        disabled={!canEdit}
                        onChange={(e) => editRows({ type: 'patch', index, patch: { required: e.target.checked } })}
                      />
                      Required before the outcome can be saved
                    </label>
                    {row.type === 'choice' ? (
                      <div className={styles.small} style={{ flex: '1 1 220px' }}>
                        <label htmlFor={`${at}-options`}>Options, one per line</label>
                        <textarea
                          id={`${at}-options`}
                          className={styles.options}
                          value={row.optionsText}
                          disabled={!canEdit}
                          onChange={(e) => editRows({ type: 'patch', index, patch: { optionsText: e.target.value } })}
                          aria-describedby={errors.describedBy(`${at}.options`)}
                        />
                        {errors.render(`${at}.options`)}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {canEdit ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => editRows({ type: 'add' })}
              disabled={draft.fieldRows.length >= SOFTPHONE_CALL_FIELDS_MAX}
              data-testid="softphone-settings-add-field"
            >
              <Plus size={14} aria-hidden="true" /> Add field
            </button>
          ) : null}
          <p className={styles.note}>
            Up to {SOFTPHONE_CALL_FIELDS_MAX} fields. A field’s key can’t change once it is saved, so the values saved
            on past calls keep their meaning. Every call uses this set, whether or not it is logged to a campaign.
          </p>
        </section>
      </div>
    </div>
  );
}
