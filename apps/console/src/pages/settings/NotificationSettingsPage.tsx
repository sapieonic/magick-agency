import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Save } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '../../contexts/ToastContext';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../../api/notifications';
import {
  PageDescription,
  PageHeader,
  EmptyState,
  ErrorAlert,
  LoadingSpinner,
} from '../../components/common';
import type {
  NotificationEventPreference,
  NotificationFrequency,
} from '../../types/notifications';
import styles from './NotificationSettingsPage.module.css';

/**
 * Which emails this person receives, and how often.
 *
 * ── The catalog is SERVED, never mirrored ─────────────────────────────────
 *
 * Everything rendered here — the events, their labels, their descriptions,
 * which are digests, what the defaults are — arrives from
 * `GET /notifications/preferences`. There is no local copy of any of it, which
 * is the same rule the audit log's `available_actions` follows: the server is not a
 * dependency of this repo, nothing could check a copy, and the copy is what
 * drifts. A server build with a new event lights it up here with no change on
 * this side.
 *
 * The consequence to keep in mind while editing: `category` is an arbitrary
 * string. `CATEGORY_LABELS` is a presentation nicety with a humanising
 * fallback, NOT a whitelist — a category this build has never heard of must
 * still render its events rather than silently dropping them.
 *
 * ── It is about the signed-in person and nobody else ──────────────────────
 *
 * No user picker, no role gate. The server reads the caller from the session and
 * the routes take no subject, so this page cannot show or change a colleague's
 * subscriptions. That is also why the sidebar entry floors at `tenant.read`
 * rather than at an admin permission: an unsubscribe link that only admins can
 * follow is not an unsubscribe link.
 */

/** Display names for the groupings the server sends. A fallback, never a filter. */
const CATEGORY_LABELS: Record<string, string> = {
  digests: 'Summaries',
  campaigns: 'Campaigns',
  agency: 'Agency dialer',
};

const FREQUENCY_LABELS: Record<NotificationFrequency, string> = {
  daily: 'Every day',
  weekly: 'Every week',
};

function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category];
  if (known) return known;
  return category.charAt(0).toUpperCase() + category.slice(1).replace(/[_-]/g, ' ');
}

/*
 * There is no digest preview: no `POST /notifications/digests/preview` call, no
 * modal and no Preview button on a digest row. Such a preview would render a
 * credits spend summary over AI calls and broadcasts; Magick Agency v1 has no
 * credits and no broadcasts, and no such route. The cadence controls for any
 * digest-cadence event stay.
 */

/**
 * Does the value on screen still match what the catalog would give?
 *
 * `is_default` says the STORED state is absent, which stops being the whole
 * question the moment there is an unsaved edit. Both halves are compared
 * because a digest has two controls: changing only the cadence is as much a
 * divergence from the default as switching it off.
 *
 * `default_frequency` is `null` on an immediate event and the draft's
 * `frequency` is `null` there too, so the comparison is true without a special
 * case for cadence.
 */
function isAtDefault(
  event: NotificationEventPreference,
  value: { enabled: boolean; frequency: NotificationFrequency | null },
): boolean {
  return value.enabled === event.default_enabled
    && value.frequency === event.default_frequency;
}

