import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, CornerDownRight, PhoneCall, PhoneIncoming, PhoneForwarded, Timer, AudioLines } from 'lucide-react';
import { useSuperAdminTenants } from '../../hooks/useSuperAdminTenants';
import {
  useSuperAdminUsageCounts,
  presetWindow,
  customWindow,
  toYmd,
  PRESET_DAYS,
  USAGE_COUNTS_MAX_WINDOW_DAYS,
  type PeriodPreset,
} from '../../hooks/useSuperAdminUsageCounts';
import { getTenantAccounts } from '../../api/super-admin';
import type { TenantAccountWithConcurrency } from '@magick-agency/contracts/api/platform/super-admin';
import type { UsageCounts, UsageCountsResponse } from '@magick-agency/contracts/api/platform/super-admin-usage';
import { PageHeader } from '../../components/common/PageHeader';
import { StatCard } from '../../components/common/StatCard';
import { DataTable } from '../../components/common/DataTable';
import type { Column } from '../../components/common/DataTable';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { EmptyState } from '../../components/common/EmptyState';
import { TenantPicker } from '../../components/super-admin/TenantPicker';
import { formatNumber } from '../../utils/format';
import styles from './SAUsagePage.module.css';

/**
 * NEW (plan §3.3, §3.4 "Usage counts"). Replaces cusui's credits/fleet usage
 * page. Read-only: dials, answered, connected calls, talk time and analysis
 * audio time per tenant and account over one window on the dial time. v1 has no
 * metering, so nothing here is billed and no rounding rule is applied: the
 * server sends exact seconds and this page only reformats them.
 */

const PRESETS: PeriodPreset[] = ['7d', '30d', '90d', 'custom'];
const PRESET_LABEL: Record<PeriodPreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  custom: 'Custom',
};

function readPeriod(params: URLSearchParams): PeriodPreset {
  const v = params.get('period');
  return PRESETS.includes(v as PeriodPreset) ? (v as PeriodPreset) : '30d';
}

/** Exact seconds as h:mm:ss; the exact second count rides in the cell's title. */
export function formatSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

interface UsageRow {
  key: string;
  kind: 'tenant' | 'account';
  tenantId: string;
  name: string;
  counts: UsageCounts;
}

function flatten(data: UsageCountsResponse, showAccounts: boolean): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const t of data.tenants) {
    rows.push({ key: `t:${t.tenant_id}`, kind: 'tenant', tenantId: t.tenant_id, name: t.tenant_name, counts: t.counts });
    if (showAccounts) {
      for (const a of t.accounts) {
        rows.push({ key: `a:${a.account_id}`, kind: 'account', tenantId: t.tenant_id, name: a.account_name, counts: a.counts });
      }
    }
  }
  return rows;
}

function seconds(n: number) {
  return <span className={styles.num} title={`${formatNumber(n)} s`}>{formatSeconds(n)}</span>;
}

