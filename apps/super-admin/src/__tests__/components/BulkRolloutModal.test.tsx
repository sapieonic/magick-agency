import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type { FeatureFlagCatalogEntry } from '@magick-agency/contracts/api/platform/super-admin';

const mocks = vi.hoisted(() => ({ bulk: vi.fn() }));
vi.mock('../../api/super-admin', () => ({ bulkFeatureFlagOverride: mocks.bulk }));

import { BulkRolloutModal } from '../../components/super-admin/feature-flags/BulkRolloutModal';

function entry(over: Partial<FeatureFlagCatalogEntry> = {}): FeatureFlagCatalogEntry {
  return {
    key: 'agency_dialer_enabled', type: 'boolean', default: false, env_default: false,
    scopes: ['global', 'tenant'], client_exposed: true, owner: 'messaging',
    description: '', global_override: null, ...over,
  };
}

const WA = entry();
const ND = entry({ key: 'new_dialer', owner: 'dialer' });
const NUM = entry({ key: 'max_threads', type: 'number' });           // non-boolean → excluded
const GLOBAL_ONLY = entry({ key: 'kill_switch', scopes: ['global'] }); // not tenant → excluded
const ALL = [WA, ND, NUM, GLOBAL_ONLY];

function renderModal(over: Partial<Parameters<typeof BulkRolloutModal>[0]> = {}) {
  const onClose = over.onClose ?? vi.fn();
  const onApplied = over.onApplied ?? vi.fn();
  render(
    <BulkRolloutModal flags={over.flags ?? ALL} initialFlag={over.initialFlag ?? WA} onClose={onClose} onApplied={onApplied} />,
  );
  return { onClose, onApplied };
}

const tenantsField = () => screen.getByLabelText(/tenant ids/i);
const reasonField = () => screen.getByLabelText(/reason \(required\)/i);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bulk.mockResolvedValue({ applied: [], failed: [] });
});
afterEach(() => cleanup());

describe('BulkRolloutModal — flag candidates', () => {
  it('only offers boolean + tenant-scopable flags in the dropdown', () => {
    renderModal();
    const select = screen.getByLabelText('Flag') as HTMLSelectElement;
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['agency_dialer_enabled', 'new_dialer']);
  });
});

