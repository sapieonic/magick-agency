import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { FeatureFlagCatalogResponse, FeatureFlagCatalogEntry } from '@magick-agency/contracts/api/platform/super-admin';

const mocks = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  bulk: vi.fn(),
}));

vi.mock('../../api/super-admin', () => ({
  getFeatureFlagCatalog: mocks.getCatalog,
  putFeatureFlagOverride: mocks.put,
  deleteFeatureFlagOverride: mocks.del,
  bulkFeatureFlagOverride: mocks.bulk,
}));

import SAFeatureFlagsPage from '../../pages/super-admin/SAFeatureFlagsPage';

/**
 * A catalog entry shaped the way the server actually emits one.
 *
 * `env_default` is `resolveEnvDefault(f)` server-side, which falls back to the
 * registry `default` when the flag's env var is unset — and no flag has a null
 * default. So `env_default` is NEVER null on the wire, and a fixture that sets
 * it to null tests a response the server cannot produce. Keep it populated (mirror
 * `default` for the env-unset case).
 */
function flag(overrides: Partial<FeatureFlagCatalogEntry> = {}): FeatureFlagCatalogEntry {
  return {
    key: 'agency_dialer_enabled', type: 'boolean', default: false, env_default: false,
    scopes: ['global', 'tenant'], client_exposed: true, owner: 'messaging',
    description: 'Agency dialer', global_override: null,
    ...overrides,
  };
}

function catalog(...flags: FeatureFlagCatalogEntry[]): FeatureFlagCatalogResponse {
  return { flags };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.put.mockResolvedValue({});
  mocks.del.mockResolvedValue({});
  mocks.bulk.mockResolvedValue({ applied: [], failed: [] });
});
afterEach(() => cleanup());

describe('SAFeatureFlagsPage — global default editing', () => {
  it('enabling a flag globally writes a global-scope override with a reason', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag()));
    render(<SAFeatureFlagsPage />);

    await waitFor(() => screen.getByRole('radio', { name: 'On' }));
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));

    // Reason dialog opens (no confirm — flag is currently off).
    await waitFor(() => screen.getByLabelText(/reason \(required\)/i));
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'GA launch' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      expect.objectContaining({ scope_type: 'global', value: true, reason: 'GA launch' }),
    ));
  });

  it('turning a globally-on flag off routes through a platform-wide confirm gate', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({ global_override: true })));
    render(<SAFeatureFlagsPage />);

    await waitFor(() => screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));

    // Confirm first; nothing written yet.
    await waitFor(() => expect(screen.getByText(/removes it platform-wide/i)).toBeTruthy());
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('confirming the platform-wide turn-off writes value:false with a reason', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({ global_override: true })));
    render(<SAFeatureFlagsPage />);

    await waitFor(() => screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() => screen.getByRole('button', { name: /turn off/i }));
    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));

    await waitFor(() => screen.getByLabelText(/reason \(required\)/i));
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'sunset' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      expect.objectContaining({ scope_type: 'global', value: false, reason: 'sunset' }),
    ));
  });

  it('passes an ISO expiry when one is set', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag()));
    render(<SAFeatureFlagsPage />);

    await waitFor(() => screen.getByRole('radio', { name: 'On' }));
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    await waitFor(() => screen.getByLabelText(/reason \(required\)/i));
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'temp' } });
    fireEvent.change(screen.getByLabelText(/expires \(optional\)/i), { target: { value: '2026-12-31T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      expect.objectContaining({ expires_at: new Date('2026-12-31T10:00').toISOString() }),
    ));
  });

  it('renders an error when the catalog fails to load', async () => {
    mocks.getCatalog.mockRejectedValue(new Error('boom'));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => expect(screen.getByText(/boom/i)).toBeTruthy());
  });

  it('surfaces a failure when saving the global default', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag()));
    mocks.put.mockRejectedValue(new Error('save failed'));
    render(<SAFeatureFlagsPage />);

    await waitFor(() => screen.getByRole('radio', { name: 'On' }));
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    await waitFor(() => screen.getByLabelText(/reason \(required\)/i));
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    await waitFor(() => expect(screen.getByText(/save failed/i)).toBeTruthy());
  });

  it('reverting to Inherit deletes the global override', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({ global_override: false })));
    render(<SAFeatureFlagsPage />);

    // The Inherit radio's accessible name includes its attribution sub-line.
    await waitFor(() => screen.getByRole('radio', { name: /inherit/i }));
    fireEvent.click(screen.getByRole('radio', { name: /inherit/i }));

    // global_override false → not effectively on → no confirm, deletes directly.
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      { scope_type: 'global' },
    ));
  });
});

