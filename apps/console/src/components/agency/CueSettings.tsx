import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ConnectFlashSetting } from '../../utils/agencyCues';
import type { CuePrefs } from '../../utils/agencyCuePrefs';
import styles from './CueSettings.module.css';

/**
 * `Sound & flash ▾` — the settings surface for the cue preferences.
 *
 * ── Why this had to exist ─────────────────────────────────────────────────────
 * `escalatedVisualActive` has read a volume and a `ConnectFlashSetting` since
 * an earlier change and **nothing set either.** So the visual escalation was reachable
 * only by accident — an `AudioContext` the browser happened to refuse — and a deaf
 * agent had no way to turn on the one channel built for them. A preference that is
 * read and never written is not a feature with a missing UI; it is a feature that
 * does not exist.
 *
 * ── The label discloses nothing ───────────────────────────────────────────────
 * "Sound & flash", filed under display, alongside no explanation of who might want
 * it. is explicit: an agent who needs *Always* sets it in two clicks
 * **without telling their employer anything about themselves.** Calling this
 * "Accessibility" would make using it a disclosure, and an agent who does not want
 * to disclose would go without the channel instead.
 *
 * ── Keyboard first, because the console has a no-mouse requirement ────────────
 * applies to a new popover exactly as it applies to `Break`: the trigger is
 * a real button in the tab order, `Enter`/`Space`/`ArrowDown` open it from the
 * keyboard, `Esc` closes it and **returns focus to the trigger** (a popover that
 * drops focus to `<body>` strands a keyboard agent at the top of the document), and
 * the controls inside are native radios and a native range input — arrow-key
 * operable and screen-reader-legible without a line of ARIA emulation.
 *
 * `onKeyDown` on the trigger is deliberate belt-and-braces next to the browser's
 * implicit Enter→click: it is also what makes the keyboard path *testable*, since a
 * synthesised `keydown` does not produce a click.
 *
 * Not modal, and no focus trap. This is the APG disclosure shape rather than
 * `Break`'s `role="menu"`: focus leaving the popover closes it, which is what a
 * `Tab` off the last control means. Trapping would be the wrong answer here — an
 * agent tabbing away mid-shift is going back to work, not asking to be held.
 */

export interface CueSettingsProps {
  prefs: CuePrefs;
  onChange: (next: CuePrefs) => void;
}

/**
 * The three settings, in the order an agent scans them: the one that means "I
 * cannot hear these" first, the default in the middle, the opt-out last.
 *
 * The copy names **what the agent gets**, never what we assume about them.
 * "Always" does not say "for deaf agents"; it says the flash always shows.
 */
const FLASH_OPTIONS: ReadonlyArray<{
  value: ConnectFlashSetting;
  label: string;
  hint: string;
}> = [
  {
    value: 'always',
    label: 'Always show the flash',
    hint: 'Every ring, connect and hang-up flashes on the rail.',
  },
  {
    value: 'auto',
    label: 'Only when I can’t hear the sound',
    hint: 'Flashes when the volume is at 0 or this browser blocks sound.',
  },
  {
    value: 'never',
    label: 'Never show the flash',
    hint: 'Sound only.',
  },
];

export function CueSettings({ prefs, onChange }: CueSettingsProps) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    // every transient surface returns focus to the control that opened it.
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Focus the first control on open, so the keyboard lands *inside* rather than
  // on a container the arrow keys do nothing to.
  useEffect(() => {
    if (!open) return;
    firstFieldRef.current?.focus();
  }, [open]);

  // Viewport clamping by measurement,  — pure-CSS placement clips at
  // the edge of the header, which is exactly where this popover lives.
  useEffect(() => {
    if (!open) return undefined;

    const reposition = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;

      const tRect = trigger.getBoundingClientRect();
      const pRect = popover.getBoundingClientRect();
      const pad = 8;

      // Prefer below: the trigger is in the header, at the top of the console.
      const below = tRect.bottom + pRect.height + 8 <= window.innerHeight - pad;
      const top = below ? tRect.bottom + 8 : Math.max(pad, tRect.top - pRect.height - 8);

      let left = tRect.left;
      if (left + pRect.width > window.innerWidth - pad) {
        left = window.innerWidth - pad - pRect.width;
      }
      if (left < pad) left = pad;

      setPopoverStyle({ position: 'fixed', top: `${top}px`, left: `${left}px` });
    };

    const frame = requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  // A click away says the same thing `Esc` says.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div
      className={styles.wrap}
      onBlur={(event) => {
        // Focus left the popover entirely: close, without moving focus, because the
        // agent is on their way somewhere. `relatedTarget` is null when focus went
        // to `<body>` (a click on dead space), which counts as leaving.
        if (!open) return;
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        Sound &amp; flash
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className={styles.popover}
          style={popoverStyle}
          role="dialog"
          aria-label="Sound and flash"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            close(true);
          }}
        >
          {/*
            A real `fieldset`/`legend` and real radios. The group is one tab stop
            with arrow keys inside it and announces as "Flash on call events, 1 of
            3" — none of which a div-with-role reproduces for free.
          */}
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Flash on call events</legend>
            {FLASH_OPTIONS.map((option, index) => (
              <label key={option.value} className={styles.option}>
                <input
                  ref={index === 0 ? firstFieldRef : undefined}
                  type="radio"
                  name="agency-connect-flash"
                  value={option.value}
                  checked={prefs.connectFlash === option.value}
                  aria-describedby={`agency-connect-flash-${option.value}-hint`}
                  onChange={() => onChange({ ...prefs, connectFlash: option.value })}
                />
                <span className={styles.optionText}>
                  {option.label}
                  <span
                    id={`agency-connect-flash-${option.value}-hint`}
                    className={styles.optionHint}
                  >
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className={styles.volume}>
            <label className={styles.volumeLabel} htmlFor="agency-cue-volume">
              Cue volume
            </label>
            <input
              id="agency-cue-volume"
              type="range"
              min={0}
              max={100}
              step={5}
              value={prefs.volume}
              // The number, not the raw 0–100 position: a screen reader would
              // otherwise read "70" with no unit, and 0 is a meaningful setting
              // that needs to read as one.
              aria-valuetext={prefs.volume === 0 ? 'Off' : `${prefs.volume} percent`}
              aria-describedby="agency-cue-volume-hint"
              onChange={(event) => onChange({ ...prefs, volume: Number(event.target.value) })}
            />
            <output className={styles.volumeValue} htmlFor="agency-cue-volume">
              {prefs.volume === 0 ? 'Off' : `${prefs.volume}%`}
            </output>
            {/*
              0% is a permitted setting, not an error — an agent may work
              in silence and the console's job is to make that safe rather than to
              argue with them. What it must not do is let them reach silence without
              knowing the flash is what is left.
            */}
            <p id="agency-cue-volume-hint" className={styles.volumeHint}>
              {prefs.volume > 0
                ? 'Ring, connect and hang-up cues.'
                : prefs.connectFlash === 'never'
                  ? // Silence plus Never is zero channels, and the agent is allowed
                    // to choose it — but not by accident, and not without being told
                    // in the one place where both controls are in front of them.
                    'Cues are silent and the flash is off — nothing will signal a call.'
                  : 'Cues are silent. The rail flash is your only call signal.'}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
