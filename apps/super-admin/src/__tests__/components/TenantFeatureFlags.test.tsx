import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type {
  FeatureFlagCatalogResponse,
  FeatureFlagResolveResponse,
  FlagResolutionSource,
} from '@magick-agency/contracts/api/platform/super-admin';

const mocks = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  resolve: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  bulk: vi.fn(),
}));

vi.mock('../../api/super-admin', () => ({
  getFeatureFlagCatalog: mocks.getCatalog,
  resolveFeatureFlags: mocks.resolve,
  putFeatureFlagOverride: mocks.put,
  deleteFeatureFlagOverride: mocks.del,
  bulkFeatureFlagOverride: mocks.bulk,
}));

import { TenantFeatureFlags } from '../../components/super-admin/TenantFeatureFlags';

/**
 * `env_default` is the server's `resolveEnvDefault(f)`, which returns the registry
 * `default` when the flag's env var is unset — and no flag has a null default.
 * It is therefore NEVER null on the wire; keep fixtures mirroring `default`
 * rather than nulling the field, which tests a response the server cannot produce.
 */
const CATALOG: FeatureFlagCatalogResponse = {
  flags: [
    {
      key: 'agency_dialer_enabled', type: 'boolean', default: false, env_default: false,
      scopes: ['global', 'tenant'], client_exposed: true, owner: 'messaging',
      description: 'Agency dialer', global_override: null,
    },
  ],
};

function makeResolve(
  effective: boolean,
  source: FlagResolutionSource,
  overrides: FeatureFlagResolveResponse['overrides'] = [],
): FeatureFlagResolveResponse {
  return {
    tenant_id: 't-1',
    account_id: null,
    effective: { agency_dialer_enabled: effective },
    source: { agency_dialer_enabled: source },
    defaults: { agency_dialer_enabled: false },
    overrides,
  };
}

function tenantOverride(value: boolean): FeatureFlagResolveResponse['overrides'][number] {
  return {
    id: 'o-1', flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: 't-1',
    account_id: null, value, reason: null, expires_at: null, updated_by: null,
    created_at: '2026-06-23T00:00:00Z', updated_at: '2026-06-23T00:00:00Z',
  };
}

function renderComp() {
  return render(<TenantFeatureFlags tenantId="t-1" accounts={[{ id: 'acc-1', name: 'Sales' }]} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCatalog.mockResolvedValue(CATALOG);
  mocks.put.mockResolvedValue({});
  mocks.del.mockResolvedValue({});
  mocks.bulk.mockResolvedValue({ applied: [], failed: [] });
});
afterEach(() => cleanup());

describe('TenantFeatureFlags — source-driven inherited sub-line', () => {
  const cases: Array<[FlagResolutionSource, boolean, RegExp]> = [
    ['global', true, /set globally/i],
    ['env', true, /from env/i],
    ['tenant', true, /from tenant/i],
    ['default', false, /default: Off/i],
  ];

  for (const [source, effective, re] of cases) {
    it(`renders the right sub-line for source=${source}`, async () => {
      mocks.resolve.mockResolvedValue(makeResolve(effective, source));
      renderComp();
      await waitFor(() => expect(screen.getByText(re)).toBeTruthy());
    });
  }

  it('source=default + On shows the bare On default (no qualifier)', async () => {
    mocks.resolve.mockResolvedValue(makeResolve(true, 'default'));
    renderComp();
    await waitFor(() => expect(screen.getByText(/Inherited \(default: On\)$/)).toBeTruthy());
  });
});

