import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TenantMember } from '../../types/team';

/**
 * TeamPage actions menu — portaled so table overflow cannot clip it.
 * Regression for the last-row ⋮ menu being cut off by .tableWrap overflow.
 */
const mocks = vi.hoisted(() => ({
  useTeam: vi.fn(),
  useAccounts: vi.fn(),
  usePermission: vi.fn(),
  useTenant: vi.fn(),
  inviteUser: vi.fn(),
  updateUserRole: vi.fn(),
  removeUserMembership: vi.fn(),
}));

vi.mock('../../hooks/useTeam', () => ({ useTeam: mocks.useTeam }));
vi.mock('../../hooks/useAccounts', () => ({ useAccounts: mocks.useAccounts }));
vi.mock('../../hooks/usePermission', () => ({ usePermission: mocks.usePermission }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/users', () => ({
  inviteUser: mocks.inviteUser,
  updateUserRole: mocks.updateUserRole,
  removeUserMembership: mocks.removeUserMembership,
}));
vi.mock('../../analytics/events', () => ({ trackSetupEvent: vi.fn() }));

import TeamPage from '../../pages/team/TeamPage';

function makeMember(overrides?: {
  role?: TenantMember['membership']['role'];
  email?: string;
  display_name?: string | null;
  /**
   * `'absent'` is a NAME for omitting the property, not a third behaviour: it
   * and `undefined` both build a membership with no `invite_state` key at all,
   * which is the shape an older master sends. It exists so a test about that
   * case says so at the call site instead of leaving the reader to infer it
   * from an argument that is not there.
   *
   * (`TeamPage.resendInvite.test.tsx` has the same literal where it IS a
   * distinct value — that file's `makeMember` takes a defaulted positional
   * parameter, so `undefined` there means `'pending'`.)
   */
  inviteState?: 'active' | 'pending' | 'absent';
}): TenantMember {
  const role = overrides?.role ?? 'viewer';
  const inviteState = overrides?.inviteState;
  return {
    membership: {
      id: 'mem-1',
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      account_id: null,
      role,
      status: 'active',
      invited_by: null,
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z',
      ...(inviteState && inviteState !== 'absent' ? { invite_state: inviteState } : {}),
    },
    user: {
      id: 'user-1',
      // Master's placeholder stub for somebody who has never completed Firebase
      // sign-in — the exact value `invite_state: 'pending'` is derived from, and
      // the one the ticket forbids putting on screen. Tracking the state here
      // rather than hardcoding one uid is what gives the "no stub uid is
      // rendered" assertion below something real to fail against.
      firebase_uid: inviteState === 'pending' ? 'pending_9f0c2b41' : 'fb-1',
      email: overrides?.email ?? 'abhisek.d@example.com',
      display_name: overrides?.display_name !== undefined ? overrides.display_name : 'abhisek.d',
      avatar_url: null,
      status: 'active',
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  mocks.useTeam.mockReturnValue({
    members: [makeMember()],
    loading: false,
    error: null,
    reload: vi.fn(),
  });
  mocks.useAccounts.mockReturnValue({ accounts: [] });
  mocks.usePermission.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', role: 'tenant_admin' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TeamPage — member actions menu (overflow clip regression)', () => {
  it('renders the actions menu into document.body so table overflow cannot clip it', () => {
    render(
      <MemoryRouter>
        <TeamPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Member actions' }));

    const menu = screen.getByRole('menu', { name: 'Member actions' });
    expect(menu).toBeTruthy();
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole('menuitem', { name: /Change Role/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /^Remove$/i })).toBeTruthy();

    // Fixed positioning is applied so the menu escapes overflow containers.
    expect(getComputedStyle(menu).position).toBe('fixed');
  });

  it('flips the menu above the trigger when there is no room below', () => {
    // Put the trigger near the bottom of the viewport.
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });

    render(
      <MemoryRouter>
        <TeamPage />
      </MemoryRouter>,
    );

    const trigger = screen.getByRole('button', { name: 'Member actions' });
    trigger.getBoundingClientRect = () =>
      ({
        top: 160,
        bottom: 188,
        left: 700,
        right: 728,
        width: 28,
        height: 28,
        x: 700,
        y: 160,
        toJSON: () => ({}),
      }) as DOMRect;

    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'Member actions' });
    // Force a known menu height so reposition can decide to flip.
    Object.defineProperty(menu, 'offsetHeight', { configurable: true, value: 96 });

    // Re-open to re-run layout effect after offsetHeight is known, or dispatch resize.
    fireEvent(window, new Event('resize'));

    const top = Number.parseFloat((menu as HTMLElement).style.top);
    // Trigger top (160) minus menu height (96) minus gap (4) = 60
    expect(top).toBeLessThan(160);
    expect(top).toBe(160 - 96 - 4);
  });
});

/**
 * `agent` is assignable (`MAG-160`).
 *
 * It was display metadata only — `ROLES` carried it so an existing membership
 * rendered as "Agent", and neither picker offered it — because the role had no
 * way into the product. It does now: an `agent` lands on their assigned station
 * at sign-in, so a supervisor staffing a dialer campaign must be able to create
 * one without a support ticket. Master's validators already accepted it, which
 * is exactly why the omission was invisible.
 */
