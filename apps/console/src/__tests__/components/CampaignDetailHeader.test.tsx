import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CampaignDetailHeader } from '../../pages/agency/campaign-detail/CampaignDetailHeader';
type HeaderProps = Parameters<typeof CampaignDetailHeader>[0];
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The campaign header (Monitor tabs and Settings) at the two widths QA flagged:
 * a name cut to "CD 11TH NOV — ..." at 1440px, and at 390px five full-width
 * buttons pushing the tabs about 800px down. jsdom has no layout, so the layout
 * rules are read from the stylesheet and the markup they rely on is checked here.
 */

vi.mock('../../api/agencyCampaigns', () => ({
  campaignLineage: async () => ({ root_campaign_id: 'camp-1', campaigns: [] }),
}));

afterEach(cleanup);

const NAME = 'CD 11TH NOV — Retry 1';

function show(over: Partial<AgencyCampaign> = {}, props: Partial<HeaderProps> = {}) {
  const campaign = { id: 'camp-1', name: NAME, status: 'paused', ...over } as AgencyCampaign;
  return render(
    <MemoryRouter>
      <CampaignDetailHeader
        campaign={campaign}
        lastUpdatedAt={new Date('2026-11-12T05:38:00Z')}
        autoRefreshing
        tenantId="tenant-1"
        accountId="account-1"
        canControl
        canAddContacts
        busy={null}
        onAction={vi.fn()}
        onRetry={vi.fn()}
        canJoinStation
        role="tenant_owner"
        onRefresh={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

const css = readFileSync(resolve(__dirname, '../../pages/agency/AgencyCampaignDetailPage.module.css'), 'utf-8');
/** The body of the first rule for `selector` inside `scope` (the whole sheet, or one media block). */
function rule(selector: string, scope = css): string {
  const at = scope.indexOf(`${selector} {`);
  return at === -1 ? '' : scope.slice(at, scope.indexOf('}', at));
}
const phone = css.slice(css.indexOf('@media (max-width: 680px)'));

describe('campaign header: the name', () => {
  it('shows the whole name, which wraps rather than truncating', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(NAME);
    const title = rule('.title');
    expect(title).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(title).not.toMatch(/white-space:\s*nowrap/);
    expect(title).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('lets the actions drop below the name instead of squeezing it', () => {
    expect(rule('.header')).toMatch(/flex-wrap:\s*wrap/);
    // The copy is sized by its content; the actions may not refuse to shrink or wrap.
    expect(rule('.headerCopy')).toMatch(/flex:\s*1 1 auto/);
    expect(rule('.actions')).not.toMatch(/flex-shrink:\s*0/);
  });
});

describe('campaign header: the actions on a phone', () => {
  it('keeps the lifecycle words and puts every other action’s label where only assistive tech reads it', () => {
    show();
    const actions = screen.getByTestId('campaign-actions');
    // The primary action keeps its words; the rest are named by them still.
    expect(within(actions).getByRole('button', { name: 'Resume' })).toBeTruthy();
    for (const name of ['Add contacts', 'Retry contacts', 'Join as agent', 'History']) {
      const control = within(actions).getByRole(name === 'Retry contacts' ? 'button' : 'link', { name });
      const label = within(control).getByText(name);
      expect(label.className).toMatch(/actionLabel|label/);
    }
  });

  it('shrinks those actions to icons at phone width, and no button takes a full row', () => {
    expect(rule('.actionLabel', phone)).toMatch(/clip:\s*rect\(0, 0, 0, 0\)/);
    expect(phone).toMatch(/\.secondaryAction,\s*\.stationAction \{[^}]*width:\s*40px/);
    // The old rule gave every button `width: 100%`, a row each.
    expect(phone).not.toMatch(/\.actionButton[^{]*\{[^}]*width:\s*100%/);
    const historyCss = readFileSync(resolve(__dirname, '../../components/agency/CampaignHistoryLink.module.css'), 'utf-8');
    expect(historyCss).toMatch(/@media \(max-width: 680px\)[\s\S]*\.compact \.label \{[^}]*clip:\s*rect\(0, 0, 0, 0\)/);
  });
});

describe('campaign header: Add contacts follows the upload’s permission', () => {
  /*
    The ingest routes gate on `agency.campaigns.write`, not `agency.supervise`: the two share a
    floor today, and a split between them must neither take the only Add contacts away from a
    role that may upload nor offer it to one that would be refused.
  */
  it('offers Add contacts to a role that may upload but not supervise, without the lifecycle buttons', () => {
    show({}, { canControl: false, canAddContacts: true });
    const actions = screen.getByTestId('campaign-actions');
    expect(within(actions).getByRole('link', { name: 'Add contacts' }).getAttribute('href'))
      .toBe('/agency/campaigns/camp-1/contacts/add');
    expect(within(actions).queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('offers New campaign in its place once the campaign has ended, on the same permission', () => {
    show({ status: 'completed' }, { canControl: false, canAddContacts: true });
    expect(screen.getByRole('link', { name: 'New campaign' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add contacts' })).toBeNull();
  });

  it('does not offer it to a supervisor who may not upload', () => {
    show({}, { canControl: true, canAddContacts: false });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add contacts' })).toBeNull();
  });
});

describe('campaign header: the clocks', () => {
  it('never calls a paused campaign live, and says what its auto-refresh covers', () => {
    const now = Date.now();
    show({ started_at: new Date(now - 6 * 3600_000).toISOString() });
    const timeline = screen.getByTestId('campaign-timeline').textContent ?? '';
    expect(timeline).toMatch(/· 6 hours ago$/);
    expect(timeline).not.toMatch(/Live|Running/);
    expect(screen.getByText(/^Updated .* · status and agents auto-refresh$/)).toBeTruthy();
  });
});
