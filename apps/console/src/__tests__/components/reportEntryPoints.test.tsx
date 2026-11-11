import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Who is offered reports (`docs/reports.md` "Who may run what", RP5), at every place
 * the console offers them: the four export entry points, the agency sidebar and the
 * agent nav. The flag `agency_reports_enabled` off hides all of it; with it on, a
 * supervisor may export any subject, and anyone else only their own review.
 */

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  role: 'account_admin' as string | undefined,
  user: { id: 'me-1', display_name: 'Meera Agent', email: 'meera@example.com' } as
    | { id: string; display_name: string | null; email: string }
    | null,
}));

vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  SOFTPHONE_FLAG: 'agency_softphone_enabled',
  useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true,
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role, tenantId: 't', accountId: 'account-1', accounts: [] }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));

import { ExportReportButton, mayExport, type ExportEntryTarget } from '../../components/agency/reports/ExportReportButton';
import { tabBarFor, visibleSections, type GateInput } from '../../utils/consoleNav';
import { AgentNav } from '../../components/agency/AgentNav';

const AGENT_TARGET: ExportEntryTarget = { kind: 'agent', subject: { id: 'agent-9', name: 'Priya S' } };
const CAMPAIGN_TARGET: ExportEntryTarget = { kind: 'campaign', subject: { id: 'camp-1', name: 'Dues' }, campaignTimezone: 'Asia/Kolkata' };
const ACCOUNT_TARGET: ExportEntryTarget = { kind: 'account', subject: { id: 'account-1', name: 'North' } };
const SELF: ExportEntryTarget = { self: true };

function entry(target: ExportEntryTarget) {
  render(
    <MemoryRouter>
      <ExportReportButton target={target} entry="reports_page" />
    </MemoryRouter>,
  );
  return screen.queryByTestId('report-entry-reports_page');
}

function as(role: string | undefined, reports: boolean) {
  mocks.role = role;
  mocks.flags = { agency_reports_enabled: reports };
}

beforeEach(() => {
  mocks.user = { id: 'me-1', display_name: 'Meera Agent', email: 'meera@example.com' };
  as('account_admin', true);
});

describe('mayExport — the one gate every entry point goes through', () => {
  const access = (over: Partial<Parameters<typeof mayExport>[0]>) => ({
    enabled: true,
    canSupervise: true,
    canSelf: true,
    userId: 'me-1',
    userName: null,
    role: undefined,
    ...over,
  });

  it('refuses everything while the flag is off', () => {
    for (const t of [AGENT_TARGET, CAMPAIGN_TARGET, ACCOUNT_TARGET, SELF]) {
      expect(mayExport(access({ enabled: false }), t)).toBe(false);
    }
  });

  it('lets a supervisor export any subject', () => {
    for (const t of [AGENT_TARGET, CAMPAIGN_TARGET, ACCOUNT_TARGET, SELF]) expect(mayExport(access({}), t)).toBe(true);
  });

  it('lets anyone else export only their own review, once their id is known', () => {
    const agent = access({ canSupervise: false });
    expect(mayExport(agent, SELF)).toBe(true);
    for (const t of [AGENT_TARGET, CAMPAIGN_TARGET, ACCOUNT_TARGET]) expect(mayExport(agent, t)).toBe(false);
    expect(mayExport(access({ canSupervise: false, userId: null }), SELF)).toBe(false);
  });
});