describe('SAFeatureFlagsPage — filters & rollout', () => {
  it('search narrows the catalog', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(
      flag(),
      flag({ key: 'new_dialer', owner: 'dialer', description: 'Next-gen dialer', client_exposed: false }),
    ));
    render(<SAFeatureFlagsPage />);

    await waitFor(() => screen.getByText('New Dialer'));
    fireEvent.change(screen.getByLabelText(/search feature flags/i), { target: { value: 'next-gen' } });

    expect(screen.getByText('New Dialer')).toBeTruthy();
    expect(screen.queryByText('Agency Dialer Enabled')).toBeNull();
  });

  it('Roll out… opens the relocated bulk modal and applies across tenants', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag()));
    render(<SAFeatureFlagsPage />);

    await waitFor(() => screen.getByText('Agency Dialer Enabled'));
    // Header action launches the bulk modal.
    fireEvent.click(screen.getAllByRole('button', { name: /roll out/i })[0]!);

    await waitFor(() => screen.getByText(/roll out across tenants/i));
    fireEvent.change(screen.getByLabelText(/tenant ids/i), { target: { value: 't1, t2' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'gradual rollout' } });
    fireEvent.click(screen.getByRole('button', { name: /enable for 2 tenants/i }));

    await waitFor(() => expect(mocks.bulk).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      { tenant_ids: ['t1', 't2'], value: true, reason: 'gradual rollout' },
    ));
  });

  async function openBulk() {
    mocks.getCatalog.mockResolvedValue(catalog(flag()));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Agency Dialer Enabled'));
    fireEvent.click(screen.getAllByRole('button', { name: /roll out/i })[0]!);
    await waitFor(() => screen.getByText(/roll out across tenants/i));
  }

  it('required reason blocks bulk submit until filled', async () => {
    await openBulk();
    fireEvent.change(screen.getByLabelText(/tenant ids/i), { target: { value: 'a b' } });

    const submit = screen.getByRole('button', { name: /enable for 2 tenants/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'rollout' } });
    expect(submit.disabled).toBe(false);
  });

  it('the Disable segment restates the button and writes value:false', async () => {
    await openBulk();
    fireEvent.change(screen.getByLabelText(/tenant ids/i), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('radio', { name: /disable \(off\)/i }));
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'pull back' } });
    fireEvent.click(screen.getByRole('button', { name: /disable for 1 tenant/i }));

    await waitFor(() => expect(mocks.bulk).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      { tenant_ids: ['a'], value: false, reason: 'pull back' },
    ));
  });

  it('de-duplicates tenant IDs before applying', async () => {
    await openBulk();
    fireEvent.change(screen.getByLabelText(/tenant ids/i), { target: { value: 't1, t1\nt2' } });
    await waitFor(() => screen.getByText('2 tenants'));
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /enable for 2 tenants/i }));

    await waitFor(() => expect(mocks.bulk).toHaveBeenCalledWith(
      'agency_dialer_enabled',
      expect.objectContaining({ tenant_ids: ['t1', 't2'] }),
    ));
  });

  it('surfaces per-tenant failures from a bulk apply', async () => {
    mocks.bulk.mockResolvedValue({ applied: ['t1'], failed: [{ tenant_id: 't2', error: 'not found' }] });
    await openBulk();
    fireEvent.change(screen.getByLabelText(/tenant ids/i), { target: { value: 't1 t2' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /enable for 2 tenants/i }));

    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy());
    expect(screen.getByText('t2')).toBeTruthy();
  });

  it('disables the header Roll out button when no flag is boolean + tenant-scopable', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(
      flag({ key: 'kill_switch', scopes: ['global'] }),         // not tenant-scopable
      flag({ key: 'max_threads', type: 'number' }),            // not boolean
    ));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Kill Switch'));
    expect((screen.getByRole('button', { name: /roll out/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('SAFeatureFlagsPage — filters & empty states', () => {
  const FLAGS = [
    flag(),
    flag({ key: 'new_dialer', owner: 'dialer', type: 'boolean', client_exposed: false, description: 'dialer' }),
    flag({ key: 'max_threads', owner: 'dialer', type: 'number', client_exposed: false, description: 'threads' }),
  ];

  it('filters by owner', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(...FLAGS));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Agency Dialer Enabled'));
    fireEvent.change(screen.getByLabelText(/filter by owner/i), { target: { value: 'dialer' } });
    expect(screen.queryByText('Agency Dialer Enabled')).toBeNull();
    expect(screen.getByText('New Dialer')).toBeTruthy();
    expect(screen.getByText('Max Threads')).toBeTruthy();
  });

  it('filters by type', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(...FLAGS));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Agency Dialer Enabled'));
    fireEvent.change(screen.getByLabelText(/filter by type/i), { target: { value: 'number' } });
    expect(screen.getByText('Max Threads')).toBeTruthy();
    expect(screen.queryByText('Agency Dialer Enabled')).toBeNull();
    expect(screen.queryByText('New Dialer')).toBeNull();
  });

  it('filters to client-exposed only', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(...FLAGS));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Agency Dialer Enabled'));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('Agency Dialer Enabled')).toBeTruthy(); // exposed
    expect(screen.queryByText('New Dialer')).toBeNull();        // not exposed
  });

  it('shows the registered-empty state when the catalog is empty', async () => {
    mocks.getCatalog.mockResolvedValue(catalog());
    render(<SAFeatureFlagsPage />);
    await waitFor(() => expect(screen.getByText(/no feature flags registered/i)).toBeTruthy());
  });

  it('shows the no-match state when filters exclude everything', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag()));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Agency Dialer Enabled'));
    fireEvent.change(screen.getByLabelText(/search feature flags/i), { target: { value: 'zzz-nope' } });
    expect(screen.getByText(/no flags match your filters/i)).toBeTruthy();
  });
});

