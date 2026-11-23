import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Info, PhoneCall, X } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { PageDescription } from '../../components/common/PageDescription';
import { useTenant } from '../../contexts/TenantContext';
import { usePermission } from '../../hooks/usePermission';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { getCallSettings, putCallSettings } from '../../api/callSettings';
import {
  CALL_SETTINGS_COPY as COPY,
  agentsWithoutCampaignLine,
  confirmTitle,
  routesMissingLine,
  unfiledCallsLine,
} from '../../utils/callSettingsCopy';
import type { AgencyCallSettingsResponse, AgencyCallSettingsRouteRef } from '../../types/call-settings';
import { AGENCY_CALL_SETTINGS_UNFILED_DAYS } from '../../types/call-settings';
import { unfiledCallsPath } from '../../utils/agency/callLog';
import { useSettingsNav } from './useSettingsNav';
import styles from './CallsSettingsPage.module.css';

/**
 * Settings → Calls (`docs/call-log.md` §5): the account's switch "Every call must belong to a
 * campaign", with what stands in its way. The switch is refused, here and by the server, while an
 * inbound number has no campaign for unknown callers; agents on no running campaign are listed
 * for information and block nothing. Switching on asks first; switching off does not.
 *
 * `agency.calls.manage` (account admin). The setting is enforced by the server on every dial and
 * every inbound outcome; this page only turns it on and off.
 */