export default function SAUsagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = readPeriod(searchParams);
  const tenantId = searchParams.get('tenant') ?? '';
  const accountId = tenantId ? searchParams.get('account') ?? '' : '';
  const showAccounts = searchParams.get('accounts') === '1';

  const today = toYmd(new Date());
  const fromDay = searchParams.get('from') ?? '';
  const toDay = searchParams.get('to') ?? '';

  const replaceParams = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  };

  const win = useMemo(() => {
    if (period === 'custom') return customWindow(fromDay, toDay);
    return presetWindow(PRESET_DAYS[period]);
  }, [period, fromDay, toDay]);

  const { tenants, loading: tenantsLoading } = useSuperAdminTenants();
  const [accounts, setAccounts] = useState<TenantAccountWithConcurrency[]>([]);
  useEffect(() => {
    if (!tenantId) { setAccounts([]); return; }
    let cancelled = false;
    getTenantAccounts(tenantId)
      .then((a) => { if (!cancelled) setAccounts(a); })
      .catch(() => { if (!cancelled) setAccounts([]); });
    return () => { cancelled = true; };
  }, [tenantId]);

  const { data, loading, error, windowError, reload } = useSuperAdminUsageCounts({
    window: win,
    tenantId: tenantId || undefined,
    accountId: accountId || undefined,
  });

  const rows = useMemo(() => (data ? flatten(data, showAccounts) : []), [data, showAccounts]);

  const columns: Column<UsageRow>[] = [
    {
      key: 'name',
      label: 'Tenant / account',
      render: (r) => r.kind === 'tenant' ? (
        <div className={styles.nameCell}>
          <Building2 size={16} className={styles.nameIcon} />
          <span className={styles.nameTitle}>{r.name}</span>
        </div>
      ) : (
        <div className={`${styles.nameCell} ${styles.accountRow}`}>
          <CornerDownRight size={14} className={styles.nameIcon} />
          <span>{r.name}</span>
        </div>
      ),
    },
    { key: 'dials', label: 'Dials', align: 'right', render: (r) => <span className={styles.num}>{formatNumber(r.counts.dials)}</span> },
    { key: 'answered', label: 'Answered', align: 'right', render: (r) => <span className={styles.num}>{formatNumber(r.counts.answered_calls)}</span> },
    { key: 'connected', label: 'Connected', align: 'right', render: (r) => <span className={styles.num}>{formatNumber(r.counts.connected_calls)}</span> },
    { key: 'talk', label: 'Talk time', align: 'right', render: (r) => seconds(r.counts.talk_seconds) },
    { key: 'analysis', label: 'Analysis audio', align: 'right', render: (r) => seconds(r.counts.analysis_audio_seconds) },
  ];

  const totals = data?.totals;

  return (
    <div>
      <PageHeader
        title="Usage"
        subtitle="Dials, answered and connected calls, talk time and analysis audio per tenant and account."
      />

      <div className={styles.filterBar}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Period</span>
          <div className={styles.segmented}>
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={`${styles.pill} ${period === p ? styles.pillActive : ''}`}
                aria-pressed={period === p}
                onClick={() => {
                  if (p === 'custom') {
                    // Seed the pickers so the first custom render is a valid window.
                    const end = toYmd(new Date());
                    const start = toYmd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 6));
                    replaceParams({ period: 'custom', from: fromDay || start, to: toDay || end });
                  } else {
                    replaceParams({ period: p === '30d' ? undefined : p, from: undefined, to: undefined });
                  }
                }}
              >
                {PRESET_LABEL[p]}
              </button>
            ))}
          </div>
        </div>

        {period === 'custom' && (
          <>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel} htmlFor="usage-from">From</label>
              <input
                id="usage-from"
                type="date"
                className={styles.dateInput}
                value={fromDay}
                max={today}
                onChange={(e) => replaceParams({ from: e.target.value || undefined })}
              />
            </div>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel} htmlFor="usage-to">To (inclusive)</label>
              <input
                id="usage-to"
                type="date"
                className={styles.dateInput}
                value={toDay}
                max={today}
                onChange={(e) => replaceParams({ to: e.target.value || undefined })}
              />
            </div>
          </>
        )}

        <div className={`${styles.filterGroup} ${styles.pickerBox}`}>
          <label className={styles.filterLabel} htmlFor="usage-tenant">Tenant</label>
          <TenantPicker
            id="usage-tenant"
            tenants={tenants}
            value={tenantId}
            loading={tenantsLoading}
            placeholder="All tenants"
            // Changing tenant drops the account: it belongs to the old tenant.
            onChange={(id) => replaceParams({ tenant: id || undefined, account: undefined })}
          />
        </div>

        {tenantId && (
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel} htmlFor="usage-account">Account</label>
            <select
              id="usage-account"
              value={accountId}
              onChange={(e) => replaceParams({ account: e.target.value || undefined })}
            >
              <option value="">All accounts</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}

        <label className={styles.check}>
          <input
            type="checkbox"
            checked={showAccounts}
            onChange={(e) => replaceParams({ accounts: e.target.checked ? '1' : undefined })}
          />
          Show accounts
        </label>
      </div>

      <p className={styles.hint}>
        Counts only — nothing is charged and no rounding is applied; talk and analysis time are exact
        seconds shown as h:mm:ss. Every figure is counted on the dial time of the attempt, so a window
        covers the same set of dials in every column. The end date is inclusive; the window is capped
        at {USAGE_COUNTS_MAX_WINDOW_DAYS} days.
      </p>

      {windowError && <div className={styles.windowError} role="alert">{windowError}</div>}
      {error && <ErrorAlert message={error} onRetry={reload} />}

      {totals && (
        <div className={styles.statsGrid}>
          <StatCard title="Dials" value={formatNumber(totals.dials)} icon={<PhoneCall size={18} />} />
          <StatCard title="Answered" value={formatNumber(totals.answered_calls)} icon={<PhoneIncoming size={18} />} />
          <StatCard title="Connected" value={formatNumber(totals.connected_calls)} icon={<PhoneForwarded size={18} />} color="var(--success)" />
          <StatCard title="Talk time" value={formatSeconds(totals.talk_seconds)} subtitle={`${formatNumber(totals.talk_seconds)} s`} icon={<Timer size={18} />} color="var(--accent)" />
          <StatCard title="Analysis audio" value={formatSeconds(totals.analysis_audio_seconds)} subtitle={`${formatNumber(totals.analysis_audio_seconds)} s`} icon={<AudioLines size={18} />} />
        </div>
      )}

      {!loading && !error && !windowError && data && data.tenants.length === 0 ? (
        <EmptyState title="No activity in this window" description="No dials were placed in the selected period for these filters." />
      ) : (
        !windowError && !error && (
          <DataTable<UsageRow>
            columns={columns}
            data={rows}
            loading={loading}
            keyExtractor={(r) => r.key}
          />
        )
      )}
    </div>
  );
}
