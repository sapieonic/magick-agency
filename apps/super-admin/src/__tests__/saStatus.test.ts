import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import {
  saStatusMeta,
  saStatusColor,
  saStatusLabel,
  roleLabel,
} from '../utils/saStatus';
import { Modal } from '../components/common/Modal';

describe('saStatus — saStatusMeta tone mapping', () => {
  it('maps positive statuses', () => {
    for (const s of ['active', 'enabled', 'available', 'assigned', 'connected', 'healthy']) {
      const meta = saStatusMeta(s);
      expect(meta.tone).toBe('positive');
      expect(meta.color).toBe('var(--success)');
    }
  });

  it('maps neutral statuses', () => {
    for (const s of ['inactive', 'disabled', 'unassigned', 'unknown']) {
      const meta = saStatusMeta(s);
      expect(meta.tone).toBe('neutral');
      expect(meta.color).toBe('var(--text-muted)');
    }
  });

  it('maps warning statuses', () => {
    for (const s of ['retired', 'pending', 'reserved', 'provisioning', 'degraded']) {
      const meta = saStatusMeta(s);
      expect(meta.tone).toBe('warning');
      expect(meta.color).toBe('var(--warning)');
    }
  });

  it('maps negative statuses', () => {
    for (const s of ['deleted', 'released', 'suspended', 'blocked', 'failed', 'error']) {
      const meta = saStatusMeta(s);
      expect(meta.tone).toBe('negative');
      expect(meta.color).toBe('var(--danger)');
    }
  });
});

describe('saStatus — saStatusMeta normalization & labels', () => {
  it('title-cases known statuses', () => {
    expect(saStatusMeta('retired').label).toBe('Retired');
    expect(saStatusMeta('active').label).toBe('Active');
  });

  it('normalizes casing, whitespace and underscores', () => {
    expect(saStatusMeta('  ACTIVE  ').tone).toBe('positive');
    expect(saStatusMeta('  ACTIVE  ').label).toBe('Active');
  });

  it('title-cases unknown multi-word statuses and treats them as neutral', () => {
    const meta = saStatusMeta('partially_provisioned');
    expect(meta.label).toBe('Partially Provisioned');
    expect(meta.tone).toBe('neutral');
    expect(meta.color).toBe('var(--text-muted)');
  });

  it('never leaks snake_case for unknown statuses', () => {
    expect(saStatusMeta('some_weird_state').label).not.toContain('_');
  });

  it('returns Unknown / neutral for null, undefined and empty', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const meta = saStatusMeta(raw);
      expect(meta.label).toBe('Unknown');
      expect(meta.tone).toBe('neutral');
      expect(meta.color).toBe('var(--text-muted)');
    }
  });
});

describe('saStatus — convenience helpers', () => {
  it('saStatusColor returns the meta color', () => {
    expect(saStatusColor('active')).toBe('var(--success)');
    expect(saStatusColor('retired')).toBe('var(--warning)');
    expect(saStatusColor('deleted')).toBe('var(--danger)');
    expect(saStatusColor(null)).toBe('var(--text-muted)');
  });

  it('saStatusLabel returns the meta label', () => {
    expect(saStatusLabel('active')).toBe('Active');
    expect(saStatusLabel('unknown_thing')).toBe('Unknown Thing');
    expect(saStatusLabel(undefined)).toBe('Unknown');
  });
});

describe('saStatus — roleLabel', () => {
  it('maps known roles to canonical labels', () => {
    expect(roleLabel('viewer')).toBe('Viewer');
    expect(roleLabel('operator')).toBe('Operator');
    expect(roleLabel('account_admin')).toBe('Account admin');
    expect(roleLabel('tenant_admin')).toBe('Tenant admin');
    expect(roleLabel('tenant_owner')).toBe('Tenant owner');
  });

  it('is case-insensitive for known roles', () => {
    expect(roleLabel('TENANT_OWNER')).toBe('Tenant owner');
  });

  it('title-cases unknown roles with underscores replaced by spaces', () => {
    expect(roleLabel('super_admin')).toBe('Super Admin');
    expect(roleLabel('billing')).toBe('Billing');
  });

  it('returns an em dash for null, undefined and empty', () => {
    expect(roleLabel(null)).toBe('—');
    expect(roleLabel(undefined)).toBe('—');
    expect(roleLabel('')).toBe('—');
    expect(roleLabel('   ')).toBe('—');
  });
});

describe('Modal', () => {
  afterEach(() => cleanup());

  it('renders nothing when closed', () => {
    render(
      createElement(Modal, {
        open: false,
        onClose: vi.fn(),
        title: 'Hidden',
        children: 'body',
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it('renders title, subtitle and children when open', () => {
    render(
      createElement(Modal, {
        open: true,
        onClose: vi.fn(),
        title: 'Edit tenant',
        subtitle: 'Acme Inc.',
        children: 'Modal body content',
      }),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Edit tenant')).toBeTruthy();
    expect(screen.getByText('Acme Inc.')).toBeTruthy();
    expect(screen.getByText('Modal body content')).toBeTruthy();
  });

  it('labels the dialog via aria-labelledby pointing at the title', () => {
    render(
      createElement(Modal, {
        open: true,
        onClose: vi.fn(),
        title: 'Titled',
        children: 'body',
      }),
    );
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Titled');
  });

  it('calls onClose on Escape, via the close button, and on overlay click', () => {
    const onClose = vi.fn();
    render(
      createElement(Modal, { open: true, onClose, title: 'X', children: 'body' }),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    // The overlay carries role="dialog"; the inner dialog stops propagation.
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does not close on overlay click when closeOnOverlayClick is false', () => {
    const onClose = vi.fn();
    render(
      createElement(Modal, {
        open: true,
        onClose,
        title: 'X',
        closeOnOverlayClick: false,
        children: 'body',
      }),
    );
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the footer only when provided', () => {
    const { rerender } = render(
      createElement(Modal, { open: true, onClose: vi.fn(), title: 'X', children: 'body' }),
    );
    expect(screen.queryByText('Save')).toBeNull();
    rerender(
      createElement(Modal, {
        open: true,
        onClose: vi.fn(),
        title: 'X',
        children: 'body',
        footer: createElement('button', { type: 'button' }, 'Save'),
      }),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});
