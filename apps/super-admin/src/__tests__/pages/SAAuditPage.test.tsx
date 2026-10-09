import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  useAudit: vi.fn(),
}));

vi.mock('../../hooks/useSuperAdminAudit', () => ({
  useSuperAdminAudit: mocks.useAudit,
}));

import SAAuditPage from '../../pages/super-admin/SAAuditPage';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAudit.mockReturnValue({
    entries: [],
    total: 0,
    actions: [],
    loading: false,
    error: null,
    reload: vi.fn(),
  });
});
afterEach(() => cleanup());

describe('SAAuditPage date range', () => {
  it('clears To when From is moved past it', () => {
    render(<SAAuditPage />);
    const from = screen.getByLabelText('From date') as HTMLInputElement;
    const to = screen.getByLabelText('To date') as HTMLInputElement;
    fireEvent.change(to, { target: { value: '2026-08-01' } });
    expect(to.value).toBe('2026-08-01');
    fireEvent.change(from, { target: { value: '2026-08-10' } });
    expect(from.value).toBe('2026-08-10');
    expect(to.value).toBe('');
  });
});