describe('TenantFeatureFlags — confirm-gate on destructive Off', () => {
  it('turning OFF a currently-enabled flag shows a confirm dialog (does not write yet)', async () => {
    // Currently On via a tenant override.
    mocks.resolve.mockResolvedValue(makeResolve(true, 'tenant', [tenantOverride(true)]));
    renderComp();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Off' })).toBeTruthy());

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));

    // Confirm dialog appears; no write committed.
    await waitFor(() => expect(screen.getByText(/is currently available to/i)).toBeTruthy());
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('cancel aborts the write', async () => {
    mocks.resolve.mockResolvedValue(makeResolve(true, 'tenant', [tenantOverride(true)]));
    renderComp();
    await waitFor(() => screen.getByRole('radio', { name: 'Off' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() => screen.getByText(/is currently available to/i));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText(/is currently available to/i)).toBeNull());
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('confirming "Turn off" proceeds to the write (reason popover for explicit Off)', async () => {
    mocks.resolve.mockResolvedValue(makeResolve(true, 'tenant', [tenantOverride(true)]));
    renderComp();
    await waitFor(() => screen.getByRole('radio', { name: 'Off' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() => screen.getByText(/is currently available to/i));
    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));

    // The explicit Off opens the reason popover (required reason); fill + save.
    await waitFor(() => screen.getByLabelText(/reason \(required\)/i));
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'rollback pilot' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      expect.objectContaining({ scope_type: 'tenant', tenant_id: 't-1', value: false, reason: 'rollback pilot' }),
    ));
  });

  it('ENABLING does not confirm — goes straight to the reason popover', async () => {
    // Currently off (no override).
    mocks.resolve.mockResolvedValue(makeResolve(false, 'default'));
    renderComp();
    await waitFor(() => screen.getByRole('radio', { name: 'On' }));

    fireEvent.click(screen.getByRole('radio', { name: 'On' }));

    // No confirm dialog; the reason popover opens directly.
    expect(screen.queryByText(/is currently available to/i)).toBeNull();
    await waitFor(() => expect(screen.getByLabelText(/reason \(required\)/i)).toBeTruthy());
  });

  it('no longer renders the cross-tenant bulk control (relocated to the global registry)', async () => {
    mocks.resolve.mockResolvedValue(makeResolve(false, 'default'));
    renderComp();
    await waitFor(() => screen.getByRole('radio', { name: 'On' }));
    expect(screen.queryByRole('button', { name: /bulk enable/i })).toBeNull();
  });
});

describe('TenantFeatureFlags — account scope', () => {
  it('selecting an account re-resolves and writes scope_type=account with account_id', async () => {
    // The shared CATALOG fixture is `scopes: ['global', 'tenant']` (mirroring
    // the server's real `agency_dialer_enabled`), which the scope gate now correctly locks
    // at account scope. Widen it for this test — the flow under test is the
    // account-scope request body, not the gate.
    mocks.getCatalog.mockResolvedValue({
      flags: [{ ...CATALOG.flags[0]!, scopes: ['global', 'tenant', 'account'] }],
    });
    mocks.resolve.mockResolvedValue(makeResolve(false, 'default'));
    renderComp();
    await waitFor(() => screen.getByRole('combobox'));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acc-1' } });
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith('t-1', 'acc-1'));

    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    await waitFor(() => screen.getByLabelText(/reason \(required\)/i));
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'account pilot' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      expect.objectContaining({ scope_type: 'account', tenant_id: 't-1', account_id: 'acc-1', value: true }),
    ));
  });
});

describe('TenantFeatureFlags — error state', () => {
  it('surfaces a load failure', async () => {
    mocks.resolve.mockRejectedValue(new Error('nope'));
    renderComp();
    await waitFor(() => expect(screen.getByText(/nope/i)).toBeTruthy());
  });

  it('surfaces a failure when saving an override', async () => {
    mocks.resolve.mockResolvedValue(makeResolve(false, 'default'));
    mocks.put.mockRejectedValue(new Error('write failed'));
    renderComp();
    await waitFor(() => screen.getByRole('radio', { name: 'On' }));
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    await waitFor(() => screen.getByLabelText(/reason \(required\)/i));
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));
    await waitFor(() => expect(screen.getByText(/write failed/i)).toBeTruthy());
  });

  it('surfaces a failure when resetting an override', async () => {
    mocks.resolve.mockResolvedValue(makeResolve(true, 'tenant', [tenantOverride(true)]));
    mocks.del.mockRejectedValue(new Error('reset failed'));
    renderComp();
    const reset = await screen.findByRole('button', { name: /reset to inherited/i });
    fireEvent.click(reset);
    await waitFor(() => expect(screen.getByText(/reset failed/i)).toBeTruthy());
  });
});

