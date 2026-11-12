import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { Fragment, useEffect, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { UrlScopeProvider } from '../../contexts/UrlScopeContext';
import { ScopedRouter } from '../../components/routing/ScopedRouter';
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

/** The console's own router over the browser history, as the app mounts it. */
function renderInBrowserAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UrlScopeProvider>
      <ScopedRouter>
        <Routes>
          <Route path="/c/:id/settings" element={<Page />} />
        </Routes>
      </ScopedRouter>
    </UrlScopeProvider>,
  );
}

/** A fragment typed into the address bar: a new entry with no history state, then `popstate`. */
async function typeFragment(path: string) {
  await act(async () => {
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  });
}

describe('useSectionInView — a fragment typed into the address bar', () => {
  it('opens at each section typed, though none of them has a history key', async () => {
    renderInBrowserAt('/c/c-1/settings#calling-hours');
    await load();
    expect(scrolled).toEqual(['c-1:calling-hours']);

    await typeFragment('/c/c-1/settings#recording');
    expect(current()).toEqual(['Recording']);
    expect(scrolled).toEqual(['c-1:calling-hours', 'c-1:recording']);

    await typeFragment('/c/c-1/settings#calling-hours');
    expect(current()).toEqual(['Calling hours']);
  });
});

describe('useSectionInView — the band that decides the section being read', () => {
  let options: IntersectionObserverInit[] = [];
  beforeEach(() => {
    options = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(_callback: IntersectionObserverCallback, init: IntersectionObserverInit) { options.push(init); }
      observe() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A jump lands a section its scroll margin below the top of the scroll area, and the one
   * above ends a card gap higher: at that edge, or under the phone's sticky strip. Counted
   * from the viewport's top, that tail was "in view" and won the highlight back from the
   * section just picked. The band is rooted on the scroll area and starts just above the line.
   */
  it('is rooted on the scroll area and starts just above where a jump lands a section', async () => {
    const pane = document.createElement('div');
    pane.style.overflowY = 'auto';
    document.body.appendChild(pane);
    const style = document.createElement('style');
    style.textContent = 'section { scroll-margin-top: 64px; }';
    document.head.appendChild(style);
    try {
      render(
        <MemoryRouter initialEntries={['/c/c-1/settings']}>
          <Routes>
            <Route path="/c/:id/settings" element={<Page />} />
          </Routes>
        </MemoryRouter>,
        { container: pane },
      );
      await load();
      expect(options.at(-1)?.root).toBe(pane);
      expect(options.at(-1)?.rootMargin).toBe('-56px 0px -60% 0px');
    } finally {
      style.remove();
      pane.remove();
    }
  });
});

/** A page that remounts its sections under the same ids, as campaign Settings' Discard does. */
function RemountingPage() {
  const [epoch, setEpoch] = useState(0);
  const nav = useSectionInView(SECTIONS, true, epoch);
  return (
    <div>
      <SettingsSectionNav sections={SECTIONS} active={nav.active} onSelect={nav.select} />
      <button type="button" onClick={() => setEpoch((n) => n + 1)}>Discard</button>
      <Fragment key={epoch}>
        {SECTIONS.map((s) => <section key={s.id} id={s.id}>{s.label}</section>)}
      </Fragment>
    </div>
  );
}

describe('useSectionInView — sections remounted by Discard', () => {
  let observers: { callback: IntersectionObserverCallback; watched: Element[]; live: boolean }[] = [];
  beforeEach(() => {
    observers = [];
    vi.stubGlobal('IntersectionObserver', class {
      private readonly record: { callback: IntersectionObserverCallback; watched: Element[]; live: boolean };
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, watched: [], live: true };
        observers.push(this.record);
      }
      observe(element: Element) { this.record.watched.push(element); }
      disconnect() { this.record.live = false; }
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('watches the new sections, so scrolling still moves the highlight', () => {
    render(
      <MemoryRouter initialEntries={['/c/c-1/settings']}>
        <RemountingPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Discard'));

    const live = observers.filter((o) => o.live);
    expect(live).toHaveLength(1);
    const [observer] = live;
    expect(observer!.watched.map((e) => e.id)).toEqual(SECTIONS.map((s) => s.id));
    expect(observer!.watched.every((e) => e.isConnected)).toBe(true);

    act(() => {
      observer!.callback(
        [{ target: document.getElementById('recording')!, isIntersecting: true } as unknown as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    });
    expect(current()).toEqual(['Recording']);
  });
});

describe('SettingsSectionNav — the phone strip', () => {
  it('scrolls the highlighted section into sight along the strip', () => {
    const { rerender } = render(
      <SettingsSectionNav sections={SECTIONS} active="general" onSelect={() => {}} />,
    );
    const nav = screen.getByTestId('settings-section-nav');
    // A 300px strip holding 600px of links; Recording sits off its right end.
    Object.defineProperty(nav, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(nav, 'clientWidth', { configurable: true, value: 300 });
    nav.getBoundingClientRect = () => ({ left: 0, right: 300, width: 300 }) as DOMRect;
    screen.getByTestId('settings-section-link-recording').getBoundingClientRect = () =>
      ({ left: 450, right: 550, width: 100 }) as DOMRect;
    const scrollTo = vi.fn();
    nav.scrollTo = scrollTo as typeof nav.scrollTo;

    rerender(<SettingsSectionNav sections={SECTIONS} active="recording" onSelect={() => {}} />);
    // Centred: 450 - (300 - 100) / 2.
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 350 }));
  });

  it('leaves a strip alone when every section fits', () => {
    const { rerender } = render(
      <SettingsSectionNav sections={SECTIONS} active="general" onSelect={() => {}} />,
    );
    const nav = screen.getByTestId('settings-section-nav');
    const scrollTo = vi.fn();
    nav.scrollTo = scrollTo as typeof nav.scrollTo;
    rerender(<SettingsSectionNav sections={SECTIONS} active="recording" onSelect={() => {}} />);
    expect(scrollTo).not.toHaveBeenCalled();
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
