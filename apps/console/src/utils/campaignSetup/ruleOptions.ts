import { plural } from '../format/number';

/*
  What the setup steps' rule sentences share: one select option, the minutes → words rule, and
  "keep a loaded value in the select" (a value that is not one of the choices is added in order,
  so opening a campaign never rewrites its rule).
*/

export interface RuleOption {
  value: string;
  label: string;
}

/** "15 minutes", "1 hour", "1 hour 30 minutes", "2 days"; a wait, rounded to a whole minute. */
export function delayLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m > 0 && m % 1440 === 0) return plural(m / 1440, 'day');
  if (m > 0 && m % 60 === 0) return plural(m / 60, 'hour');
  if (m > 60) return `${plural(Math.floor(m / 60), 'hour')} ${plural(m % 60, 'minute')}`;
  return plural(m, 'minute');
}

/** The choices as options, with `current` added in order when it is a number and not one of them. */
export function optionsOf(
  choices: readonly number[],
  current: number | null,
  label: (n: number) => string,
): RuleOption[] {
  const values = current === null || !Number.isFinite(current) || choices.includes(current)
    ? [...choices]
    : [...choices, current].sort((a, b) => a - b);
  return values.map((n) => ({ value: String(n), label: label(n) }));
}
