import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { prefersReducedMotion } from '../../../hooks/useKeepCurrentInStrip';
import { PANE_ALL_IN_VIEW, paneMoreLabel, paneOverflow, type PaneOverflow } from '../../../utils/agency/paneOverflow';
import styles from './LiveFloor.module.css';

/**
 * The attribute a pane's list item carries to be counted in "N more below": rows, cards, any item
 * a reader would scroll to. Put it on the `<li>`; anything without it is scrolled past, not counted.
 */
export const PANE_ITEM_ATTR = 'data-pane-item';

/** What tabbing to a revealed item lands on, if it has one. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Space left above the item "N more below" scrolls to, so it does not sit on the box's edge. */
const SCROLL_MARGIN_PX = 4;

/**
 * One of Live floor's side-by-side panes (Needs you now, Campaigns): a card whose heading stays put
 * while its body scrolls inside a fixed height, so a long list never pushes the agents' panel down
 * the page. The cap is CSS (`.paneBody`): lifted on a phone-width page, where a box that scrolls
 * inside a page that scrolls is harder to use than a long page. When items are out of sight below,
 * the body's bottom edge fades and "N more below" says how many; pressing it brings the first of
 * them to the top and moves focus to it (or to the body when it has nothing to focus), so focus
 * is never dropped when the button goes. Items are counted by {@link PANE_ITEM_ATTR}.
 */
export function FloorPane({
  headingId,
  icon: Icon,
  title,
  head,
  className,
  moreNoun,
  testId,
  children,
}: {
  /** The heading's id: it names the section. */
  headingId: string;
  icon: LucideIcon;
  /** The heading's text and anything inline with it (a count, a note). */
  title: ReactNode;
  /** Beside the heading: a note, a link, a button. */
  head?: ReactNode;
  /** Extra classes for the card. */
  className?: string;
  /** What the items are, singular, for "N more <noun>s below". */
  moreNoun: string;
  /** Prefix for the body's and the button's test ids. */
  testId: string;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<PaneOverflow>(PANE_ALL_IN_VIEW);

  const measure = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const next = overflowOf(body);
    setOverflow((now) => (now.below === next.below && now.firstBelow === next.firstBelow ? now : next));
  }, []);

  // After every render: a poll that adds, drops or reflows rows changes what is out of sight.
  useLayoutEffect(measure);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    body.addEventListener('scroll', schedule, { passive: true });
    // The page's width moves the cap and wraps rows; the content's height moves what is below.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(body);
    if (body.firstElementChild) observer?.observe(body.firstElementChild);
    return () => {
      body.removeEventListener('scroll', schedule);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [measure]);

  const showMore = () => {
    const body = bodyRef.current;
    if (!body || overflow.firstBelow === null) return;
    const item = itemsOf(body)[overflow.firstBelow];
    if (!item) return;
    const top = Math.max(0, boxOf(body, item).top - SCROLL_MARGIN_PX);
    if (typeof body.scrollTo === 'function') {
      body.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } else {
      body.scrollTop = top;
    }
    (item.querySelector<HTMLElement>(FOCUSABLE) ?? body).focus({ preventScroll: true });
  };

  return (
    <section className={className ? `${styles.card} ${className}` : styles.card} aria-labelledby={headingId}>
      <div className={styles.cardHead}>
        <h2 id={headingId} className={styles.cardTitle}>
          <Icon size={18} aria-hidden="true" />
          {title}
        </h2>
        {head}
      </div>
      <div
        ref={bodyRef}
        className={styles.paneBody}
        // Focus lands here when "N more below" reveals an item with nothing to focus; never a tab stop.
        tabIndex={-1}
        data-more={overflow.below > 0 ? 'true' : undefined}
        data-testid={`${testId}-body`}
      >
        <div className={styles.paneContent}>{children}</div>
      </div>
      {overflow.below > 0 && (
        <button type="button" className={`${styles.linkButton} ${styles.paneMore}`} onClick={showMore} data-testid={`${testId}-more`}>
          <ChevronDown size={14} aria-hidden="true" />
          {paneMoreLabel(overflow.below, moreNoun)}
        </button>
      )}
    </section>
  );
}

function itemsOf(body: HTMLElement): HTMLElement[] {
  return Array.from(body.querySelectorAll<HTMLElement>(`[${PANE_ITEM_ATTR}]`));
}

/** An item's edges in the body's scroll space, whatever is positioned between them. */
function boxOf(body: HTMLElement, item: HTMLElement): { top: number; bottom: number } {
  const bodyTop = body.getBoundingClientRect().top;
  const box = item.getBoundingClientRect();
  const top = box.top - bodyTop + body.scrollTop;
  return { top, bottom: top + box.height };
}

function overflowOf(body: HTMLElement): PaneOverflow {
  // Everything fits: nothing to count (and no layout read per item on every render).
  if (body.scrollHeight <= body.clientHeight + 1) return PANE_ALL_IN_VIEW;
  return paneOverflow(itemsOf(body).map((item) => boxOf(body, item)), body.scrollTop + body.clientHeight);
}