describe('ExportReportButton', () => {
  it.each([
    ['agent review', AGENT_TARGET, 'Export agent review'],
    ['campaign report', CAMPAIGN_TARGET, 'Export campaign report'],
    ['account report', ACCOUNT_TARGET, 'Export account report'],
    ['own review', SELF, 'Export my review'],
  ])('offers a supervisor the %s', (_name, target, label) => {
    expect(entry(target)?.textContent).toBe(label);
  });

  it.each([AGENT_TARGET, CAMPAIGN_TARGET, ACCOUNT_TARGET, SELF])('renders nothing while the flag is off (%#)', (target) => {
    as('account_admin', false);
    expect(entry(target)).toBeNull();
  });

  it.each([AGENT_TARGET, CAMPAIGN_TARGET, ACCOUNT_TARGET])('renders nothing for an agent on another subject (%#)', (target) => {
    as('agent', true);
    expect(entry(target)).toBeNull();
  });

  it('offers an agent their own review, and opens the dialog on themselves with the self note', () => {
    as('agent', true);
    fireEvent.click(entry(SELF)!);
    expect(screen.getByRole('dialog', { name: 'Export my review' })).toBeTruthy();
    expect(screen.getByText('Meera Agent')).toBeTruthy();
    expect(screen.getByTestId('report-self-note')).toBeTruthy();
  });

  it('opens a supervisor’s own review without the self note (the server serves them the full one)', () => {
    fireEvent.click(entry(SELF)!);
    expect(screen.queryByTestId('report-self-note')).toBeNull();
  });

  it('offers nothing before the role resolves', () => {
    as(undefined, true);
    expect(entry(SELF)).toBeNull();
    expect(entry(ACCOUNT_TARGET)).toBeNull();
  });
});

describe('navigation', () => {
  const gates = (role: string, reports: boolean): GateInput => ({
    role: role as GateInput['role'],
    isFlagEnabled: (f) => f === 'agency_dialer_enabled' || (reports && f === 'agency_reports_enabled'),
    isCapabilityEnabled: () => true,
  });
  const reportTabs = (role: string, reports: boolean) =>
    tabBarFor('/agency/analytics', gates(role, reports))?.tabs.map((t) => [t.label, t.to]) ?? [];

  it('the console groups Exports (the reports page) beside Analytics only while the flag is on', () => {
    expect(reportTabs('account_admin', true)).toEqual([
      ['Analytics', '/agency/analytics'],
      ['Exports', '/agency/reports'],
    ]);
    expect(reportTabs('account_admin', false)).toEqual([]);
  });

  it('the console offers a viewer Exports (their own runs) but never a dedicated agent', () => {
    expect(reportTabs('viewer', true).map(([label]) => label)).toContain('Exports');
    // A dedicated agent is offered only the way back to the dialler.
    expect(visibleSections(gates('agent', true)).map((s) => s.section.id)).toEqual(['dialer']);
  });

  it('the agent nav offers My reports only while the flag is on', () => {
    as('agent', true);
    const { unmount } = render(<MemoryRouter><AgentNav current="performance" /></MemoryRouter>);
    expect(screen.getByTestId('agent-nav-reports').getAttribute('href')).toBe('/dialer/reports');
    expect(screen.getByTestId('agent-nav-reports').textContent).toBe('My reports');
    unmount();
    as('agent', false);
    render(<MemoryRouter><AgentNav current="performance" /></MemoryRouter>);
    expect(screen.queryByTestId('agent-nav-reports')).toBeNull();
  });
});

describe('the four entry points mount the gated button with their subject', () => {
  const src = (path: string) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8');

  it.each([
    ['components/agency/AgentAnalyticsSection.tsx', 'agent_record', "kind: 'agent', subject: { id: userId"],
    ['pages/agency/AgentPerformancePage.tsx', 'my_performance', 'target={{ self: true }}'],
    ['pages/agency/campaign-detail/insights/InsightsPanel.tsx', 'campaign_insights', "kind: 'campaign'"],
    ['pages/agency/AgencyAnalyticsPage.tsx', 'account_analytics', "kind: 'account'"],
  ])('%s', (path, entryName, subject) => {
    const text = src(path);
    const at = text.indexOf(`entry="${entryName}"`);
    expect(at, `${path} mounts entry ${entryName}`).toBeGreaterThan(-1);
    const element = text.slice(text.lastIndexOf('<ExportReportButton', at), text.indexOf('/>', at));
    expect(element).toContain(subject);
  });
});