describe('SAFeatureFlagsPage — non-boolean & attribution', () => {
  it('renders numeric flags with an inline value + Edit button (not "Set via API")', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({
      key: 'prewarm_ring_delay_ms', type: 'number', default: 3000, env_default: 3000, global_override: null,
      scopes: ['tenant'], owner: 'voice', description: '0..30000, per-tenant',
    })));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Pre-warm ring delay (ms)'));
    // "3000" appears in exactly two places: numeric cell + "Inherited from" column.
    expect(screen.getAllByText('3000')).toHaveLength(2);
    expect(screen.queryByText(/set via api/i)).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    // prewarm_ring_delay_ms is tenant-only — global-scope Edit is hidden so a
    // super-admin can't accidentally 422 by writing at the wrong scope.
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.getByText(/not editable at this scope/i)).toBeTruthy();
  });

  it('renders Edit for a numeric flag whose scopes include global', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({
      key: 'webrtc_max_duration_seconds', type: 'number', default: 1800, env_default: 1800,
      scopes: ['global', 'tenant', 'account'], global_override: null, owner: 'voice',
      description: 'Max duration',
    })));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('WebRTC max call duration (seconds)'));
    expect(screen.getByRole('button', { name: /edit/i })).toBeTruthy();
    expect(screen.queryByText(/not editable at this scope/i)).toBeNull();
  });

  it('opens the number dialog, validates bounds, and PUTs a global override', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({
      key: 'webrtc_max_duration_seconds', type: 'number', default: 1800, env_default: 1800,
      scopes: ['global', 'tenant', 'account'], global_override: null, owner: 'voice',
      description: 'Max duration',
    })));
    render(<SAFeatureFlagsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    const valueInput = screen.getByLabelText(/^Value/i) as HTMLInputElement;
    expect(valueInput.value).toBe('1800'); // prefilled with the current effective value

    const save = screen.getByRole('button', { name: /save override/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Below the min (60) → save stays disabled with an inline error.
    fireEvent.change(valueInput, { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'lowering' } });
    expect(screen.getByText(/must be ≥ 60/i)).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Valid → PUT fires with global scope.
    fireEvent.change(valueInput, { target: { value: '3600' } });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      'webrtc_max_duration_seconds',
      expect.objectContaining({
        scope_type: 'global',
        value: 3600,
        reason: 'lowering',
        expires_at: null,
      }),
    ));
  });

  it('cancel closes the number dialog without writing', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({
      key: 'webrtc_max_duration_seconds', type: 'number', default: 1800, env_default: 1800,
      scopes: ['global', 'tenant', 'account'], global_override: null, owner: 'voice', description: 'Max',
    })));
    render(<SAFeatureFlagsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    fireEvent.change(screen.getByLabelText(/^Value/i), { target: { value: '3600' } });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /save override/i })).toBeNull());
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('reset on a numeric flag confirms first before DELETE when the effective value would change', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({
      key: 'webrtc_max_duration_seconds', type: 'number', default: 1800, env_default: 1800,
      scopes: ['global', 'tenant', 'account'], global_override: 3600, owner: 'voice', description: 'Max',
    })));
    render(<SAFeatureFlagsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^Reset$/ }));

    // ConfirmDialog appears; DELETE has not fired.
    await waitFor(() => screen.getByText(/Reset WebRTC max call duration \(seconds\) globally\?/i));
    expect(mocks.del).not.toHaveBeenCalled();
    expect(screen.getByText(/currently 3600 platform-wide/)).toBeTruthy();
    expect(screen.getByText(/revert it to 1800/)).toBeTruthy();

    // Confirm. The ConfirmDialog exposes a "Reset" confirm button; pick the one inside the dialog.
    const buttons = screen.getAllByRole('button', { name: /^Reset$/ });
    fireEvent.click(buttons[buttons.length - 1]!);

    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith(
      'webrtc_max_duration_seconds',
      { scope_type: 'global' },
    ));
  });

  it('renders string/json (unsupported) flags read-only with a "Set via API" hint', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({ key: 'greeting_style', type: 'string', default: 'friendly', global_override: null })));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Greeting Style'));
    expect(screen.getByText(/set via api/i)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  // ── Defect 2: the page must not claim an env var is configured ───────────
  //
  // The server collapses "env var set" and "env var unset" into a single
  // `env_default` field (`resolveEnvDefault` returns the registry default when
  // the var is unset), so the catalog carries no provenance at all. The old
  // `hasEnvDefault` helper tested `env_default !== null` — dead-true for every
  // flag — and rendered "env: …" on every row. An operator hunting the pre-warm
  // kill switch mid-incident was told AI_PREWARM_ENABLED was set to `true` when
  // it may never have been configured.

  it('reports the inherited default as a value, without claiming where it came from', async () => {
    // env_default (true) differs from the registry default (false) here, and
    // matches it in the test below — the UI must read the same either way.
    mocks.getCatalog.mockResolvedValue(catalog(flag({ default: false, env_default: true })));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Agency Dialer Enabled'));

    expect(screen.queryByText(/^env:/i)).toBeNull();
    expect(screen.queryByText(/^registry:/i)).toBeNull();
    expect(screen.getByText('true')).toBeTruthy();
  });

  it('never names a layer in the Inherit sub-line', async () => {
    // env_default mirroring `default` is exactly what the server emits with the env
    // var unset — and also what it emits with the var set to the same value.
    mocks.getCatalog.mockResolvedValue(catalog(flag({ default: false, env_default: false })));
    render(<SAFeatureFlagsPage />);

    const inherit = await screen.findByRole('radio', { name: /inherit/i });
    expect(inherit.textContent).toContain('Inherited (default: Off)');
    expect(inherit.textContent).not.toMatch(/env/i);
    expect(inherit.textContent).not.toMatch(/registry/i);
  });

  it('does not label a numeric flag\'s inherited value an "env default"', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({
      key: 'webrtc_max_duration_seconds', type: 'number', default: 1800, env_default: 1800,
      scopes: ['global', 'tenant', 'account'], global_override: null, owner: 'voice', description: 'Max',
    })));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('WebRTC max call duration (seconds)'));

    expect(screen.queryByText(/env default/i)).toBeNull();
    // Exact-case: the column header is "Inherited default", the source chip is
    // lower-case — only the chip should match.
    expect(screen.getByText('inherited default')).toBeTruthy();
  });
});

