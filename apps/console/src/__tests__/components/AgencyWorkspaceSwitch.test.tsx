import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Role } from '../../types/auth';

/**
 * The sidebar's way into the Agency Dialer — one control, two destinations.
 *
 * Three things have to agree — master's `agency` capability, core's
 * `agency_dialer_enabled` flag, and having any standing in the dialer at all —
 * and each is asserted on its own, because an OR written where an AND was meant
 * passes every test that only ever varies one input at a time.
 *
 * ── What changed, and why the old assertion was hiding a hole ───────────────
 * The gate used to be `agency.supervise`, which floors at `account_admin`. But
 * `agency.station.connect` floors at `agent` (5), so a `viewer` and an `operator`
 * hold every agent permission, take dialer calls, and had NO entry point to the
 * dialer anywhere in the platform — while `AgentHomePage` offered those exact two
 * roles a documented link back OUT of it.
 *
 * So the gate is now the PERSONA and the destination follows it: a supervisor gets
 * `/agency/campaigns`, everyone else with standing gets `/dialer`. Both arms are
 * asserted by href, because the destinations are not interchangeable — a
 * supervisor sent to `/dialer` is bounced straight back by `AgentHomePage`, and an
 * agent-persona user sent to `/agency/campaigns` reads a list floored at
 * `agency.campaigns.read`. Either mix-up produces a control that looks live and
 * cannot work, which is what the sidebar's own comment about a bare `/station`
 * link exists to prevent.
 *
 * Note the old REFUSED cases still passed unchanged after the behaviour flipped:
 * they queried by the supervisor's label, which a `viewer` genuinely does not get.
 * A test that only names one arm cannot see the other appear.
 */

const mocks = vi.hoisted(() => ({
  role: 'tenant_owner' as Role | undefined,
  capabilities: new Set<string>(['agency']),
  flags: new Set<string>(['agency_dialer_enabled']),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: (cap: string) => mocks.capabilities.has(cap) }),
}));

import { Sidebar } from '../../components/layout/Sidebar';

/** The supervisor's arm: a different shell, and the wording says so. */
const SUPERVISOR_LABEL = /switch to magick agency/i;
/** The agent persona's arm: a full-viewport page, so never called a "workspace". */
const AGENT_LABEL = /take dialer calls/i;
/** Either arm, for the gate tests — where the point is that NOTHING renders. */
const EITHER_LABEL = /switch to magick agency|take dialer calls/i;

function renderSidebar(collapsed = false) {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <Sidebar collapsed={collapsed} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.role = 'tenant_owner';
  mocks.capabilities = new Set(['agency']);
  mocks.flags = new Set(['agency_dialer_enabled']);
});

afterEach(cleanup);

describe('agency dialer entry — both entitlements must be on', () => {
  it('renders for a supervisor when capability and flag are both present', () => {
    renderSidebar();

    const link = screen.getByRole('link', { name: SUPERVISOR_LABEL });
    expect(link.getAttribute('href')).toBe('/agency/campaigns');
  });

  it('is hidden when the governance capability is off', () => {
    mocks.capabilities = new Set();

    renderSidebar();

    expect(screen.queryByRole('link', { name: EITHER_LABEL })).toBeNull();
  });

  it('is hidden when the core feature flag is off', () => {
    mocks.flags = new Set();

    renderSidebar();

    expect(screen.queryByRole('link', { name: EITHER_LABEL })).toBeNull();
  });

  it('is hidden for both personas when an entitlement is off', () => {
    /* The gate is above the persona split, so neither arm may leak through it.
       Asserted for the agent persona too — the arm the gate tests above do not
       reach, since a `viewer` never matches the supervisor label either way. */
    mocks.role = 'viewer';
    mocks.capabilities = new Set();

    renderSidebar();

    expect(screen.queryByRole('link', { name: EITHER_LABEL })).toBeNull();
  });
});

describe('agency dialer entry — the destination follows the persona', () => {
  /** Holds `agency.supervise` (floors at `account_admin`) — sent to the workspace. */
  const SUPERVISORS: Role[] = ['account_admin', 'tenant_admin', 'tenant_owner'];
  /** Holds the agent permissions and no supervisory one — sent to the dialer. */
  const AGENT_PERSONA: Role[] = ['agent', 'viewer', 'operator'];

  it.each(SUPERVISORS)('%s is sent to the campaigns workspace', (role) => {
    mocks.role = role;

    renderSidebar();

    const link = screen.getByRole('link', { name: SUPERVISOR_LABEL });
    expect(link.getAttribute('href')).toBe('/agency/campaigns');
    /* And NOT offered the agent arm as well. One control, one destination. */
    expect(screen.queryByRole('link', { name: AGENT_LABEL })).toBeNull();
  });

  it.each(AGENT_PERSONA)('%s is sent to the dialer', (role) => {
    mocks.role = role;

    renderSidebar();

    const link = screen.getByRole('link', { name: AGENT_LABEL });
    expect(link.getAttribute('href')).toBe('/dialer');
    expect(screen.queryByRole('link', { name: SUPERVISOR_LABEL })).toBeNull();
  });

  it('is hidden when the role is unknown', () => {
    /* `agencyPersona(undefined)` is `null` — nobody the dialer has a place for.
       A truthiness check on `role` would pass this; a check that treated an
       unresolved role as an agent would send every cold sign-in to `/dialer`. */
    mocks.role = undefined;

    renderSidebar();

    expect(screen.queryByRole('link', { name: EITHER_LABEL })).toBeNull();
  });
});

describe('agency dialer entry — collapsed rail', () => {
  /**
   * The collapsed sidebar is icon-only, and this is a labelled control whose whole
   * meaning is the label — the two arms share an icon and differ only in wording,
   * so an icon alone would not even say which destination it leads to.
   */
  it('is hidden when the sidebar is collapsed', () => {
    renderSidebar(true);

    expect(screen.queryByRole('link', { name: EITHER_LABEL })).toBeNull();
  });

  it('is hidden for the agent persona when collapsed too', () => {
    mocks.role = 'operator';

    renderSidebar(true);

    expect(screen.queryByRole('link', { name: EITHER_LABEL })).toBeNull();
  });
});
