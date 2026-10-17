import { useState, useEffect, useRef } from 'react';
import { PhoneOff, Settings } from 'lucide-react';
import { getAccountSettings, updateAccountSettings } from '../../../api/super-admin';
import type { AgencyAccountSettings, UpdateAgencyAccountSettingsBody } from '@magick-agency/contracts/api/platform/settings';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { parseStrictInteger } from '../../../utils/strictInteger';
import styles from '../SATenantDetailPage.module.css';

/** Plan / contract `AgencyAccountSettings.webrtc_max_duration_seconds`. */
const WEBRTC_MAX_DURATION_MIN = 60;
const WEBRTC_MAX_DURATION_MAX = 14_400;

/**
 * NEW: the per-account settings row that replaces governance.
 * One account at a time; a PATCH carries only the fields that changed.
 */
export function AccountSettingsPanel({ tenantId, accounts }: {
  tenantId: string;
  accounts: Array<{ id: string; name: string }>;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [settings, setSettings] = useState<AgencyAccountSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allowRecording, setAllowRecording] = useState(false);
  const [analyzeCalls, setAnalyzeCalls] = useState(false);
  const [duration, setDuration] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const apply = (s: AgencyAccountSettings) => {
    setSettings(s);
    setAllowRecording(s.allow_recording);
    setAnalyzeCalls(s.analyze_calls);
    setDuration(String(s.webrtc_max_duration_seconds));
  };

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  useEffect(() => {
    if (!accountId) return;
    const seq = ++requestSequence.current;
    setLoading(true);
    setLoadError(null);
    setSettings(null);
    setSaveError(null);
    setSaved(null);
    setReason('');
    getAccountSettings(tenantId, accountId)
      .then(res => { if (seq === requestSequence.current) apply(res.settings); })
      .catch(err => {
        if (seq === requestSequence.current) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load account settings');
        }
      })
      .finally(() => { if (seq === requestSequence.current) setLoading(false); });
  }, [tenantId, accountId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaveError(null);
    setSaved(null);
    const body: UpdateAgencyAccountSettingsBody = {};
    if (allowRecording !== settings.allow_recording) body.allow_recording = allowRecording;
    if (analyzeCalls !== settings.analyze_calls) body.analyze_calls = analyzeCalls;
    if (duration.trim() !== String(settings.webrtc_max_duration_seconds)) {
      const parsed = parseStrictInteger(duration);
      if (parsed === null || parsed < WEBRTC_MAX_DURATION_MIN || parsed > WEBRTC_MAX_DURATION_MAX) {
        setSaveError(
          `Max call duration must be a whole number of seconds between ${WEBRTC_MAX_DURATION_MIN} and ${WEBRTC_MAX_DURATION_MAX}.`,
        );
        return;
      }
      body.webrtc_max_duration_seconds = parsed;
    }
    if (Object.keys(body).length === 0) return;
    if (reason.trim()) body.reason = reason.trim();
    setSaving(true);
    try {
      const res = await updateAccountSettings(tenantId, accountId, body);
      apply(res.settings);
      setReason('');
      setSaved('Account settings saved.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save account settings');
    } finally {
      setSaving(false);
    }
  };

  const dirty = settings !== null && (
    allowRecording !== settings.allow_recording
    || analyzeCalls !== settings.analyze_calls
    || duration.trim() !== String(settings.webrtc_max_duration_seconds)
  );

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2><Settings size={18} /> Account Settings</h2>
      </div>
      <p className={styles.hint}>
        Recording, call analysis and the hard cap on a bridged call, per account. These replace the
        old governance toggles. Campaigns are still checked per field against these values.
      </p>
      {accounts.length === 0 ? (
        <EmptyState icon={<PhoneOff size={28} />} title="No accounts" />
      ) : (
        <form onSubmit={handleSave} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="settings-account">Account</label>
            <select id="settings-account" value={accountId} onChange={e => setAccountId(e.target.value)}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          {loading && <LoadingSpinner size="sm" />}
          {loadError && <div className={styles.error}><ErrorText message={loadError} /></div>}
          {settings && (
            <>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={allowRecording} onChange={e => setAllowRecording(e.target.checked)} />
                Allow recording
              </label>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={analyzeCalls} onChange={e => setAnalyzeCalls(e.target.checked)} />
                Analyze calls
              </label>
              <div className={styles.field}>
                <label htmlFor="settings-duration">Max call duration (seconds)</label>
                <input
                  id="settings-duration"
                  value={duration}
                  inputMode="numeric"
                  onChange={e => { setDuration(e.target.value); setSaveError(null); }}
                />
                <span className={styles.hint}>
                  {WEBRTC_MAX_DURATION_MIN} to {WEBRTC_MAX_DURATION_MAX}. A bridged call is hung up at this length.
                </span>
              </div>
              <div className={styles.field}>
                <label htmlFor="settings-max-concurrent">Max concurrent calls</label>
                <input id="settings-max-concurrent" value={settings.max_concurrent_calls} readOnly disabled />
                <span className={styles.hint}>Read-only here: set it with the concurrency editor above.</span>
              </div>
              <div className={styles.field}>
                <label htmlFor="settings-reason">Reason (optional)</label>
                <input id="settings-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} />
              </div>
              {saveError && <div className={styles.error}><ErrorText message={saveError} /></div>}
              {saved && <div className={styles.success} role="status">{saved}</div>}
              <div>
                <button type="submit" className="btn-primary" disabled={saving || !dirty}>
                  {saving ? 'Saving...' : 'Save settings'}
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </div>
  );
}
