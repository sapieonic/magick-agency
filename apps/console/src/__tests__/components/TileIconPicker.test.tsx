import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AGENCY_TILE_ICONS } from '@magick-agency/contracts/agency';
import { TILE_ICONS, TILE_ICON_KEYS, TILE_ICON_LABELS, TileIcon } from '@magick-agency/web-ui/components/TileIcon';
import { TileIconPicker } from '../../components/agency/TileIconPicker';

/**
 * The tile pictures (agent station BE-13): web-ui's one map (`TileIcon.tsx`) draws exactly the
 * contract's keys, and campaign Settings' picker offers every one of them and "No picture".
 */
describe('the tile picture map', () => {
  it('has exactly the contract’s keys, in its order, each with a picture and a name', () => {
    expect([...TILE_ICON_KEYS]).toEqual([...AGENCY_TILE_ICONS]);
    expect(Object.keys(TILE_ICONS).sort()).toEqual([...AGENCY_TILE_ICONS].sort());
    expect(Object.keys(TILE_ICON_LABELS).sort()).toEqual([...AGENCY_TILE_ICONS].sort());
    for (const key of AGENCY_TILE_ICONS) expect(TILE_ICON_LABELS[key].trim()).not.toBe('');
  });

  it('is the guard web-ui’s map names: the test file its comment points at exists, and is this one', () => {
    const source = readFileSync(resolve(__dirname, '../../../../../packages/web-ui/src/components/TileIcon.tsx'), 'utf-8');
    const named = [...source.matchAll(/`([^`\s]+\.test\.tsx?)`/g)].map((m) => m[1]!);
    expect(named).toEqual(['apps/console/src/__tests__/components/TileIconPicker.test.tsx']);
    expect(existsSync(__filename) && __filename.endsWith(named[0]!)).toBe(true);
  });

  it('draws nothing for a key it does not know', () => {
    const { container } = render(<><TileIcon icon="unicorn" /><TileIcon icon={null} /></>);
    expect(container.querySelector('svg')).toBeNull();
    render(<TileIcon icon="rupee" />);
    expect(document.querySelector('[data-tile-icon="rupee"]')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('TileIconPicker', () => {
  it('offers No picture and every picture, the current one checked', () => {
    render(<TileIconPicker value="clock" onChange={vi.fn()} name="Call later" />);
    const trigger = screen.getByRole('button', { name: 'Picture for Call later: Clock' });
    fireEvent.click(trigger);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(AGENCY_TILE_ICONS.length + 1);
    expect(radios[0]!.getAttribute('aria-label')).toBe('No picture');
    expect(screen.getByRole('radio', { name: 'Clock' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Clock' }));
  });

  it('reads a stored value it does not know as no picture', () => {
    render(<TileIconPicker value="retired" onChange={vi.fn()} name="Old" />);
    fireEvent.click(screen.getByRole('button', { name: 'Picture for Old: No picture' }));
    expect(screen.getByRole('radio', { name: 'No picture' }).getAttribute('aria-checked')).toBe('true');
  });

  it('picks with a click, and No picture is undefined; it then closes', () => {
    const onChange = vi.fn();
    render(<TileIconPicker value="clock" onChange={onChange} name="X" />);
    fireEvent.click(screen.getByRole('button', { name: /Picture for X/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Tea' }));
    expect(onChange).toHaveBeenLastCalledWith('tea');
    expect(screen.queryByRole('radiogroup')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Picture for X/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'No picture' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('moves with the arrow keys, and Escape closes it with focus back on the button', () => {
    render(<TileIconPicker value={undefined} onChange={vi.fn()} name="X" />);
    const trigger = screen.getByRole('button', { name: /Picture for X/ });
    fireEvent.click(trigger);
    const group = screen.getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Rupee' }));
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: TILE_ICON_LABELS[AGENCY_TILE_ICONS[6]] }));
    fireEvent.keyDown(group, { key: 'Escape' });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a click outside, choosing nothing', () => {
    const onChange = vi.fn();
    render(<div><TileIconPicker value={undefined} onChange={onChange} name="X" /><p>outside</p></div>);
    fireEvent.click(screen.getByRole('button', { name: /Picture for X/ }));
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