describe('TeamPage — the agent role is offered in both pickers', () => {
  it('lists Agent as an invitable role', () => {
    render(
      <MemoryRouter>
        <TeamPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /invite member/i }));
    const options = Array.from(
      screen.getByLabelText('Role').querySelectorAll('option'),
    ).map((option) => option.value);
    expect(options).toContain('agent');
    // Last: the order runs most access to least, and `agent` (level 5) is the
    // only entry below `viewer`.
    expect(options[options.length - 1]).toBe('agent');
  });

  it('offers Agent as a role change for a member below the actor', () => {
    render(
      <MemoryRouter>
        <TeamPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Member actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Change Role/i }));

    expect(screen.getByRole('menuitem', { name: /^Agent$/i })).toBeTruthy();
  });
});

/**
 * ClickUp `14ygtkj7tbx` — "Show pending vs signed-up status after inviting an
 * agent". Before this, an invited member's row showed nothing to say whether
 * they had signed up at all; a supervisor had to take it on faith.
 *
 * Master derives `invite_state` from ONE rule for every role: `pending` iff the
 * person has never completed Firebase sign-in (their stored identity is still a
 * placeholder stub). It is a fact about the PERSON — it does not claim anything
 * about whether they have opened this particular workspace — so the copy below
 * is deliberately about signing up and never about accepting an invitation.
 *
 * The three cases are the three things master can say (`pending`, `active`, and
 * nothing at all — see `InviteStateBadge` for why the third claims NEITHER of
 * the first two, and `inviteNotKnownJoined` for why the Resend control still
 * has to pick a side). The fourth pins the two header decisions: the invite column
 * is **Invite** and not `Status`, which `membership.status` and super-admin's
 * own members table have already spent; and the date column is **Invited** and
 * not `Joined`, because it renders `membership.created_at` — when the invite
 * was WRITTEN — so it read "Joined 3 days ago" about somebody who never had.
 */
describe('TeamPage — invite column', () => {
  it('shows Pending for somebody master says has never signed in', () => {
    mocks.useTeam.mockReturnValue({
      members: [makeMember({ inviteState: 'pending' })],
      loading: false,
      error: null,
      reload: vi.fn(),
    });

    render(<MemoryRouter><TeamPage /></MemoryRouter>);

    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.queryByText('Joined')).toBeNull();
    /*
      The stub uid this state is derived from must not reach the screen — the
      ticket's one explicit prohibition, and the reason `invite_state` exists
      instead of master shipping `firebase_uid` to the browser. The member
      above carries `pending_9f0c2b41`, so this fails if any cell ever renders
      it (a debug column, a `title`, an avatar fallback keyed on the uid).
    */
    expect(document.body.textContent ?? '').not.toMatch(/pending_/);
  });

  it('shows Joined for somebody master says has signed in', () => {
    mocks.useTeam.mockReturnValue({
      members: [makeMember({ inviteState: 'active' })],
      loading: false,
      error: null,
      reload: vi.fn(),
    });

    render(<MemoryRouter><TeamPage /></MemoryRouter>);

    expect(screen.getByText('Joined')).toBeTruthy();
    expect(screen.queryByText('Pending')).toBeNull();
    // Never the word the neighbouring `membership.status` and super-admin's own
    // members table already use for a different fact.
    expect(screen.queryByText('Active')).toBeNull();
  });

  it('claims NEITHER state when master sent no invite_state', () => {
    // An older master (or a cached SPA outliving a rollback) sends nothing, and
    // the badge makes no claim on no evidence — in EITHER direction. This test
    // previously asserted a green "Joined" here, which is the exact sentence
    // this column was added to stop the page getting wrong: it would tell a
    // supervisor that an invitee who may never have signed in had joined.
    // The Resend PREDICATE still has to answer something, and defaults the
    // other way — see TeamPage.resendInvite.test.tsx.
    mocks.useTeam.mockReturnValue({
      members: [makeMember({ inviteState: 'absent' })],
      loading: false,
      error: null,
      reload: vi.fn(),
    });

    render(<MemoryRouter><TeamPage /></MemoryRouter>);

    expect(screen.queryByText('Joined')).toBeNull();
    expect(screen.queryByText('Pending')).toBeNull();
    // Neutral placeholder, labelled for a screen reader rather than left as a
    // bare dash: the cell reads "Unknown", not "em dash".
    expect(screen.getByLabelText('Unknown')).toBeTruthy();
  });

  it('heads the new column "Invite" and the date column "Invited"', () => {
    render(<MemoryRouter><TeamPage /></MemoryRouter>);

    expect(screen.getByRole('columnheader', { name: 'Invite' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Invited' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Joined' })).toBeNull();
    // `Status` is the collision this copy was chosen to avoid: `Membership`
    // has its own `status`, and super-admin's tenant-members table already
    // renders a green "Active" under a header by that name.
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
  });
});
