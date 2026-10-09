import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PageDescription } from '../../components/common/PageDescription';
import * as config from '../../config';

/*
 * PORT NOTE (magick-agency, decision B17): cusui's 8 cases here pinned the page
 * guide's "Read the full guide" link to the parent product's documentation site
 * (`docs.magickvoice.com`) and the `docsUrl` / `DOCS_SLUGS` helpers behind it.
 * Magick Agency has no docs site, so the link and the helpers are deleted, and
 * the 8 cases are replaced by these 2 deletion tests. cusui's collapsed-from-
 * storage case survives without its link assertion (third case).
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