describe('TenantFeatureFlags — override row affordances', () => {
  it('the reset button deletes the override at the active scope (no confirm)', async () => {
    mocks.resolve.mockResolvedValue(makeResolve(true, 'tenant', [tenantOverride(true)]));
    renderComp();
    const reset = await screen.findByRole('button', { name: /reset to inherited/i });
    fireEvent.click(reset);
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      { scope_type: 'tenant', tenant_id: 't-1' },
    ));
  });

  it('renders a relative expiry for an override that expires in the future', async () => {
    const expiring = { ...tenantOverride(true), expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString() };
    mocks.resolve.mockResolvedValue(makeResolve(true, 'tenant', [expiring]));
    renderComp();
    await waitFor(() => expect(screen.getByText('in 3d')).toBeTruthy());
  });

  it('renders numeric flags with an inline value + Edit button (not "Set via API")', async () => {
    mocks.getCatalog.mockResolvedValue({
      flags: [numericFlag()],
    });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    renderComp();
    await waitFor(() => screen.getByText('Pre-warm ring delay (ms)'));
    // Inline value is rendered as a number, not the "Set via API" placeholder.
    expect(screen.getByText('3000')).toBeTruthy();
    expect(screen.queryByText(/set via api/i)).toBeNull();
    // Numeric flags don't get the boolean tri-state control.
    expect(screen.queryByRole('radio', { name: 'On' })).toBeNull();
    // But they DO get an Edit button.
    expect(screen.getByRole('button', { name: /edit/i })).toBeTruthy();
    // …and the source chip attributes to the registry default (no override, no env).
    expect(screen.getByText(/registry default/i)).toBeTruthy();
  });

  it('renders string/json (unsupported) flags as read-only with a "Set via API" hint', async () => {
    mocks.getCatalog.mockResolvedValue({
      flags: [{
        key: 'max_threads_label', type: 'string', default: 'auto', env_default: 'auto',
        scopes: ['global', 'tenant'], client_exposed: false, owner: 'dialer',
        description: 'worker threads label', global_override: null,
      }],
    });
    mocks.resolve.mockResolvedValue({
      tenant_id: 't-1', account_id: null, effective: { max_threads_label: 'auto' },
      source: { max_threads_label: 'default' }, defaults: { max_threads_label: 'auto' }, overrides: [],
    });
    renderComp();
    await waitFor(() => screen.getByText('Max Threads Label'));
    expect(screen.getByText(/set via api/i)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'On' })).toBeNull();
  });
});

/**
 * Helpers for the numeric override write-path tests. Kept local so the
 * boolean-flag scenarios above stay untouched.
 */
function numericFlag(overrides: Partial<import('@magick-agency/contracts/api/platform/super-admin').FeatureFlagCatalogEntry> = {}) {
  return {
    key: 'prewarm_ring_delay_ms', type: 'number' as const, default: 3000, env_default: 3000,
    scopes: ['tenant'] as import('@magick-agency/contracts/api/platform/super-admin').FlagScopeType[], client_exposed: false, owner: 'voice',
    description: 'Deferred pre-warm ring delay in ms (0..30000, per-tenant override)',
    global_override: null,
    ...overrides,
  };
}