// ── Defect 1: the boolean tri-state needs the same scope gate as the numeric
// cell. `prewarm_enabled` is the ONLY boolean in the server's registry declared
// `scopes: ['tenant']`, so the global tri-state offered a fleet-wide On/Off for
// the pre-warm kill switch whose every write 422s at the server's scope check.
describe('SAFeatureFlagsPage — boolean scope gating', () => {
  const prewarm = (overrides: Partial<FeatureFlagCatalogEntry> = {}) => flag({
    key: 'prewarm_enabled', type: 'boolean', default: true, env_default: true,
    scopes: ['tenant'], client_exposed: false, owner: 'voice',
    description: 'Pre-warm the AI pipeline during ringing (per-tenant override)',
    ...overrides,
  });

  it('hides the global tri-state for a tenant-only boolean, mirroring the numeric cell', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(prewarm()));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Pre-warm AI pipeline on ringing'));

    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(/not editable at this scope/i)).toBeTruthy();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('still shows the effective state for a boolean it cannot edit globally', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(prewarm()));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByText('Pre-warm AI pipeline on ringing'));
    expect(screen.getByText('On')).toBeTruthy();
  });

  it('keeps the tri-state for a boolean whose scopes include global', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag()));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByRole('radio', { name: 'On' }));
    expect(screen.queryByText(/not editable at this scope/i)).toBeNull();
  });
});

