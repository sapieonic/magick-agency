import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import type {
  AgencyCreateReportSubscriptionRequest,
  AgencyReportSubscription,
  AgencyUpdateReportSubscriptionRequest,
  ReportCadence,
  ReportFormat,
  ReportKind,
} from '@magick-agency/contracts/api/agency/reports';
import {
  REPORT_CADENCES,
  REPORT_FORMATS,
  REPORT_KINDS,
  REPORT_SUBSCRIPTION_MAX_RECIPIENTS,
} from '@magick-agency/contracts/api/agency/reports';
import type { TenantMember } from '../../../types/team';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { useTenant } from '../../../contexts/TenantContext';
import { createReportSubscription, reportErrorMessage, updateReportSubscription } from '../../../api/reports';
import { hasPermission } from '../../../utils/permissions';
import { browserZone, reportZoneOptions } from '../../../utils/reports/reportWindow';
import {
  CADENCE_PERIOD_NOTES,
  ISO_WEEKDAY_NAMES,
  REPORT_CADENCE_LABELS,
  REPORT_FORMAT_LABELS,
  REPORT_KIND_LABELS,
  cadenceDescription,
  ordinal,
  subjectLabel,
} from '../../../utils/reports/reportCopy';
import styles from './Reports.module.css';

/** A member as a picker option: their id and the name to show. */
export interface MemberOption {
  userId: string;
  name: string;
}

function memberName(m: TenantMember): string {
  return m.user.display_name || m.user.email || 'Unnamed member';
}

/** An active membership that reaches this account (tenant-wide, or this account's own). */
function onAccount(m: TenantMember, accountId: string | null): boolean {
  return (
    m.membership.status === 'active' &&
    m.membership.invite_state !== 'pending' &&
    (m.membership.account_id === null || m.membership.account_id === accountId)
  );
}