function numericOverride(overrides: Partial<FeatureFlagResolveResponse['overrides'][number]> = {}): FeatureFlagResolveResponse['overrides'][number] {
  return {
    id: 'o-num', flag_key: 'prewarm_ring_delay_ms', scope_type: 'tenant', tenant_id: 't-1',
    account_id: null, value: 5000, reason: null, expires_at: null, updated_by: null,
    created_at: '2026-06-23T00:00:00Z', updated_at: '2026-06-23T00:00:00Z',
    ...overrides,
  };
}

function numericResolve(opts: {
  effective?: number;
  source?: FlagResolutionSource;
  overrides?: FeatureFlagResolveResponse['overrides'];
  accountId?: string | null;
} = {}): FeatureFlagResolveResponse {
  return {
    tenant_id: 't-1',
    account_id: opts.accountId ?? null,
    effective: { prewarm_ring_delay_ms: opts.effective ?? 3000 },
    source: { prewarm_ring_delay_ms: opts.source ?? 'default' },
    defaults: { prewarm_ring_delay_ms: 3000 },
    overrides: opts.overrides ?? [],
  };
}

describe('TenantFeatureFlags — numeric override write path', () => {
  it('opens the number dialog, validates bounds, and PUTs the override at the tenant scope', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    renderComp();

    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    // Value field is prefilled with the current effective value (3000).
    const valueInput = screen.getByLabelText(/^Value/i) as HTMLInputElement;
    expect(valueInput.value).toBe('3000');

    // Reason is required — Save stays disabled until reason is filled.
    const save = screen.getByRole('button', { name: /save override/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Out-of-range value → save stays disabled and an inline error surfaces.
    fireEvent.change(valueInput, { target: { value: '99999' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'testing' } });
    expect(screen.getByText(/must be ≤ 30000/i)).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Valid value + reason → Save fires the PUT with the right shape.
    fireEvent.change(valueInput, { target: { value: '5000' } });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      'prewarm_ring_delay_ms',
      expect.objectContaining({
        scope_type: 'tenant',
        tenant_id: 't-1',
        value: 5000,
        reason: 'testing',
        expires_at: null,
      }),
    ));
  });

  it('numeric edit at account scope threads scope_type=account and account_id', async () => {
    mocks.getCatalog.mockResolvedValue({
      flags: [numericFlag({ scopes: ['tenant', 'account'] })],
    });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    renderComp();

    // Switch to account scope.
    await waitFor(() => screen.getByRole('combobox'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acc-1' } });
    await waitFor(() => expect(mocks.resolve).toHaveBeenLastCalledWith('t-1', 'acc-1'));

    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/^Value/i), { target: { value: '4000' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'account-scoped test' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      'prewarm_ring_delay_ms',
      expect.objectContaining({
        scope_type: 'account',
        tenant_id: 't-1',
        account_id: 'acc-1',
        value: 4000,
      }),
    ));
  });

  it('numeric edit threads a datetime-local expiry through as an ISO string', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    fireEvent.change(screen.getByLabelText(/^Value/i), { target: { value: '2500' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'temporary tweak' } });
    fireEvent.change(screen.getByLabelText(/expires \(optional\)/i), { target: { value: '2027-01-01T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => {
      const call = mocks.put.mock.calls.at(-1)!;
      const body = call[1] as { expires_at: string | null };
      expect(body.expires_at).toBe(new Date('2027-01-01T09:00').toISOString());
    });
  });

  it('Enter in the value input submits the form when valid', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    fireEvent.change(screen.getByLabelText(/^Value/i), { target: { value: '2000' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'via enter' } });
    // Submitting the form dispatches whether we press enter or click — both flow through onSubmit.
    // Assert submit works by firing a form submit rather than a synthetic keydown (jsdom quirks).
    const form = screen.getByLabelText(/^Value/i).closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      'prewarm_ring_delay_ms', expect.objectContaining({ value: 2000, reason: 'via enter' }),
    ));
  });

  it('cancel closes the dialog without writing', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    fireEvent.change(screen.getByLabelText(/^Value/i), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /save override/i })).toBeNull());
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('whitespace-only reason keeps Save disabled', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    fireEvent.change(screen.getByLabelText(/^Value/i), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: '   ' } });
    const save = screen.getByRole('button', { name: /save override/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('decimal / scientific / hex values are rejected with a whole-number error', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    const valueInput = screen.getByLabelText(/^Value/i) as HTMLInputElement;
    const save = screen.getByRole('button', { name: /save override/i });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'r' } });

    // Decimal
    fireEvent.change(valueInput, { target: { value: '2500.5' } });
    expect(screen.getByText(/whole number/i)).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Scientific notation
    fireEvent.change(valueInput, { target: { value: '1e3' } });
    expect(screen.getByText(/whole number/i)).toBeTruthy();

    // Hex
    fireEvent.change(valueInput, { target: { value: '0x10' } });
    expect(screen.getByText(/whole number/i)).toBeTruthy();
  });

  it('boundary values 0 and 30000 are accepted; -1 and 30001 rejected', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    const valueInput = screen.getByLabelText(/^Value/i) as HTMLInputElement;
    const save = screen.getByRole('button', { name: /save override/i });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'boundary' } });

    fireEvent.change(valueInput, { target: { value: '0' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(valueInput, { target: { value: '30000' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(valueInput, { target: { value: '-1' } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(valueInput, { target: { value: '30001' } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces a PUT failure from the numeric dialog', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({ effective: 3000, source: 'default' }));
    mocks.put.mockRejectedValueOnce(new Error('write failed'));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    fireEvent.change(screen.getByLabelText(/^Value/i), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(screen.getByText(/write failed/i)).toBeTruthy());
  });

  it('the numeric cell prefills the dialog with the override value (not just the registry default)', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({
      effective: 5000, source: 'tenant', overrides: [numericOverride({ value: 5000 })],
    }));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    const valueInput = screen.getByLabelText(/^Value/i) as HTMLInputElement;
    expect(valueInput.value).toBe('5000');
  });

  it('the numeric cell shows a "tenant override" chip when the value came from a tenant override', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({
      effective: 5000, source: 'tenant', overrides: [numericOverride({ value: 5000 })],
    }));
    renderComp();
    await waitFor(() => screen.getByText('Pre-warm ring delay (ms)'));
    // "tenant override" is the source-chip's exact copy; the scope card's word
    // is "Tenant" (capitalized), so match case-sensitively to avoid ambiguity.
    expect(screen.getByText('tenant override')).toBeTruthy();
    expect(screen.queryByText(/registry default/i)).toBeNull();
  });

  it('the reset button shows a confirm gate when clearing would change the effective value', async () => {
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({
      effective: 5000, source: 'tenant', overrides: [numericOverride({ value: 5000 })],
    }));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /^Reset$/ }));

    // Confirm dialog appears. DELETE has not been called yet.
    await waitFor(() => screen.getByText(/Reset Pre-warm ring delay/i));
    expect(mocks.del).not.toHaveBeenCalled();

    // Body copy discloses current + fallback values so operators know the blast radius.
    expect(screen.getByText(/currently 5000/)).toBeTruthy();
    expect(screen.getByText(/revert it to 3000/)).toBeTruthy();

    // Confirm the reset — DELETE fires with the scope body.
    // ConfirmDialog uses a "Reset" button in the numeric flow.
    const buttons = screen.getAllByRole('button', { name: /^Reset$/ });
    // The confirm's Reset button is the one inside the alertdialog; take the last one.
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith(
      'prewarm_ring_delay_ms',
      { scope_type: 'tenant', tenant_id: 't-1' },
    ));
  });

  it('the reset button skips the confirm gate when the current value already matches the inherited default', async () => {
    // Override exists but matches the inherited/registry default — deleting is a no-op change.
    mocks.getCatalog.mockResolvedValue({ flags: [numericFlag()] });
    mocks.resolve.mockResolvedValue(numericResolve({
      effective: 3000, source: 'tenant', overrides: [numericOverride({ value: 3000 })],
    }));
    renderComp();
    fireEvent.click(await screen.findByRole('button', { name: /^Reset$/ }));

    // No confirm dialog is shown; DELETE fires immediately.
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith(
      'prewarm_ring_delay_ms',
      { scope_type: 'tenant', tenant_id: 't-1' },
    ));
    expect(screen.queryByText(/Reset Pre-warm ring delay/i)).toBeNull();
  });
});

