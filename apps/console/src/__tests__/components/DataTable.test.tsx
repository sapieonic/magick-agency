import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DataTable } from '../../components/common/DataTable';
import styles from '../../components/common/DataTable.module.css';

afterEach(() => cleanup());

interface TestRow {
  id: string;
  name: string;
  value: number;
}

const columns = [
  { key: 'name', label: 'Name' },
  { key: 'value', label: 'Value' },
];

const testData: TestRow[] = [
  { id: '1', name: 'Alpha', value: 10 },
  { id: '2', name: 'Beta', value: 20 },
  { id: '3', name: 'Gamma', value: 30 },
];

const keyExtractor = (row: TestRow) => row.id;

describe('DataTable', () => {
  it('renders column headers', () => {
    render(
      <DataTable
        columns={columns}
        data={testData}
        keyExtractor={keyExtractor}
      />
    );
    expect(screen.getByText('Name')).toBeDefined();
    expect(screen.getByText('Value')).toBeDefined();
  });

  it('renders data rows', () => {
    const { container } = render(
      <DataTable
        columns={columns}
        data={testData}
        keyExtractor={keyExtractor}
      />
    );
    const cells = container.querySelectorAll('tbody td');
    const texts = Array.from(cells).map(td => td.textContent);
    expect(texts).toContain('Alpha');
    expect(texts).toContain('Beta');
    expect(texts).toContain('Gamma');
  });

  it('renders empty state when no data', () => {
    render(
      <DataTable
        columns={columns}
        data={[]}
        keyExtractor={keyExtractor}
      />
    );
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('renders skeleton rows when loading', () => {
    const { container } = render(
      <DataTable
        columns={columns}
        data={[]}
        loading={true}
        keyExtractor={keyExtractor}
      />
    );
    const skeletonCells = container.querySelectorAll('[class*="skeletonCell"]');
    // 5 skeleton rows × 2 columns = 10 skeleton cells
    expect(skeletonCells.length).toBe(10);
  });

  it('wraps table in scroll container', () => {
    const { container } = render(
      <DataTable
        columns={columns}
        data={testData}
        keyExtractor={keyExtractor}
      />
    );
    const scrollContainer = container.querySelector('[class*="scrollContainer"]');
    expect(scrollContainer).not.toBeNull();
  });

  it('has wrapper div as outermost element', () => {
    const { container } = render(
      <DataTable
        columns={columns}
        data={testData}
        keyExtractor={keyExtractor}
      />
    );
    const wrapper = container.querySelector('[class*="wrapper"]');
    expect(wrapper).not.toBeNull();
  });

  it('applies clickableRow class when onRowClick provided', () => {
    const handleClick = () => {};
    const { container } = render(
      <DataTable
        columns={columns}
        data={testData}
        keyExtractor={keyExtractor}
        onRowClick={handleClick}
      />
    );
    const clickableRows = container.querySelectorAll('[class*="clickableRow"]');
    expect(clickableRows.length).toBe(3);
  });

  it('does not apply clickableRow class when no onRowClick', () => {
    const { container } = render(
      <DataTable
        columns={columns}
        data={testData}
        keyExtractor={keyExtractor}
      />
    );
    const clickableRows = container.querySelectorAll('[class*="clickableRow"]');
    expect(clickableRows.length).toBe(0);
  });

  describe('clickable row accessibility', () => {
    it('exposes focus and a name (via row content) on clickable rows, keeping the native row role', () => {
      const { container } = render(
        <DataTable
          columns={columns}
          data={testData}
          keyExtractor={keyExtractor}
          onRowClick={() => {}}
        />
      );
      const row = container.querySelector('tbody tr') as HTMLTableRowElement;
      // No explicit role override — the row keeps its native (implicit) "row"
      // role rather than "button", so nested interactive cells (e.g. an actions
      // column) stay valid, reachable ARIA descendants instead of being nested
      // inside another interactive widget.
      expect(row.getAttribute('role')).toBeNull();
      expect(screen.getAllByRole('row').length).toBeGreaterThan(0);
      expect(row.getAttribute('tabindex')).toBe('0');
      expect(row.textContent).toContain('Alpha');
    });

    it('leaves non-clickable rows non-interactive', () => {
      const { container } = render(
        <DataTable columns={columns} data={testData} keyExtractor={keyExtractor} />
      );
      const row = container.querySelector('tbody tr') as HTMLTableRowElement;
      expect(row.getAttribute('tabindex')).toBeNull();
    });

    it('activates on Enter', () => {
      const handleClick = vi.fn();
      const { container } = render(
        <DataTable columns={columns} data={testData} keyExtractor={keyExtractor} onRowClick={handleClick} />
      );
      const row = container.querySelector('tbody tr') as HTMLTableRowElement;
      fireEvent.keyDown(row, { key: 'Enter' });
      expect(handleClick).toHaveBeenCalledTimes(1);
      expect(handleClick).toHaveBeenCalledWith(testData[0]);
    });

    it('activates on Space and prevents the default scroll', () => {
      const handleClick = vi.fn();
      const { container } = render(
        <DataTable columns={columns} data={testData} keyExtractor={keyExtractor} onRowClick={handleClick} />
      );
      const row = container.querySelector('tbody tr') as HTMLTableRowElement;
      const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      row.dispatchEvent(event);
      expect(handleClick).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('does not activate for unrelated keys', () => {
      const handleClick = vi.fn();
      const { container } = render(
        <DataTable columns={columns} data={testData} keyExtractor={keyExtractor} onRowClick={handleClick} />
      );
      const row = container.querySelector('tbody tr') as HTMLTableRowElement;
      fireEvent.keyDown(row, { key: 'a' });
      expect(handleClick).not.toHaveBeenCalled();
    });

    it('activates exactly once via mouse click even with a nested button, and does not fire the row handler from the nested button', () => {
      const handleRowClick = vi.fn();
      const handleButtonClick = vi.fn();
      const columnsWithButton = [
        { key: 'name', label: 'Name' },
        {
          key: 'actions',
          label: '',
          render: () => (
            <button type="button" onClick={handleButtonClick}>
              Action
            </button>
          ),
        },
      ];
      render(
        <DataTable
          columns={columnsWithButton}
          data={[testData[0]!]}
          keyExtractor={keyExtractor}
          onRowClick={handleRowClick}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Action' }));
      expect(handleButtonClick).toHaveBeenCalledTimes(1);
      expect(handleRowClick).not.toHaveBeenCalled();
    });

    it('does not activate the row when Enter is pressed on a nested button', () => {
      const handleRowClick = vi.fn();
      const columnsWithButton = [
        { key: 'name', label: 'Name' },
        {
          key: 'actions',
          label: '',
          render: () => <button type="button">Action</button>,
        },
      ];
      render(
        <DataTable
          columns={columnsWithButton}
          data={[testData[0]!]}
          keyExtractor={keyExtractor}
          onRowClick={handleRowClick}
        />
      );
      fireEvent.keyDown(screen.getByRole('button', { name: 'Action' }), { key: 'Enter' });
      expect(handleRowClick).not.toHaveBeenCalled();
    });

    it('still activates the row on click of a non-interactive cell when a nested button is present', () => {
      const handleRowClick = vi.fn();
      const columnsWithButton = [
        { key: 'name', label: 'Name' },
        {
          key: 'actions',
          label: '',
          render: () => <button type="button">Action</button>,
        },
      ];
      render(
        <DataTable
          columns={columnsWithButton}
          data={[testData[0]!]}
          keyExtractor={keyExtractor}
          onRowClick={handleRowClick}
        />
      );
      fireEvent.click(screen.getByText('Alpha'));
      expect(handleRowClick).toHaveBeenCalledTimes(1);
    });
  });

  it('renders custom cell content via render function', () => {
    const columnsWithRender = [
      { key: 'name', label: 'Name' },
      {
        key: 'value',
        label: 'Value',
        render: (row: TestRow) => <strong data-testid="custom">{row.value * 2}</strong>,
      },
    ];

    render(
      <DataTable
        columns={columnsWithRender}
        data={[testData[0]!]}
        keyExtractor={keyExtractor}
      />
    );

    const custom = screen.getByTestId('custom');
    expect(custom.textContent).toBe('20');
  });

  describe('sortable headers', () => {
    const sortableColumns = [
      { key: 'name', label: 'Name' },
      { key: 'value', label: 'Value', sortable: true },
    ];

    it('renders a header button and calls onSortChange with the column key', () => {
      const onSortChange = vi.fn();
      const { container } = render(
        <DataTable
          columns={sortableColumns}
          data={testData}
          keyExtractor={keyExtractor}
          sortBy={null}
          onSortChange={onSortChange}
        />
      );
      const btn = container.querySelector('thead button') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toContain('Value');
      fireEvent.click(btn);
      expect(onSortChange).toHaveBeenCalledWith('value');
    });

    it('sets aria-sort on the th for the active column', () => {
      const { container, rerender } = render(
        <DataTable
          columns={sortableColumns}
          data={testData}
          keyExtractor={keyExtractor}
          sortBy="value"
          sortOrder="asc"
          onSortChange={() => {}}
        />
      );
      const ths = container.querySelectorAll('th');
      expect(ths[0]!.getAttribute('aria-sort')).toBeNull();
      expect(ths[1]!.getAttribute('aria-sort')).toBe('ascending');

      rerender(
        <DataTable
          columns={sortableColumns}
          data={testData}
          keyExtractor={keyExtractor}
          sortBy="value"
          sortOrder="desc"
          onSortChange={() => {}}
        />
      );
      expect(container.querySelectorAll('th')[1]!.getAttribute('aria-sort')).toBe('descending');
    });

    it('renders a plain label when no onSortChange is provided', () => {
      const { container } = render(
        <DataTable
          columns={sortableColumns}
          data={testData}
          keyExtractor={keyExtractor}
        />
      );
      expect(container.querySelector('thead button')).toBeNull();
    });

    it('does not render a sort button for non-sortable columns', () => {
      const { container } = render(
        <DataTable
          columns={sortableColumns}
          data={testData}
          keyExtractor={keyExtractor}
          onSortChange={() => {}}
        />
      );
      expect(container.querySelectorAll('thead button').length).toBe(1);
    });
  });

  describe('column width and alignment', () => {
    it('a column with neither width nor align is byte-identical in class terms to before (no align class, no inline width)', () => {
      const { container } = render(
        <DataTable columns={columns} data={testData} keyExtractor={keyExtractor} />
      );
      const ths = container.querySelectorAll('th');
      const tds = container.querySelectorAll('tbody td');
      ths.forEach((th) => {
        expect(th.className).toBe('');
        expect(th.getAttribute('style')).toBeNull();
      });
      tds.forEach((td) => {
        expect(td.className).toBe('');
      });
    });

    it('renders the fixed width as an inline style on the <th> only', () => {
      const columnsWithWidth = [
        { key: 'name', label: 'Name', width: 240 },
        { key: 'value', label: 'Value' },
      ];
      const { container } = render(
        <DataTable columns={columnsWithWidth} data={testData} keyExtractor={keyExtractor} />
      );
      const th = container.querySelector('th')!;
      expect(th.style.width).toBe('240px');
      const td = container.querySelector('tbody td')!;
      expect(td.getAttribute('style')).toBeNull();
    });

    it('does not set an inline width when the column has none', () => {
      const { container } = render(
        <DataTable columns={columns} data={testData} keyExtractor={keyExtractor} />
      );
      const th = container.querySelector('th')!;
      expect(th.getAttribute('style')).toBeNull();
    });

    it('puts the align class on both the header and the cell for align: "right"', () => {
      const columnsWithAlign = [
        { key: 'name', label: 'Name' },
        { key: 'value', label: 'Value', align: 'right' as const },
      ];
      const { container } = render(
        <DataTable columns={columnsWithAlign} data={testData} keyExtractor={keyExtractor} />
      );
      const ths = container.querySelectorAll('th');
      const firstRowTds = container.querySelectorAll('tbody tr')[0]!.querySelectorAll('td');
      expect(ths[1]!.classList.contains(styles.alignRight!)).toBe(true);
      expect(firstRowTds[1]!.classList.contains(styles.alignRight!)).toBe(true);
      // The 'left' (default) column gets no align class either side
      expect(ths[0]!.className).toBe('');
      expect(firstRowTds[0]!.className).toBe('');
    });

    it('puts the align class on both the header and the cell for align: "center"', () => {
      const columnsWithAlign = [
        { key: 'name', label: 'Name', align: 'center' as const },
        { key: 'value', label: 'Value' },
      ];
      const { container } = render(
        <DataTable columns={columnsWithAlign} data={testData} keyExtractor={keyExtractor} />
      );
      const th = container.querySelector('th')!;
      const td = container.querySelector('tbody td')!;
      expect(th.classList.contains(styles.alignCenter!)).toBe(true);
      expect(td.classList.contains(styles.alignCenter!)).toBe(true);
    });

    it('applies the align class to skeleton cells while loading', () => {
      const columnsWithAlign = [
        { key: 'name', label: 'Name' },
        { key: 'value', label: 'Value', align: 'right' as const },
      ];
      const { container } = render(
        <DataTable columns={columnsWithAlign} data={[]} loading keyExtractor={keyExtractor} />
      );
      const firstSkeletonRowTds = container.querySelectorAll('tbody tr')[0]!.querySelectorAll('td');
      expect(firstSkeletonRowTds[1]!.classList.contains(styles.alignRight!)).toBe(true);
    });
  });
});