/** The agents a review can be about: members on this account who can open a station. */
export function agentOptions(members: readonly TenantMember[], accountId: string | null): MemberOption[] {
  return members
    .filter((m) => onAccount(m, accountId) && hasPermission(m.membership.role, 'agency.station.connect'))
    .map((m) => ({ userId: m.user.id, name: memberName(m) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Who may receive a scheduled report (RP4): members on this account with `agency.supervise`. */
export function recipientOptions(members: readonly TenantMember[], accountId: string | null): MemberOption[] {
  return members
    .filter((m) => onAccount(m, accountId) && hasPermission(m.membership.role, 'agency.supervise'))
    .map((m) => ({ userId: m.user.id, name: memberName(m) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The same members, in any order. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/**
 * The edit's PATCH: only the fields whose value differs from the subscription being
 * edited, so a change of recipients or formats is not sent as a change of schedule.
 * The day fields follow the cadence (a field the old cadence set and the new one does
 * not becomes null), so a cadence change carries both. Formats and recipients compare
 * as sets.
 */
export function subscriptionPatch(
  editing: AgencyReportSubscription,
  form: AgencyUpdateReportSubscriptionRequest,
): AgencyUpdateReportSubscriptionRequest {
  const patch: AgencyUpdateReportSubscriptionRequest = {};
  if (form.cadence !== undefined && form.cadence !== editing.cadence) patch.cadence = form.cadence;
  if (form.send_local_time !== undefined && form.send_local_time !== editing.send_local_time) {
    patch.send_local_time = form.send_local_time;
  }
  if (form.send_weekday !== undefined && form.send_weekday !== editing.send_weekday) patch.send_weekday = form.send_weekday;
  if (form.send_monthday !== undefined && form.send_monthday !== editing.send_monthday) patch.send_monthday = form.send_monthday;
  if (form.timezone !== undefined && form.timezone !== editing.timezone) patch.timezone = form.timezone;
  if (form.formats !== undefined && !sameSet(form.formats, editing.formats)) patch.formats = form.formats;
  if (
    form.recipient_user_ids !== undefined &&
    !sameSet(
      form.recipient_user_ids,
      editing.recipients.map((r) => r.user_id),
    )
  ) {
    patch.recipient_user_ids = form.recipient_user_ids;
  }
  if (form.enabled !== undefined && form.enabled !== editing.enabled) patch.enabled = form.enabled;
  return patch;
}

export interface SubscriptionFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Absent to create one; the subscription to edit (its kind and subject stay fixed). */
  editing?: AgencyReportSubscription | null;
  members: readonly TenantMember[] | null;
  campaigns: readonly AgencyCampaign[] | null;
  onSaved: (subscription: AgencyReportSubscription, action: 'created' | 'updated') => void;
}

/**
 * Create or edit a scheduled report (supervisors only, RP5): what it is about, how
 * often and when it is sent (a day of the week for weekly, a day of the month 1–28
 * for monthly), the zone, the formats and who receives it (supervisors on this
 * account, at most {@link REPORT_SUBSCRIPTION_MAX_RECIPIENTS}).
 */
export function SubscriptionFormDialog(props: SubscriptionFormDialogProps) {
  if (!props.open) return null;
  return <OpenSubscriptionForm {...props} />;
}

function OpenSubscriptionForm({ onClose, editing, members, campaigns, onSaved }: SubscriptionFormDialogProps) {
  const { tenantId, accountId, accounts, membership } = useTenant();
  const ids = useId();
  const formId = `${ids}-form`;
  const isEdit = Boolean(editing);
  const accountName = accounts.find((a) => a.id === accountId)?.name ?? 'This account';

  const [kind, setKind] = useState<ReportKind>(editing?.kind ?? 'agent');
  const [subjectId, setSubjectId] = useState<string>(editing?.subject.id ?? '');
  const [cadence, setCadence] = useState<ReportCadence>(editing?.cadence ?? 'weekly');
  const [time, setTime] = useState(editing?.send_local_time ?? '08:30');
  const [weekday, setWeekday] = useState<number>(editing?.send_weekday ?? 1);
  const [monthday, setMonthday] = useState<number>(editing?.send_monthday ?? 1);
  const [zone, setZone] = useState(editing && editing.kind !== 'campaign' ? editing.timezone : browserZone());
  const [formats, setFormats] = useState<Record<ReportFormat, boolean>>({
    pdf: editing ? editing.formats.includes('pdf') : true,
    xlsx: editing ? editing.formats.includes('xlsx') : true,
  });
  const [recipients, setRecipients] = useState<string[]>(() =>
    editing ? editing.recipients.map((r) => r.user_id) : membership?.user_id ? [membership.user_id] : [],
  );
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agents = useMemo(() => agentOptions(members ?? [], accountId), [members, accountId]);
  const supervisors = useMemo(() => recipientOptions(members ?? [], accountId), [members, accountId]);
  const zoneOptions = useMemo(() => reportZoneOptions(zone), [zone]);

  // The account report is about the context account; there is nothing to pick.
  useEffect(() => {
    if (isEdit) return;
    if (kind === 'account') setSubjectId(accountId ?? '');
    else setSubjectId('');
  }, [kind, isEdit, accountId]);

  const campaign = kind === 'campaign' ? campaigns?.find((c) => c.id === subjectId) ?? null : null;
  const campaignZone = isEdit && editing?.kind === 'campaign' ? editing.timezone : campaign?.default_timezone ?? null;
  const chosenFormats = REPORT_FORMATS.filter((f) => formats[f]);
  const atCap = recipients.length >= REPORT_SUBSCRIPTION_MAX_RECIPIENTS;
  // An existing recipient who is no longer a supervisor here is still shown, so it can be removed.
  const recipientRows: MemberOption[] = [
    ...supervisors,
    ...(editing?.recipients ?? [])
      .filter((r) => !supervisors.some((s) => s.userId === r.user_id))
      .map((r) => ({ userId: r.user_id, name: r.name ?? 'A former team member' })),
  ];

  const problems = {
    subject: !subjectId ? (kind === 'agent' ? 'Choose an agent.' : 'Choose a campaign.') : null,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? null : 'Enter a time as HH:MM.',
    formats: chosenFormats.length === 0 ? 'Choose at least one format.' : null,
    recipients:
      recipients.length === 0
        ? 'Choose at least one recipient.'
        : recipients.length > REPORT_SUBSCRIPTION_MAX_RECIPIENTS
          ? `Choose at most ${REPORT_SUBSCRIPTION_MAX_RECIPIENTS} recipients.`
          : null,
  };
  const invalid = Object.values(problems).some((p) => p !== null);

  const toggleRecipient = (userId: string, on: boolean) =>
    setRecipients((prev) => (on ? (prev.includes(userId) ? prev : [...prev, userId]) : prev.filter((id) => id !== userId)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setError(null);
    if (invalid || !tenantId || !accountId) return;
    const schedule = {
      cadence,
      send_local_time: time,
      send_weekday: cadence === 'weekly' ? weekday : null,
      send_monthday: cadence === 'monthly' ? monthday : null,
      ...(kind === 'campaign' ? {} : { timezone: zone }),
      formats: chosenFormats,
      recipient_user_ids: recipients,
    };
    const patch = editing ? subscriptionPatch(editing, schedule) : null;
    // An edit that changed nothing has nothing to send.
    if (patch && Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      if (editing && patch) {
        onSaved(await updateReportSubscription(editing.id, patch, tenantId, accountId), 'updated');
      } else {
        const request: AgencyCreateReportSubscriptionRequest = { kind, subject_id: subjectId, ...schedule };
        onSaved(await createReportSubscription(request, tenantId, accountId), 'created');
      }
    } catch (err) {
      setError(reportErrorMessage(err, 'We couldn’t save this scheduled report. Try again.'));
      setSaving(false);
    }
  };

  const loading = members === null || (kind === 'campaign' && campaigns === null && !isEdit);
  const err = (key: keyof typeof problems) =>
    attempted && problems[key] ? (
      <p id={`${ids}-${key}-error`} className={styles.inlineError} role="alert" data-testid={`subscription-${key}-error`}>
        {problems[key]}
      </p>
    ) : null;
  const describedBy = (key: keyof typeof problems) => (attempted && problems[key] ? `${ids}-${key}-error` : undefined);

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Edit scheduled report' : 'New scheduled report'}
      size="lg"
      closeOnOverlayClick={!saving}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn-primary" disabled={saving} data-testid="subscription-save">
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create schedule'}
          </button>
        </>
      }
    >
      <form id={formId} className={styles.dialogForm} onSubmit={(e) => void submit(e)} noValidate>
        {isEdit && editing ? (
          <p className={styles.hint} data-testid="subscription-fixed-subject">
            {`${REPORT_KIND_LABELS[editing.kind]}: ${subjectLabel(editing.kind, editing.subject)}`}
          </p>
        ) : (
          <div className={styles.formGrid}>
            <div className="form-group">
              <label htmlFor={`${ids}-kind`}>Report</label>
              <select id={`${ids}-kind`} value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
                {REPORT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {REPORT_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              {kind === 'account' ? (
                <>
                  <span className={styles.legend}>Account</span>
                  <p className={styles.hint} data-testid="subscription-account">
                    {accountName}
                  </p>
                </>
              ) : (
                <>
                  <label htmlFor={`${ids}-subject`}>{kind === 'agent' ? 'Agent' : 'Campaign'}</label>
                  {loading ? (
                    <LoadingSpinner size="sm" />
                  ) : (
                    <select
                      id={`${ids}-subject`}
                      value={subjectId}
                      onChange={(e) => setSubjectId(e.target.value)}
                      aria-invalid={describedBy('subject') ? 'true' : undefined}
                      aria-describedby={describedBy('subject')}
                    >
                      <option value="">{kind === 'agent' ? 'Choose an agent' : 'Choose a campaign'}</option>
                      {kind === 'agent'
                        ? agents.map((a) => (
                            <option key={a.userId} value={a.userId}>
                              {a.name}
                            </option>
                          ))
                        : (campaigns ?? []).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                    </select>
                  )}
                  {err('subject')}
                </>
              )}
            </div>
          </div>
        )}

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>How often</legend>
          <div className={styles.presets}>
            {REPORT_CADENCES.map((c) => (
              <label key={c} className={styles.presetOption}>
                <input
                  type="radio"
                  name={`${ids}-cadence`}
                  value={c}
                  checked={cadence === c}
                  onChange={() => setCadence(c)}
                />
                {REPORT_CADENCE_LABELS[c]}
              </label>
            ))}
          </div>
          <p className={styles.hint}>{CADENCE_PERIOD_NOTES[cadence]}</p>
        </fieldset>

        <div className={styles.formGrid}>
          {cadence === 'weekly' ? (
            <div className="form-group">
              <label htmlFor={`${ids}-weekday`}>Day of the week</label>
              <select id={`${ids}-weekday`} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {ISO_WEEKDAY_NAMES.map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {cadence === 'monthly' ? (
            <div className="form-group">
              <label htmlFor={`${ids}-monthday`}>Day of the month</label>
              <select id={`${ids}-monthday`} value={monthday} onChange={(e) => setMonthday(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {ordinal(d)}
                  </option>
                ))}
              </select>
              <p className="field-hint">Up to the 28th, so it is sent every month.</p>
            </div>
          ) : null}
          <div className="form-group">
            <label htmlFor={`${ids}-time`}>Time</label>
            <input
              id={`${ids}-time`}
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value.slice(0, 5))}
              aria-invalid={describedBy('time') ? 'true' : undefined}
              aria-describedby={describedBy('time')}
            />
            {err('time')}
          </div>
          {kind === 'campaign' ? (
            <div className="form-group">
              <span className={styles.legend}>Time zone</span>
              <p className={styles.hint} data-testid="subscription-campaign-zone">
                {campaignZone ? `${campaignZone}, the campaign’s time zone` : 'The campaign’s time zone'}
              </p>
            </div>
          ) : (
            <div className="form-group">
              <label htmlFor={`${ids}-zone`}>Time zone</label>
              <select id={`${ids}-zone`} value={zone} onChange={(e) => setZone(e.target.value)}>
                {zoneOptions.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <p className={styles.hint} data-testid="subscription-cadence-preview">
          {cadenceDescription({
            cadence,
            send_local_time: time,
            send_weekday: cadence === 'weekly' ? weekday : null,
            send_monthday: cadence === 'monthly' ? monthday : null,
            timezone: kind === 'campaign' ? campaignZone ?? 'the campaign’s time zone' : zone,
          })}
        </p>

        <fieldset className={styles.fieldset} aria-describedby={describedBy('formats')}>
          <legend className={styles.legend}>Formats</legend>
          <div className={styles.checkRow}>
            {REPORT_FORMATS.map((f) => (
              <label key={f} className={styles.checkOption}>
                <input
                  type="checkbox"
                  checked={formats[f]}
                  onChange={(e) => setFormats((prev) => ({ ...prev, [f]: e.target.checked }))}
                />
                {REPORT_FORMAT_LABELS[f]}
              </label>
            ))}
          </div>
          {err('formats')}
        </fieldset>

        <fieldset className={styles.fieldset} aria-describedby={describedBy('recipients')}>
          <legend className={styles.legend}>
            {`Recipients (${recipients.length} of at most ${REPORT_SUBSCRIPTION_MAX_RECIPIENTS})`}
          </legend>
          <p className="field-hint">Supervisors on this account. Each gets an email with a link to the report.</p>
          {members === null ? (
            <LoadingSpinner size="sm" />
          ) : recipientRows.length === 0 ? (
            <p className={styles.muted}>No supervisors on this account to send it to.</p>
          ) : (
            <div className={styles.recipients}>
              {recipientRows.map((m) => {
                const checked = recipients.includes(m.userId);
                return (
                  <label key={m.userId} className={styles.checkOption}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && atCap}
                      onChange={(e) => toggleRecipient(m.userId, e.target.checked)}
                      data-testid={`subscription-recipient-${m.userId}`}
                    />
                    {m.name}
                  </label>
                );
              })}
            </div>
          )}
          {atCap ? (
            <p className={styles.hint} data-testid="subscription-recipient-cap">
              {`That’s the most recipients one scheduled report can have (${REPORT_SUBSCRIPTION_MAX_RECIPIENTS}).`}
            </p>
          ) : null}
          {err('recipients')}
        </fieldset>

        {error ? (
          <p className={styles.inlineError} role="alert" data-testid="subscription-submit-error">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export default SubscriptionFormDialog;