describe('TenantFeatureFlags — scope revert', () => {
  it('clearing the account select returns to tenant scope (resolve without account id)', async () => {
    mocks.resolve.mockResolvedValue(makeResolve(false, 'default'));
    renderComp();
    await waitFor(() => screen.getByRole('combobox'));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acc-1' } });
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith('t-1', 'acc-1'));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await waitFor(() => expect(mocks.resolve.mock.calls.at(-1)).toEqual(['t-1', undefined]));
  });
});

// ── Defect 1: the boolean tri-state needs the numeric cell's scope gate here
// too. `prewarm_enabled` is `scopes: ['tenant']` in the server's registry, so at
// ACCOUNT scope the tri-state offered a write that always 422s.
describe('TenantFeatureFlags — boolean scope gating', () => {
  const PREWARM_CATALOG: FeatureFlagCatalogResponse = {
    flags: [{
      key: 'prewarm_enabled', type: 'boolean', default: true, env_default: true,
      scopes: ['tenant'], client_exposed: false, owner: 'voice',
      description: 'Pre-warm the AI pipeline during ringing (per-tenant override)',
      global_override: null,
    }],
  };

  const prewarmResolve = (accountId: string | null): FeatureFlagResolveResponse => ({
    tenant_id: 't-1',
    account_id: accountId,
    effective: { prewarm_enabled: true },
    source: { prewarm_enabled: 'env' },
    defaults: { prewarm_enabled: true },
    overrides: [],
  });

  it('keeps the tri-state at tenant scope, which the flag does declare', async () => {
    mocks.getCatalog.mockResolvedValue(PREWARM_CATALOG);
    mocks.resolve.mockResolvedValue(prewarmResolve(null));
    renderComp();

    await waitFor(() => screen.getByRole('radio', { name: 'On' }));
    expect(screen.queryByText(/not editable at this scope/i)).toBeNull();
  });

  it('hides the tri-state at account scope, mirroring the numeric cell', async () => {
    mocks.getCatalog.mockResolvedValue(PREWARM_CATALOG);
    mocks.resolve.mockResolvedValue(prewarmResolve(null));
    renderComp();
    await waitFor(() => screen.getByRole('radio', { name: 'On' }));

    mocks.resolve.mockResolvedValue(prewarmResolve('acc-1'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acc-1' } });
    await waitFor(() => expect(mocks.resolve).toHaveBeenLastCalledWith('t-1', 'acc-1'));

    await waitFor(() => expect(screen.getByText(/not editable at this scope/i)).toBeTruthy());
    expect(screen.queryByRole('radio', { name: 'On' })).toBeNull();
    // The effective value stays visible — the account still inherits it.
    expect(screen.getByText('On')).toBeTruthy();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

// Bot transcripts in Loki. Tenant/account scopes only,
// with the server's `policy` driving the warning — nothing keyed on the flag here.
describe('TenantFeatureFlags — ai_turn_transcript_logging (policy flag)', () => {
  const WARNING = "Writes the bot's spoken transcript into server logs (Loki). Personal data — enable for test accounts only, and turn it off when done.";
  const TRANSCRIPT_FLAG = {
    key: 'ai_turn_transcript_logging', type: 'boolean' as const, default: false, env_default: false,
    scopes: ['tenant' as const, 'account' as const], client_exposed: false, owner: 'voice',
    description: 'Add the bot turn transcript text to the per-turn AI summary log line',
    global_override: null,
    policy: { warning: WARNING, bulk_allowed: false, reason_required_to_enable: true },
  };
  const resolveFor = (
    effective: boolean,
    source: FlagResolutionSource,
    overrides: FeatureFlagResolveResponse['overrides'] = [],
    accountId: string | null = null,
  ): FeatureFlagResolveResponse => ({
    tenant_id: 't-1', account_id: accountId,
    effective: { ai_turn_transcript_logging: effective },
    source: { ai_turn_transcript_logging: source },
    defaults: { ai_turn_transcript_logging: false },
    overrides,
  });
  const override = (scope: 'tenant' | 'account', value: boolean): FeatureFlagResolveResponse['overrides'][number] => ({
    id: 'o-t', flag_key: 'ai_turn_transcript_logging', scope_type: scope, tenant_id: 't-1',
    account_id: scope === 'account' ? 'acc-1' : null, value, reason: 'debug', expires_at: null,
    updated_by: 'sa-1', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  });

  beforeEach(() => {
    mocks.getCatalog.mockResolvedValue({ flags: [TRANSCRIPT_FLAG] });
  });

  it('shows the personal-data warning next to the toggle', async () => {
    mocks.resolve.mockResolvedValue(resolveFor(false, 'default'));
    renderComp();
    await waitFor(() => expect(screen.getByRole('note').textContent).toContain('Personal data'));
  });

  it('enabling for the tenant shows the warning in the reason dialog and writes a tenant override with the reason', async () => {
    mocks.resolve.mockResolvedValue(resolveFor(false, 'default'));
    renderComp();
    await waitFor(() => screen.getByRole('radio', { name: 'On' }));
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));

    const reason = await screen.findByLabelText(/reason \(required\)/i);
    // Table warning + dialog warning.
    expect(screen.getAllByRole('note')).toHaveLength(2);
    // Reason is required: Save stays disabled until it is filled.
    expect((screen.getByRole('button', { name: /save override/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: 'debugging call 42 on test tenant' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('ai_turn_transcript_logging', expect.objectContaining({
      scope_type: 'tenant', tenant_id: 't-1', value: true, reason: 'debugging call 42 on test tenant',
    })));
  });

  it('enabling for one account writes an account override', async () => {
    mocks.resolve.mockResolvedValue(resolveFor(false, 'default'));
    renderComp();
    await waitFor(() => screen.getByRole('combobox'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acc-1' } });
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith('t-1', 'acc-1'));

    fireEvent.click(await screen.findByRole('radio', { name: 'On' }));
    fireEvent.change(await screen.findByLabelText(/reason \(required\)/i), { target: { value: 'repro' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('ai_turn_transcript_logging', expect.objectContaining({
      scope_type: 'account', tenant_id: 't-1', account_id: 'acc-1', value: true, reason: 'repro',
    })));
  });

  it('turning it off goes straight through — no "hides it from them" confirm, no warning in the dialog', async () => {
    mocks.resolve.mockResolvedValue(resolveFor(true, 'tenant', [override('tenant', true)]));
    renderComp();
    await waitFor(() => screen.getByRole('radio', { name: 'Inherit' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Inherit' }));

    expect(screen.queryByText(/is currently available to/i)).toBeNull();
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith(
      'ai_turn_transcript_logging', { scope_type: 'tenant', tenant_id: 't-1' },
    ));
  });

  it('an explicit Off opens the reason dialog without the enable warning', async () => {
    mocks.resolve.mockResolvedValue(resolveFor(true, 'tenant', [override('tenant', true)]));
    renderComp();
    await waitFor(() => screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    await screen.findByLabelText(/reason \(required\)/i);
    expect(screen.getAllByRole('note')).toHaveLength(1);
  });

  // Clearing the Off that excludes one account from a test tenant's logging is
  // an ENABLE in effect, but a DELETE on the wire — no reason, no warning.
  describe('Inherit at account scope that would turn it ON', () => {
    const accountExcluded = (_t: string, accountId?: string) => Promise.resolve(accountId
      ? resolveFor(false, 'account', [override('tenant', true), override('account', false)], accountId)
      : resolveFor(true, 'tenant', [override('tenant', true), override('account', false)]));

    async function toAccount() {
      mocks.resolve.mockImplementation(accountExcluded);
      renderComp();
      await waitFor(() => screen.getByRole('combobox'));
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acc-1' } });
      await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith('t-1', 'acc-1'));
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true'));
    }

    it('choosing Inherit asks first, with the warning, and writes nothing until confirmed', async () => {
      await toAccount();
      fireEvent.click(screen.getByRole('radio', { name: /Inherit/ }));
      const body = await screen.findByText(/turns AI Turn Transcript Logging ON for it/);
      expect(body.textContent).toContain('Personal data');
      expect(mocks.del).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /reset and turn on/i }));
      await waitFor(() => expect(mocks.del).toHaveBeenCalledWith(
        'ai_turn_transcript_logging', { scope_type: 'account', tenant_id: 't-1', account_id: 'acc-1' },
      ));
    });

    it('the reset button goes through the same confirm, and Cancel aborts', async () => {
      await toAccount();
      fireEvent.click(screen.getByRole('button', { name: /reset to inherited/i }));
      await waitFor(() => screen.getByRole('button', { name: /reset and turn on/i }));
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      await waitFor(() => expect(screen.queryByRole('button', { name: /reset and turn on/i })).toBeNull());
      expect(mocks.del).not.toHaveBeenCalled();
    });

    it('no confirm when the account override is already On — resetting keeps it on', async () => {
      mocks.resolve.mockImplementation((_t: string, accountId?: string) => Promise.resolve(accountId
        ? resolveFor(true, 'account', [override('tenant', true), override('account', true)], accountId)
        : resolveFor(true, 'tenant', [override('tenant', true), override('account', true)])));
      renderComp();
      await waitFor(() => screen.getByRole('combobox'));
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acc-1' } });
      await waitFor(() => expect(screen.getByRole('radio', { name: 'On' }).getAttribute('aria-checked')).toBe('true'));
      fireEvent.click(screen.getByRole('button', { name: /reset to inherited/i }));
      await waitFor(() => expect(mocks.del).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('button', { name: /reset and turn on/i })).toBeNull();
    });

    it('no confirm when the tenant is Off — resetting the account keeps it off', async () => {
      mocks.resolve.mockImplementation((_t: string, accountId?: string) => Promise.resolve(
        resolveFor(false, accountId ? 'account' : 'default', [override('account', false)], accountId ?? null),
      ));
      renderComp();
      await waitFor(() => screen.getByRole('combobox'));
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acc-1' } });
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true'));
      fireEvent.click(screen.getByRole('radio', { name: /Inherit/ }));
      await waitFor(() => expect(mocks.del).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('button', { name: /reset and turn on/i })).toBeNull();
    });
  });

  it('the reason input is described by the warning for screen readers', async () => {
    mocks.resolve.mockResolvedValue(resolveFor(false, 'default'));
    renderComp();
    fireEvent.click(await screen.findByRole('radio', { name: 'On' }));
    const input = await screen.findByLabelText(/reason \(required\)/i);
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain('Personal data');
  });

  it('at account scope the effective value inherits the tenant override', async () => {
    mocks.resolve.mockImplementation(async (_t: string, accountId?: string) => accountId
      ? resolveFor(true, 'tenant', [override('tenant', true)], accountId)
      : resolveFor(true, 'tenant', [override('tenant', true)]));
    renderComp();
    await waitFor(() => screen.getByRole('combobox'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acc-1' } });
    await waitFor(() => expect(screen.getByText(/from tenant/i)).toBeTruthy());
    expect(screen.getByRole('radio', { name: /Inherit/ }).getAttribute('aria-checked')).toBe('true');
  });
});