describe('BulkRolloutModal — policy-barred flags', () => {
  const TRANSCRIPT = entry({
    key: 'ai_turn_transcript_logging', scopes: ['tenant', 'account'],
    policy: { warning: 'w', bulk_allowed: false, reason_required_to_enable: true },
  });

  it('never offers a flag whose policy forbids bulk', () => {
    renderModal({ flags: [...ALL, TRANSCRIPT] });
    const select = screen.getByLabelText('Flag') as HTMLSelectElement;
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['agency_dialer_enabled', 'new_dialer']);
  });

  it('a barred initialFlag falls back to an allowed candidate rather than being submitted', async () => {
    renderModal({ flags: [WA, TRANSCRIPT], initialFlag: TRANSCRIPT });
    fireEvent.change(tenantsField(), { target: { value: 't1' } });
    fireEvent.change(reasonField(), { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: /enable for 1 tenant/i }));
    await waitFor(() => expect(mocks.bulk).toHaveBeenCalledWith('agency_dialer_enabled', expect.anything()));
  });

  it('with only barred flags, apply stays disabled', () => {
    renderModal({ flags: [TRANSCRIPT], initialFlag: TRANSCRIPT });
    fireEvent.change(tenantsField(), { target: { value: 't1' } });
    fireEvent.change(reasonField(), { target: { value: 'r' } });
    expect((screen.getByRole('button', { name: /enable for 1 tenant/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('BulkRolloutModal — parsing & counter', () => {
  it('counts and de-duplicates parsed tenant IDs', async () => {
    renderModal();
    fireEvent.change(tenantsField(), { target: { value: 't1, t1\n t2 ,,t2' } });
    await waitFor(() => expect(screen.getByText('2 tenants')).toBeTruthy());
  });

  it('uses the singular noun for a single tenant', async () => {
    renderModal();
    fireEvent.change(tenantsField(), { target: { value: 'only-one' } });
    await waitFor(() => expect(screen.getByText('1 tenant')).toBeTruthy());
  });
});

describe('BulkRolloutModal — submit gating', () => {
  it('blocks submit until both tenants and a reason are present', () => {
    renderModal();
    const submit = () => screen.getByRole('button', { name: /enable for/i }) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    fireEvent.change(tenantsField(), { target: { value: 'a b' } });
    expect(submit().disabled).toBe(true); // reason still empty
    fireEvent.change(reasonField(), { target: { value: 'rollout' } });
    expect(submit().disabled).toBe(false);
  });
});

describe('BulkRolloutModal — apply', () => {
  it('enables across the de-duplicated tenants with value:true', async () => {
    const { onApplied } = renderModal();
    fireEvent.change(tenantsField(), { target: { value: 't1, t1, t2' } });
    fireEvent.change(reasonField(), { target: { value: 'go' } });
    fireEvent.click(screen.getByRole('button', { name: /enable for 2 tenants/i }));
    await waitFor(() => expect(mocks.bulk).toHaveBeenCalledWith('agency_dialer_enabled', {
      tenant_ids: ['t1', 't2'], value: true, reason: 'go',
    }));
    expect(onApplied).toHaveBeenCalled();
  });

  it('disables (value:false) and restates the button when the Disable segment is chosen', async () => {
    renderModal();
    fireEvent.change(tenantsField(), { target: { value: 'a' } });
    fireEvent.change(reasonField(), { target: { value: 'pull' } });
    fireEvent.click(screen.getByRole('radio', { name: /disable \(off\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /disable for 1 tenant/i }));
    await waitFor(() => expect(mocks.bulk).toHaveBeenCalledWith('agency_dialer_enabled',
      expect.objectContaining({ value: false })));
  });

  it('applies to the flag chosen in the dropdown', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Flag'), { target: { value: 'new_dialer' } });
    fireEvent.change(tenantsField(), { target: { value: 'x' } });
    fireEvent.change(reasonField(), { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: /enable for 1 tenant/i }));
    await waitFor(() => expect(mocks.bulk).toHaveBeenCalledWith('new_dialer', expect.anything()));
  });

  it('lists per-tenant failures returned by the API', async () => {
    mocks.bulk.mockResolvedValue({ applied: ['t1'], failed: [{ tenant_id: 't2', error: 'not found' }] });
    renderModal();
    fireEvent.change(tenantsField(), { target: { value: 't1 t2' } });
    fireEvent.change(reasonField(), { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: /enable for 2 tenants/i }));
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy());
    expect(screen.getByText('t2')).toBeTruthy();
  });

  it('surfaces a thrown error', async () => {
    mocks.bulk.mockRejectedValue(new Error('server exploded'));
    renderModal();
    fireEvent.change(tenantsField(), { target: { value: 'a' } });
    fireEvent.change(reasonField(), { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: /enable for 1 tenant/i }));
    await waitFor(() => expect(screen.getByText(/server exploded/i)).toBeTruthy());
  });

  it('re-arms the submit only after an edit, preventing a double-apply', async () => {
    renderModal();
    fireEvent.change(tenantsField(), { target: { value: 'a' } });
    fireEvent.change(reasonField(), { target: { value: 'r' } });
    const submit = () => screen.getByRole('button', { name: /for 1 tenant/i }) as HTMLButtonElement;
    fireEvent.click(submit());
    await waitFor(() => expect(mocks.bulk).toHaveBeenCalledTimes(1));
    // After success the button is disabled until something changes.
    await waitFor(() => expect(submit().disabled).toBe(true));
    fireEvent.change(reasonField(), { target: { value: 'r2' } });
    expect(submit().disabled).toBe(false);
  });

  it('Close calls onClose', () => {
    const { onClose } = renderModal();
    // Both the header X and the footer button are named "Close"; either dismisses.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    expect(onClose).toHaveBeenCalled();
  });
});
