import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PageDescription } from '../../components/common/PageDescription';
import * as config from '../../config';

/*
 * Decision B17: Magick Agency has no docs site, so the page guide has no "Read
 * the full guide" link and there are no docs-URL helpers. The first two cases
 * pin that absence; the third pins the collapsed-from-storage behaviour.
 */

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe('PageDescription — no docs link (B17)', () => {
  it('renders the guide with no link of any kind', () => {
    render(
      <PageDescription
        pageKey="team"
        description="Invite people and manage their roles."
        tips={['Roles control access.']}
      />,
    );
    expect(screen.getByText('Invite people and manage their roles.')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/Read the full guide/i)).toBeNull();
  });

  it('starts collapsed when the page key is stored as collapsed', () => {
    localStorage.setItem('pageDescCollapsed:team', '1');
    render(<PageDescription pageKey="team" description="Invite people and manage their roles." />);

    expect(screen.getByText('Show page guide')).toBeDefined();
    expect(screen.queryByText('Invite people and manage their roles.')).toBeNull();
  });

  it('exports no docs-site URL helpers from config', () => {
    for (const name of ['DOCS_BASE_URL', 'DOCS_SLUGS', 'docsUrl']) {
      expect(name in config, name).toBe(false);
    }
  });
});

describe('PageDescription — on a phone', () => {
  function asPhone(matches: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: matches && query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }

  afterEach(() => vi.unstubAllGlobals());

  it('starts closed on a phone, where an open guide fills the first screen', () => {
    asPhone(true);
    render(<PageDescription pageKey="team" description="Invite people and manage their roles." />);

    expect(screen.getByText('Show page guide')).toBeDefined();
    expect(screen.queryByText('Invite people and manage their roles.')).toBeNull();
  });

  it('starts open on a wider screen', () => {
    asPhone(false);
    render(<PageDescription pageKey="team" description="Invite people and manage their roles." />);

    expect(screen.getByText('Invite people and manage their roles.')).toBeDefined();
  });

  it('keeps a guide someone opened on a phone open next time', () => {
    asPhone(true);
    const first = render(<PageDescription pageKey="team" description="Invite people and manage their roles." />);
    fireEvent.click(screen.getByRole('button', { name: 'Show page guide' }));
    expect(screen.getByText('Invite people and manage their roles.')).toBeDefined();
    first.unmount();

    render(<PageDescription pageKey="team" description="Invite people and manage their roles." />);
    expect(screen.getByText('Invite people and manage their roles.')).toBeDefined();
  });
});