describe('SAFeatureFlagsPage — reset global default', () => {
  it('reverting a globally-on flag to Inherit confirms, then deletes the override', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag({ global_override: true })));
    render(<SAFeatureFlagsPage />);

    await waitFor(() => screen.getByRole('radio', { name: /inherit/i }));
    fireEvent.click(screen.getByRole('radio', { name: /inherit/i }));

    // Dropping a live global default is destructive → confirm first.
    await waitFor(() => screen.getByRole('button', { name: /turn off/i }));
    expect(mocks.del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));

    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('agency_dialer_enabled', { scope_type: 'global' }));
  });
});

// The server's `policy` on a tenant/account-only flag.
describe('SAFeatureFlagsPage — policy flag (ai_turn_transcript_logging)', () => {
  const transcript = flag({
    key: 'ai_turn_transcript_logging', scopes: ['tenant', 'account'], client_exposed: false, owner: 'voice',
    description: 'bot transcripts in logs',
    policy: { warning: 'Personal data — test accounts only.', bulk_allowed: false, reason_required_to_enable: true },
  });

  it('offers no global toggle, shows the warning, and no per-row Roll out', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(transcript));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => expect(screen.getByText(/not editable at this scope/i)).toBeTruthy());
    expect(screen.queryByRole('radio', { name: 'On' })).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('Personal data');
    // Only the header button says "Roll out…", and with nothing bulkable it is disabled.
    const rollOut = screen.getAllByRole('button', { name: /roll out/i });
    expect(rollOut).toHaveLength(1);
    expect((rollOut[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('other flags keep their global toggle and Roll out, with no warning', async () => {
    mocks.getCatalog.mockResolvedValue(catalog(flag(), transcript));
    render(<SAFeatureFlagsPage />);
    await waitFor(() => screen.getByRole('radio', { name: 'On' }));
    expect(screen.getAllByRole('note')).toHaveLength(1);
    // Header + agency_dialer_enabled row.
    expect(screen.getAllByRole('button', { name: /roll out/i })).toHaveLength(2);
  });
});
