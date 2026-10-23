import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The super-admin's own release version (`apps/super-admin/package.json`, written by
 * release-please and injected as `__APP_VERSION__` by vite.config.ts) sits at the foot of
 * the sidebar. The test reads that file rather than repeating a number.
 */
vi.mock('../../components/common/Logo', () => ({ Logo: () => <span data-testid="logo" /> }));

import { SuperAdminSidebar } from '../../components/layout/SuperAdminSidebar';

const { version } = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'),
) as { version: string };

describe('SuperAdminSidebar version', () => {
  it("is the super-admin's package.json version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(__APP_VERSION__).toBe(version);
  });

  it('shows at the foot of the sidebar', () => {
    render(<MemoryRouter><SuperAdminSidebar /></MemoryRouter>);
    expect(screen.getByTestId('app-version').textContent).toBe(`v${version}`);
  });
});
