import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  SettingsSectionNav,
  sectionIdOfHash,
  useSectionInView,
} from '../../components/agency/SettingsSectionNav';

/**
 * `useSectionInView` on a page that stays mounted. React-router keeps one instance of a page
 * across `…/settings#a` → `…/settings#b`, and across `…/c-1/settings` → `…/c-2/settings`, which
 * is what search does when it jumps to a section; each such navigation must open the page at
 * its section, not only the first one.
 */

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'calling-hours', label: 'Calling hours' },
  { id: 'recording', label: 'Recording' },
];

/** Resolves each campaign's "load" by hand, so a test can look at the page mid-load. */
let finishLoad: (() => void) | null = null;

function Page() {
  const { id } = useParams<{ id: string }>();
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    finishLoad = () => {
      setLoadedId(id ?? null);
      setLoading(false);
    };
  }, [id]);
  const nav = useSectionInView(SECTIONS, !loading && loadedId === id);
  return (
    <div>
      <SettingsSectionNav sections={SECTIONS} active={nav.active} onSelect={nav.select} />
      {loadedId && SECTIONS.map((s) => <section key={s.id} id={s.id} data-campaign={loadedId}>{s.label}</section>)}
    </div>
  );
}

/** Stands in for search: a push navigation from outside the page. */
function Jump() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <button type="button" onClick={() => navigate('/c/c-1/settings#recording')}>c-1 recording</button>
      <button type="button" onClick={() => navigate('/c/c-1/settings#calling-hours')}>c-1 hours</button>
      <button type="button" onClick={() => navigate('/c/c-2/settings#recording')}>c-2 recording</button>
      <span data-testid="hash">{location.hash}</span>
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/c/:id/settings" element={<Page />} />
      </Routes>
      <Jump />
    </MemoryRouter>,
  );
}

const current = () => screen.getAllByTestId(/^settings-section-link-/)
  .filter((link) => link.getAttribute('aria-current') === 'true')
  .map((link) => link.textContent);

let scrolled: string[] = [];
beforeEach(() => {
  scrolled = [];
  finishLoad = null;
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(`${this.getAttribute('data-campaign')}:${this.id}`);
  };
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

async function load() {
  await act(async () => {
    finishLoad?.();
  });
}

describe('useSectionInView', () => {
  it('opens at the section the first URL names, once the sections are there', async () => {
    renderAt('/c/c-1/settings#calling-hours');
    expect(scrolled).toEqual([]);
    await load();
    expect(scrolled).toEqual(['c-1:calling-hours']);
    expect(current()).toEqual(['Calling hours']);
  });

  it('opens at each new section of the same campaign while the page stays mounted', async () => {
    renderAt('/c/c-1/settings');
    await load();
    expect(scrolled).toEqual([]);

    fireEvent.click(screen.getByText('c-1 recording'));
    expect(scrolled).toEqual(['c-1:recording']);
    expect(current()).toEqual(['Recording']);

    fireEvent.click(screen.getByText('c-1 hours'));
    expect(scrolled).toEqual(['c-1:recording', 'c-1:calling-hours']);
    expect(current()).toEqual(['Calling hours']);

    // The same section again (scrolled away since): a new navigation, so it goes there again.
    fireEvent.click(screen.getByText('c-1 hours'));
    expect(scrolled).toEqual(['c-1:recording', 'c-1:calling-hours', 'c-1:calling-hours']);
  });

  it('waits for another campaign’s sections before opening at one of them', async () => {
    renderAt('/c/c-1/settings#calling-hours');
    await load();
    expect(scrolled).toEqual(['c-1:calling-hours']);

    fireEvent.click(screen.getByText('c-2 recording'));
    // The first campaign's sections are still on the page: not the place to land.
    expect(scrolled).toEqual(['c-1:calling-hours']);

    await load();
    expect(scrolled).toEqual(['c-1:calling-hours', 'c-2:recording']);
    expect(current()).toEqual(['Recording']);
  });

  it('scrolls once to a picked section and writes it into the URL', async () => {
    renderAt('/c/c-1/settings');
    await load();

    fireEvent.click(screen.getByTestId('settings-section-link-recording'));
    expect(scrolled).toEqual(['c-1:recording']);
    expect(current()).toEqual(['Recording']);
    expect(screen.getByTestId('hash').textContent).toBe('#recording');

    // A jump from search to a section after a pick still opens at it.
    fireEvent.click(screen.getByText('c-1 hours'));
    expect(scrolled).toEqual(['c-1:recording', 'c-1:calling-hours']);
  });

  it('survives a malformed hash and opens at no section', async () => {
    renderAt('/c/c-1/settings#%E0%A4%A');
    await load();
    expect(screen.getByTestId('settings-section-nav')).toBeTruthy();
    expect(scrolled).toEqual([]);
    expect(current()).toEqual(['General']);
  });
});

describe('sectionIdOfHash', () => {
  it('decodes a hash, and reads a malformed one as written', () => {
    expect(sectionIdOfHash('#calling-hours')).toBe('calling-hours');
    expect(sectionIdOfHash('#caf%C3%A9')).toBe('café');
    expect(sectionIdOfHash('#%E0%A4%A')).toBe('%E0%A4%A');
    expect(sectionIdOfHash('')).toBe('');
  });
});
