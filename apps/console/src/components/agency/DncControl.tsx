import { useImperativeHandle, useState, type RefObject } from 'react';
import { ConfirmDialog } from '../common/ConfirmDialog';
import {
  DNC_BLOCK_COPY,
  DNC_CAMPAIGN_ACTION_LABEL,
  DNC_CONFIRM_TITLE,
  DNC_TENANT_ACTION_LABEL,
  dncBlockReason,
  dncCampaignConfirmMessage,
  dncTenantConfirmHint,
  type DncScope,
} from '../../utils/agencyDncCopy';
import styles from './DncControl.module.css';

/**
 * Mark DNC (§A.7.5, `AD-P3-U-03`).
 *
 * **This one does warrant a modal**, and it is the only agent action that does:
 * it is rare, irreversible from the console, and compliance-bearing. Every other
 * confirmation on this screen is a hold or a second key press, because those
 * actions happen dozens of times a shift and a dialog would cost more than it
 * protects.
 *
 * ── Two promises, not one ─────────────────────────────────────────────────────
 * A mark used to be a single tenant-wide action. It is now a choice: the default
 * button scopes the mark to the campaign the agent is on ("take me off your
 * list" almost always means *this* campaign), and a second, harder-to-reach
 * button escalates to tenant-wide — "never call me again" — gated behind
 * `permittedTenantWide` (`agency.dnc.manage`, floored at `account_admin`) so an
 * agent who cannot manage the DNC list as a whole never sees the wider control.
 * Hiding that escalation must never disable the campaign-scoped default — the
 * two are independent choices, not tiers of one permission.
 *
 * The dialog states each option's scope with the number in it, before the agent
 * commits to either.
 */

export interface DncControlProps {
  /** Null when there is no live attempt — the same condition as "not yours". */
  attemptId: string | null;
  phoneE164: string | null;
  /** Names the default option's scope; null renders a generic fallback. */
  campaignName: string | null;
  permitted: boolean;
  /** Gates the tenant-wide escalation only; the campaign-scoped default ignores it. */
  permittedTenantWide: boolean;
  inFlight: boolean;
  /** `origin` is analytics-only: which control opened the dialog that led here. */
  onConfirm: (scope: DncScope, origin: 'shortcut' | 'click') => void;
  /** Lets the console's `D` shortcut open the same dialog the button opens. */
  handleRef?: RefObject<DncControlHandle | null>;
  /** Set when a mark failed; rendered inline, never as a toast. */
  failure?: string | null;
  /** Set once a mark landed; the copy is scoped to what the response promised. */
  outcome?: string | null;
}

export interface DncControlHandle {
  open: () => void;
}

export function DncControl({
  attemptId,
  phoneE164,
  campaignName,
  permitted,
  permittedTenantWide,
  inFlight,
  onConfirm,
  handleRef,
  failure = null,
  outcome = null,
}: DncControlProps) {
  const [open, setOpen] = useState(false);
  /** Which control opened the dialog currently showing — analytics-only. */
  const [origin, setOrigin] = useState<'shortcut' | 'click'>('click');

  const block = dncBlockReason({
    hasLiveAttempt: attemptId !== null,
    permitted,
    inFlight,
  });

  /**
   * The `D` shortcut opens the same dialog the button opens — one state
   * machine, so the key and the pointer cannot disagree about whether the
   * dialog is up. The shortcut is refused under exactly the conditions that
   * disable the button.
   */
  useImperativeHandle(
    handleRef,
    () => ({
      open: () => {
        if (block !== null) return;
        setOrigin('shortcut');
        setOpen(true);
      },
    }),
    [block],
  );

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        onClick={() => {
          setOrigin('click');
          setOpen(true);
        }}
        disabled={block !== null}
        data-testid="dnc-button"
      >
        {/* The trigger is short; the dialog spells it out. They are also
            deliberately not the same string — two controls with one accessible
            name is a screen-reader user hearing "Mark Do Not Call" twice and
            not knowing which one commits. */}
        Mark DNC
        <span className={styles.shortcut} aria-hidden="true">
          D
        </span>
      </button>

      {/* A disabled control always carries its stated reason (house rule): a
          bare greyed button on this screen reads as a permissions failure. */}
      {block ? (
        <span className={styles.reason} data-testid="dnc-disabled-reason">
          {DNC_BLOCK_COPY[block]}
        </span>
      ) : null}

      {failure ? (
        <span className={styles.failure} role="alert" data-testid="dnc-failure">
          {failure}
        </span>
      ) : null}

      {outcome ? (
        <span className={styles.outcome} data-testid="dnc-outcome">
          {outcome}
        </span>
      ) : null}

      <ConfirmDialog
        open={open && block === null}
        title={DNC_CONFIRM_TITLE}
        // `??` alone let an empty string through, rendering "…won’t be called
        // again by . Other campaigns…" — and the campaign name is the only thing
        // distinguishing this promise from the tenant-wide one. A blank or
        // whitespace-only name falls back to the generic wording instead.
        message={dncCampaignConfirmMessage(
          phoneE164 ?? 'This number',
          campaignName?.trim() ? campaignName : 'this campaign',
        )}
        confirmLabel={DNC_CAMPAIGN_ACTION_LABEL}
        onConfirm={() => {
          setOpen(false);
          onConfirm('campaign', origin);
        }}
        onCancel={() => setOpen(false)}
        // The tenant-wide escalation exists only for a role that can manage the
        // DNC list as a whole (`agency.dnc.manage`). Omitting both props when it
        // is not permitted is what makes it absent rather than merely disabled —
        // an agent who cannot use it should not know it exists.
        secondaryLabel={permittedTenantWide ? DNC_TENANT_ACTION_LABEL : undefined}
        secondaryHint={permittedTenantWide ? dncTenantConfirmHint(phoneE164 ?? 'This number') : undefined}
        onSecondary={
          permittedTenantWide
            ? () => {
                setOpen(false);
                onConfirm('tenant', origin);
              }
            : undefined
        }
      />
    </span>
  );
}
