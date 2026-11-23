import { fireEvent, screen, within } from '@testing-library/react';

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

/** The Settings page's tabs (the four setup steps, CS1), by their step id. */
export const SETTINGS_TABS = {
  basics: 'Name & number',
  contacts: 'Customers',
  purpose: 'Purpose & buttons',
  agents: 'Agents & timing',
} as const;

export type SettingsTab = keyof typeof SETTINGS_TABS;

/** A tab by its title; its name may go on with ", needs fixing" or ", unsaved changes". */
export function settingsTab(tab: SettingsTab): HTMLElement {
  return screen.getByRole('tab', { name: (name) => name.startsWith(SETTINGS_TABS[tab]) });
}

/** Open a tab as a person would, by clicking it. */
export function openTab(tab: SettingsTab): void {
  fireEvent.click(settingsTab(tab));
}

/** The tab on screen, by its step id. */
export function currentTab(): SettingsTab | undefined {
  return (Object.keys(SETTINGS_TABS) as SettingsTab[]).find(
    (tab) => settingsTab(tab).getAttribute('aria-selected') === 'true',
  );
}

/** A tab's panel. */
export function tabPanel(tab: SettingsTab): HTMLElement {
  return document.getElementById(`campaign-settings-panel-${tab}`)!;
}

/** Agents & timing's "Advanced settings" fold. */
export function agentsAdvanced(): HTMLDetailsElement {
  return within(tabPanel('agents')).getByTestId('advanced-settings') as HTMLDetailsElement;
}

/** Open Agents & timing and its Advanced fold, as a person would. */
export function openAgentsAdvanced(): void {
  if (settingsTab('agents').getAttribute('aria-selected') !== 'true') openTab('agents');
  const fold = agentsAdvanced();
  if (!fold.open) fireEvent.click(fold.querySelector('summary')!);
}

/** A caller ID's card, by its number (the cards show it spaced, `+91 22000 00001`). */
export function callerIdBox(e164: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name: (name) => name.replace(/\s/g, '').includes(e164) }) as HTMLInputElement;
}

/** As {@link callerIdBox}, or `null` when the number is not offered. */
export function queryCallerIdBox(e164: string): HTMLInputElement | null {
  return screen.queryByRole('checkbox', { name: (name) => name.replace(/\s/g, '').includes(e164) }) as HTMLInputElement | null;
}

/** Whether a caller ID's card is locked (its group is a disabled fieldset). */
export function callerIdLocked(e164: string): boolean {
  return callerIdBox(e164).closest('fieldset')?.disabled ?? false;
}
