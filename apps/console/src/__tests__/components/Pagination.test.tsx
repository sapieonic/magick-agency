import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Pagination } from '../../components/common/Pagination';
import styles from '../../components/common/Pagination.module.css';

afterEach(() => {
  cleanup();
});

function renderPagination(props: Partial<Parameters<typeof Pagination>[0]> = {}) {
  const onChange = vi.fn();
  const defaultProps = { total: 100, limit: 20, offset: 0, onChange };
  const result = render(<Pagination {...defaultProps} {...props} />);
  return { ...result, onChange };
}

/** Find the button whose text includes the given label. */
function getButton(container: HTMLElement, label: 'Previous' | 'Next'): HTMLButtonElement {
  const buttons = container.querySelectorAll('button');
  for (const btn of buttons) {
    if (btn.textContent?.includes(label)) return btn;
  }
  throw new Error(`Button "${label}" not found`);
}

describe('Pagination', () => {
  it('renders current page and total pages', () => {
    const { container } = renderPagination({ total: 100, limit: 20, offset: 0 });
    const info = container.querySelector('span')!;
    expect(info.textContent).toContain('of');
    expect(info.textContent).toContain('5');
  });

  it('Previous button is disabled on first page', () => {
    const { container } = renderPagination({ offset: 0 });
    const prevButton = getButton(container, 'Previous');
    expect(prevButton.disabled).toBe(true);
  });

  it('Next button is disabled on last page', () => {
    const { container } = renderPagination({ total: 100, limit: 20, offset: 80 });
    const nextButton = getButton(container, 'Next');
    expect(nextButton.disabled).toBe(true);
  });

  it('clicking Next calls onChange with correct offset', () => {
    const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 0 });
    const nextButton = getButton(container, 'Next');
    fireEvent.click(nextButton);
    expect(onChange).toHaveBeenCalledWith(20);
  });

  it('clicking Previous calls onChange with correct offset', () => {
    const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 40 });
    const prevButton = getButton(container, 'Previous');
    fireEvent.click(prevButton);
    expect(onChange).toHaveBeenCalledWith(20);
  });

  it('page input shows current page number', () => {
    const { container } = renderPagination({ total: 100, limit: 20, offset: 40 });
    const input = container.querySelector('input')!;
    expect(input.value).toBe('3');
  });

  it('typing a valid page number and pressing Enter jumps to that page', () => {
    const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 0 });
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(60); // (4 - 1) * 20
  });

  it('typing a page number and blurring jumps to that page', () => {
    const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 0 });
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(40); // (3 - 1) * 20
  });

  it('invalid input (letters) reverts to current page on blur', () => {
    const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 20 });
    const input = container.querySelector('input')!;
    // Current page is 2
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(input.value).toBe('2');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('page 0 input clamps to page 1', () => {
    const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 40 });
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    // 0 < 1 → jumpToPage reverts to current page (3), does not call onChange
    expect(input.value).toBe('3');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('page beyond total clamps to last page', () => {
    const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 0 });
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('5');
    expect(onChange).toHaveBeenCalledWith(80); // (5 - 1) * 20
  });

  it('empty input reverts to current page', () => {
    const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 20 });
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input.value).toBe('2');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('input syncs when offset changes externally', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <Pagination total={100} limit={20} offset={0} onChange={onChange} />,
    );
    const input = container.querySelector('input')!;
    expect(input.value).toBe('1');

    rerender(<Pagination total={100} limit={20} offset={60} onChange={onChange} />);
    expect(input.value).toBe('4');
  });

  describe('backward compatibility (no new props)', () => {
    it('renders exactly the previous control set — Previous, page box, Next, "· N total" — and none of the new controls', () => {
      const { container } = renderPagination({ total: 100, limit: 20, offset: 40 });

      // Previous / Next still present by their text
      expect(() => getButton(container, 'Previous')).not.toThrow();
      expect(() => getButton(container, 'Next')).not.toThrow();

      // Only 2 buttons total — no first/last edge buttons
      expect(container.querySelectorAll('button').length).toBe(2);

      // The bare "· N total" tail, not the "Showing X–Y of Z" label
      const info = container.querySelector('span')!;
      expect(info.textContent).toContain('· 100 total');
      expect(container.textContent).not.toContain('Showing');

      // No page-size select
      expect(container.querySelector('select')).toBeNull();
    });
  });

  describe('showEdges', () => {
    it('renders First/Last buttons with aria-labels, disabled at the respective ends', () => {
      const { container } = renderPagination({ total: 100, limit: 20, offset: 0, showEdges: true });
      const first = container.querySelector('button[aria-label="First page"]') as HTMLButtonElement;
      const last = container.querySelector('button[aria-label="Last page"]') as HTMLButtonElement;
      expect(first).not.toBeNull();
      expect(last).not.toBeNull();
      expect(first.disabled).toBe(true);
      expect(last.disabled).toBe(false);
    });

    it('First page button calls onChange(0)', () => {
      const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 60, showEdges: true });
      const first = container.querySelector('button[aria-label="First page"]')!;
      fireEvent.click(first);
      expect(onChange).toHaveBeenCalledWith(0);
    });

    it('Last page button calls onChange with the last page offset and is disabled on the last page', () => {
      const { container, onChange } = renderPagination({ total: 100, limit: 20, offset: 0, showEdges: true });
      const last = container.querySelector('button[aria-label="Last page"]')!;
      fireEvent.click(last);
      expect(onChange).toHaveBeenCalledWith(80); // (5 - 1) * 20

      const { container: c2 } = renderPagination({ total: 100, limit: 20, offset: 80, showEdges: true });
      const last2 = c2.querySelector('button[aria-label="Last page"]') as HTMLButtonElement;
      expect(last2.disabled).toBe(true);
    });
  });

  describe('pageSizeOptions', () => {
    it('renders a labelled select and changing it calls onLimitChange with the new size AND onChange(0)', () => {
      const onLimitChange = vi.fn();
      const { container, onChange } = renderPagination({
        total: 100,
        limit: 20,
        offset: 40,
        pageSizeOptions: [10, 20, 50],
        onLimitChange,
      });
      const select = container.querySelector('select') as HTMLSelectElement;
      expect(select).not.toBeNull();
      fireEvent.change(select, { target: { value: '50' } });
      expect(onLimitChange).toHaveBeenCalledWith(50);
      expect(onChange).toHaveBeenCalledWith(0);
    });

    it('does not render a select when onLimitChange is missing', () => {
      const { container } = renderPagination({
        total: 100,
        limit: 20,
        offset: 0,
        pageSizeOptions: [10, 20, 50],
      });
      expect(container.querySelector('select')).toBeNull();
    });
  });

  describe('itemNoun range label', () => {
    const noun = { singular: 'call', plural: 'calls' };

    it('shows the range on the first page', () => {
      const { container } = renderPagination({ total: 5205, limit: 20, offset: 0, itemNoun: noun });
      expect(container.textContent).toContain('Showing 1–20 of 5,205 calls');
    });

    it('shows the range on a middle page', () => {
      const { container } = renderPagination({ total: 5205, limit: 20, offset: 100, itemNoun: noun });
      expect(container.textContent).toContain('Showing 101–120 of 5,205 calls');
    });

    it('shows the partial-page range on the last page (end is the total, not offset+limit)', () => {
      const { container } = renderPagination({ total: 105, limit: 20, offset: 100, itemNoun: noun });
      expect(container.textContent).toContain('Showing 101–105 of 105 calls');
    });

    it('renders nothing for the range when total is 0', () => {
      const { container } = renderPagination({ total: 0, limit: 20, offset: 0, itemNoun: noun });
      expect(container.textContent).not.toContain('Showing');
    });

    it('uses the singular noun when total is exactly 1', () => {
      const { container } = renderPagination({ total: 1, limit: 20, offset: 0, itemNoun: noun });
      expect(container.textContent).toContain('Showing 1–1 of 1 call');
      expect(container.textContent).not.toContain('1 calls');
    });

    it('suppresses the bare "· N total" tail when itemNoun is used', () => {
      const { container } = renderPagination({ total: 5205, limit: 20, offset: 0, itemNoun: noun });
      expect(container.textContent).not.toContain('· 5205 total');
    });
  });

  describe('layout', () => {
    it('default (centered) container carries only the base container class', () => {
      const { container } = renderPagination({ total: 100, limit: 20, offset: 0 });
      const el = container.firstElementChild as HTMLElement;
      expect(el.className).toBe(styles.container);
    });

    it('split layout adds the split class rather than replacing the base class', () => {
      const { container } = renderPagination({ total: 100, limit: 20, offset: 0, layout: 'split' });
      const el = container.firstElementChild as HTMLElement;
      expect(el.classList.contains(styles.container!)).toBe(true);
      expect(el.classList.contains(styles.split!)).toBe(true);
    });

    it('flush adds the flush class', () => {
      const { container } = renderPagination({ total: 100, limit: 20, offset: 0, flush: true });
      const el = container.firstElementChild as HTMLElement;
      expect(el.classList.contains(styles.flush!)).toBe(true);
    });
  });
});