export default function NotificationSettingsPage() {
  const { tenantId } = useTenant();
  const { showToast, showErrorToast } = useToast();

  const [events, setEvents] = useState<NotificationEventPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * The events as edited, keyed by event key.
   *
   * Held separately from `events` so the page is a form with a Save rather than
   * a set of switches that each fire a request. A digest has TWO controls (on,
   * and how often) and saving on every keystroke of a select would write an
   * intermediate state — plus a partial save is invisible, and this is a screen
   * where "I thought I turned that off" is the failure to avoid.
   */
  const [draft, setDraft] = useState<Record<string, { enabled: boolean; frequency: NotificationFrequency | null }>>({});


  /**
   * Monotonic token fencing the in-flight GET, in the shape
   * `BulkDispatchJobDetailPage`'s `fetchJobTokenRef` uses.
   *
   * Not defensive tidiness — without it this page could commit ANOTHER TENANT'S
   * preferences and then save them here. `load` is recreated when `tenantId`
   * changes and the effect re-fires, but nothing cancelled the request already
   * out, and TopBar's tenant switcher is on this very page:
   *
   *   1. GET for tenant A is in flight
   *   2. the person switches to tenant B, GET B starts
   *   3. A resolves LAST → `setEvents`/`setDraft` hold A's values while the
   *      session is B
   *   4. Save → `PUT /notifications/preferences` sends A's draft under B's
   *      `X-Tenant-Id`
   *
   * That is a cross-tenant write of somebody's personal subscriptions, and
   * neither request failed, so nothing surfaces. The token is captured at the
   * start and re-checked after every await, including the post-save refetch.
   */
  const loadTokenRef = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (!tenantId) return;
    const token = ++loadTokenRef.current;
    // `silent` exists for the post-save refetch: replacing the whole form with
    // a spinner after a successful save makes a slow follow-up GET look like
    // the save itself failed.
    if (!silent) setLoading(true);
    setError(null);
    try {
      const response = await getNotificationPreferences(tenantId);
      if (token !== loadTokenRef.current) return;
      setEvents(response.events);
      setDraft(Object.fromEntries(
        response.events.map((event) => [event.key, {
          enabled: event.enabled,
          frequency: event.frequency,
        }]),
      ));
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      setError(err instanceof Error ? err.message : 'Could not load your notification settings');
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  /** Only what the person actually changed is sent — the body is a PATCH. */
  const changed = useMemo(
    () => events.filter((event) => {
      const next = draft[event.key];
      if (!next) return false;
      return next.enabled !== event.enabled || next.frequency !== event.frequency;
    }),
    [events, draft],
  );

  const grouped = useMemo(() => {
    const byCategory = new Map<string, NotificationEventPreference[]>();
    for (const event of events) {
      const list = byCategory.get(event.category);
      if (list) list.push(event);
      else byCategory.set(event.category, [event]);
    }
    return [...byCategory.entries()];
  }, [events]);

  const setEnabled = (key: string, enabled: boolean) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key]!, enabled } }));
  };

  const setFrequency = (key: string, frequency: NotificationFrequency) => {
    // Choosing a cadence implies wanting the digest. Leaving `enabled` alone
    // here would let somebody pick "Every day" on a switched-off digest and
    // save a setting that changes nothing.
    setDraft((prev) => ({ ...prev, [key]: { enabled: true, frequency } }));
  };

  const handleSave = async () => {
    if (!tenantId || changed.length === 0) return;
    setSaving(true);
    try {
      await updateNotificationPreferences(
        tenantId,
        changed.map((event) => ({
          event_key: event.key,
          channel: event.channel,
          enabled: draft[event.key]!.enabled,
          // The server refuses a frequency on an immediate event rather than
          // ignoring it, so it is sent only where it means something.
          ...(event.cadence === 'digest' ? { frequency: draft[event.key]!.frequency } : {}),
        })),
      );
      showToast('Notification settings saved', 'success');
      // Silent: the form is already showing what was saved, and swapping it for
      // a spinner makes a slow follow-up GET read as a failed save.
      await load(true);
    } catch (err) {
      // `showErrorToast`, not `showToast(err.message)` — the repo's convention,
      // and it is what keeps a masked 5xx's request id in a copyable chip
      // rather than buried in the sentence, at the longer error dwell.
      showErrorToast(err, 'Could not save your settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className={styles.loadingWrap}><LoadingSpinner /></div>;
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Notifications"
        actions={
          <div className={styles.headerActions}>
            {changed.length > 0 && (
              <span className={styles.unsaved}>
                {changed.length} unsaved {changed.length === 1 ? 'change' : 'changes'}
              </span>
            )}
            <button
              type="button"
              className={styles.saveButton}
              onClick={() => void handleSave()}
              disabled={saving || changed.length === 0}
            >
              <Save size={15} />
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        }
      />
      <PageDescription
        pageKey="notifications"
        description={
          'Choose which emails you receive from this workspace. These settings are yours alone — '
          + 'they do not affect your colleagues, and you have separate settings in every workspace '
          + 'you belong to.'
        }
        tips={[
          'A summary is only sent for periods with activity, so a quiet week means no email.',
        ]}
      />

      {error && <ErrorAlert message={error} onRetry={() => void load()} />}

      {!error && events.length === 0 && (
        <EmptyState
          icon={<Mail size={22} />}
          title="Nothing to configure"
          /*
           * This branch means "the server returned no events this role can
           * receive", which today is RARE — and the story that used to be here
           * ("a dialer agent has no subscriptions") was simply wrong.
           * `isEventAddressableToRole` returns true for every `explicit`
           * -audience event for every role, so an `agent` who opens this page
           * sees Campaign started and Campaign finished: those addresses are
           * typed into a campaign form and may be theirs. The server's own route
           * says so — refusing the page to such a caller "would be wrong, they
           * have real subscriptions to manage".
           *
           * So this is the genuinely-empty catalog, not a role story. Kept
           * because an empty page reads as a failure either way.
           */
          description="There are no notifications aimed at your role in this workspace yet."
        />
      )}

      {grouped.map(([category, categoryEvents]) => (
        <section key={category} className={styles.group}>
          <h2 className={styles.groupTitle}>{categoryLabel(category)}</h2>

          <div className={styles.card}>
            {categoryEvents.map((event) => {
              const value = draft[event.key] ?? { enabled: event.enabled, frequency: event.frequency };
              return (
                <div key={event.key} className={styles.row}>
                  <div className={styles.rowMain}>
                    <div className={styles.rowHeader}>
                      <span className={styles.rowLabel}>{event.label}</span>
                      {event.is_default && isAtDefault(event, value) && (
                        /*
                         * Somebody who has never opened this page IS subscribed
                         * — showing that as "unset" would invite them to turn
                         * on something already on. The chip says the value is
                         * the default rather than that it is absent.
                         *
                         * Driven off the DRAFT as well as the stored row: keyed
                         * on `is_default` alone the chip survived an edit, so
                         * toggling a default subscription off read "Off ·
                         * Default" until Save and reload. The chip's claim is
                         * about the value ON SCREEN, and once the draft
                         * diverges that value no longer came from the catalog.
                         */
                        <span className={styles.defaultChip}>Default</span>
                      )}
                    </div>
                    <p className={styles.rowDescription}>{event.description}</p>

                    {event.cadence === 'digest' && (
                      <div className={styles.frequencyRow}>
                        {(Object.keys(FREQUENCY_LABELS) as NotificationFrequency[]).map((frequency) => (
                          <label
                            key={frequency}
                            className={`${styles.frequencyOption} ${
                              value.frequency === frequency ? styles.frequencyOptionActive : ''
                            }`}
                          >
                            <input
                              type="radio"
                              name={`frequency-${event.key}`}
                              checked={value.frequency === frequency}
                              onChange={() => setFrequency(event.key, frequency)}
                            />
                            {FREQUENCY_LABELS[frequency]}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  <label className={styles.enableControl}>
                    <span>{value.enabled ? 'On' : 'Off'}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`${event.label} enabled`}
                      checked={value.enabled}
                      onChange={(e) => setEnabled(event.key, e.target.checked)}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </section>
      ))}

    </div>
  );
}
