import { fireEvent, screen } from '@testing-library/react';

/**
 * Save the campaign Settings form as a person would. Save sits in the unsaved-changes bar,
 * which shows only once something differs from what is saved, so a test that saves a form it
 * has not otherwise edited first touches the name with a trailing space: a change on screen,
 * and nothing in what is sent (the name is trimmed on save).
 */
export function saveSettings(): void {
  if (!screen.queryByRole('button', { name: /save changes/i })) {
    const name = screen.getByLabelText(/campaign name/i) as HTMLInputElement;
    fireEvent.change(name, { target: { value: `${name.value} ` } });
  }
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
}