export default function CallsSettingsPage() {
  const { tenantId, accountId } = useTenant();
  const { names } = useSettingsNav();
  const { showToast } = useToast();
  const canManage = usePermission('agency.calls.manage');
  const mayEditRoutes = usePermission('agency.inbound.write');
  const mayOpenCampaigns = usePermission('agency.campaigns.read');
  const inboundOn = useFeatureFlagEnabled(INBOUND_FLAG);

  const [data, setData] = useState<AgencyCallSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The routes a refused switch named, until the next read replaces them. */
  const [refusedRoutes, setRefusedRoutes] = useState<AgencyCallSettingsRouteRef[] | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !accountId || !canManage) return;
    setLoading(true);
    setLoadError(null);
    try {
      setData(await getCallSettings(tenantId, accountId));
      setRefusedRoutes(null);
    } catch (err) {
      setLoadError(getErrorMessage(err, COPY.loadFailed));
    } finally {
      setLoading(false);
    }
  }, [tenantId, accountId, canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  const write = async (on: boolean) => {
    if (!tenantId || !accountId || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await putCallSettings(on, tenantId, accountId);
    setSaving(false);
    if (result.ok) {
      setData(result.value);
      setRefusedRoutes(null);
      setConfirming(false);
      showToast(on ? COPY.switchedOn : COPY.switchedOff, 'success');
      return;
    }
    setConfirming(false);
    if (result.refusal.code === 'default_campaign_required') {
      // A number lost its campaign, or one was added, since the page was read.
      setRefusedRoutes(result.refusal.routes);
      setSaveError(COPY.blocked);
      return;
    }
    setSaveError(result.refusal.status === null ? COPY.saveFailed : result.refusal.message);
  };

  if (!canManage) {
    return (
      <div className={styles.page}>
        <PageHeader title={COPY.title} />
        <EmptyState icon={<PhoneCall size={22} />} title={COPY.title} description={COPY.forbidden} />
      </div>
    );
  }
  if (loading && !data) return <LoadingSpinner />;
  if (loadError || !data) {
    return (
      <div className={styles.page}>
        <PageHeader title={COPY.title} />
        <ErrorAlert message={loadError ?? COPY.loadFailed} onRetry={() => void load()} />
      </div>
    );
  }

  const on = data.settings.require_campaign;
  const { readiness } = data;
  const missing = refusedRoutes ?? readiness.routes_missing_default;
  const blocked = missing.length > 0;
  const agents = readiness.agents_without_campaign;

  return (
    <div className={styles.page}>
      <PageHeader title={COPY.title} />
      <PageDescription pageKey="calls-settings" description={COPY.description} />
      <section className="card" aria-labelledby="calls-require-campaign" data-testid="calls-require-campaign">
        <div className={styles.switchRow}>
          <div>
            <h2 className={styles.switchLabel} id="calls-require-campaign">{COPY.switchLabel}</h2>
            <p className={styles.state} data-on={on ? 'true' : 'false'} data-testid="calls-require-state">{on ? COPY.onNow : COPY.offNow}</p>
          </div>
          {on ? (
            <button
              type="button"
              className="btn-secondary"
              role="switch"
              aria-checked="true"
              aria-labelledby="calls-require-campaign"
              disabled={saving}
              onClick={() => void write(false)}
              data-testid="calls-require-switch"
            >
              {saving ? COPY.switchingOff : COPY.switchOff}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              role="switch"
              aria-checked="false"
              aria-labelledby="calls-require-campaign"
              aria-describedby={blocked ? 'calls-blocked' : undefined}
              disabled={blocked || confirming || saving}
              onClick={() => {
                setSaveError(null);
                setConfirming(true);
              }}
              data-testid="calls-require-switch"
            >
              {COPY.switchOn}
            </button>
          )}
        </div>
        <p className={styles.help}>{COPY.help}</p>

        <ul className={styles.checks} aria-label="What this needs">
          <li className={styles.check} data-kind="ready" data-testid="calls-check-softphone">
            <Check size={16} aria-hidden="true" />
            <span className={styles.checkBody}>
              <span className={styles.srOnly}>{COPY.ready}: </span>
              {on ? COPY.softphoneOn : COPY.softphoneReady}
            </span>
          </li>
          {blocked ? (
            <li className={styles.check} data-kind="blocked" id="calls-blocked" data-testid="calls-check-inbound">
              <X size={16} aria-hidden="true" />
              <span className={styles.checkBody}>
                <span className={styles.srOnly}>{COPY.notReady}: </span>
                {routesMissingLine(missing.length)}{' '}
                {missing.map((route, i) => (
                  <span key={route.route_id}>
                    {i > 0 ? ', ' : ''}
                    {mayEditRoutes && inboundOn
                      ? <Link to={`/settings/inbound/${route.route_id}`} aria-label={`${COPY.chooseCampaign} for ${route.name}`}>{route.name}</Link>
                      : route.name}
                  </span>
                ))}
                .
                {mayEditRoutes && inboundOn ? (
                  <>
                    <br />
                    <Link to={`/settings/inbound/${missing[0]!.route_id}`} className={styles.checkAction} data-testid="calls-choose-campaign">
                      {COPY.chooseCampaign}
                    </Link>
                  </>
                ) : null}
              </span>
            </li>
          ) : inboundOn ? (
            <li className={styles.check} data-kind="ready" data-testid="calls-check-inbound">
              <Check size={16} aria-hidden="true" />
              <span className={styles.checkBody}>
                <span className={styles.srOnly}>{COPY.ready}: </span>
                {COPY.inboundReady}
              </span>
            </li>
          ) : (
            // Inbound is off for the account: the server counts none of its routes (CL18).
            <li className={styles.check} data-kind="info" data-testid="calls-check-inbound">
              <Info size={16} aria-hidden="true" />
              <span className={styles.checkBody}>
                <span className={styles.srOnly}>{COPY.note}: </span>
                {COPY.inboundOff}
              </span>
            </li>
          )}
          {readiness.agents_without_campaign_total > 0 ? (
            <li className={styles.check} data-kind="info" data-testid="calls-check-agents">
              <Info size={16} aria-hidden="true" />
              <span className={styles.checkBody}>
                <span className={styles.srOnly}>{COPY.note}: </span>
                {agentsWithoutCampaignLine(agents, readiness.agents_without_campaign_total, on)}
                {mayOpenCampaigns ? (
                  <>
                    <br />
                    <Link to="/agency/campaigns" className={styles.checkAction} data-testid="calls-open-campaigns">{COPY.openCampaigns}</Link>
                  </>
                ) : null}
              </span>
            </li>
          ) : null}
        </ul>

        {confirming && !on ? (
          <div className={styles.confirm} role="group" aria-labelledby="calls-confirm-title" data-testid="calls-confirm">
            <p className={styles.confirmTitle} id="calls-confirm-title">{confirmTitle(names.accountName)}</p>
            <p className={styles.confirmBody}>{COPY.confirmBody}</p>
            <div className={styles.buttons}>
              <button type="button" className="btn-primary" disabled={saving} onClick={() => void write(true)} data-testid="calls-confirm-on">
                {saving ? COPY.switchingOn : COPY.switchOn}
              </button>
              <button type="button" className="btn-secondary" disabled={saving} onClick={() => setConfirming(false)} data-testid="calls-confirm-cancel">
                {COPY.cancel}
              </button>
            </div>
          </div>
        ) : null}
        {saveError ? <ErrorAlert message={saveError} /> : null}
      </section>

      <p className={styles.count}>
        <span data-testid="calls-unfiled-count">{unfiledCallsLine(readiness.unfiled_calls)}</span>
        {/* All calls floors at `agency.supervise`, which whoever may open this page holds. */}
        {readiness.unfiled_calls > 0 ? (
          <>
            {' '}
            <Link to={unfiledCallsPath(AGENCY_CALL_SETTINGS_UNFILED_DAYS)} data-testid="calls-unfiled-link">{COPY.seeUnfiled}</Link>
          </>
        ) : null}
      </p>
    </div>
  );
}
