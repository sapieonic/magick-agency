import { ComposerSection } from '../components/ComposerSection';
import type { CampaignConfigState } from '../../../utils/agencyCampaignConfigForm';
import { useConfigFieldErrors } from './configFieldErrors';
import { CallingHoursFields } from './CallingHoursFields';
import { DispositionCatalogEditor } from './DispositionCatalogEditor';
import { RetryPolicyTable } from './RetryPolicyTable';
import { WrapupFields } from './WrapupFields';

/**
 * Campaign configuration: calling hours, the
 * disposition catalog, the retry policy and wrap-up.
 *
 * Every rule lives in `utils/agencyCampaignConfigForm.ts`. This file assembles
 * four editors — `CallingHoursFields`, `DispositionCatalogEditor`,
 * `RetryPolicyTable` and `WrapupFields` — around one set of field errors
 * (`configFieldErrors.tsx`), and the notes below are about the copy in them that
 * is itself the feature:
 *
 *  - **The built-in lock explains itself inline.** A lock icon with no reason
 *    reads as a permissions bug, and the reason is not "the server refuses" —
 *    the server deliberately does not enforce it. It is that removing one silently
 *    removes a capability the agent needs.
 *  - **`invalid` and `connected` are shown fixed at zero**, not hidden. Hiding
 *    them invites the operator to assume they retry.
 *  - **`agent_disconnected` and `canceled` are labelled "our fault"** (`canceled` came from the 2026-09-08 pilot) and share one callout
 *    saying the thing about them that
 *    is easy to get wrong: the row can only LOWER the API's platform bound, never
 *    raise it, and lowering it to 0 retires the contact on the first pre-connect
 *    failure rather than merely skipping a redial. `orphaned` is deliberately
 *    absent — the API never reads a campaign's value for it, so the row would be an
 *    inert control, which is the test `canceled` passes and it does not.
 *  - **Concurrency is displayed, never offered.** No input, no
 *    stepper, no Edit link — a greyed-out input reads as "you lack permission
 *    today" and produces a support ticket with no resolution.
 *
 * ── The outcome card ─────────────────────────────────────────────────────────
 * An outcome used to be a code box, a label box, and five bare checkboxes in a
 * wrapping row. Four things were wrong with it and each is answered here:
 *
 *  - **The flags described mechanisms, not behaviour.** "Ends this contact" and
 *    "Stops calling this contact" sat side by side as if they were the same
 *    setting worded twice. Each is now a tile carrying the sentence that says
 *    what it does, and the card closes with {@link dispositionSummary} — the
 *    combination stated as one sentence, the same argument as the calling-window
 *    echo. `suppress` + `terminal` together get {@link SUPPRESS_BEATS_TERMINAL_NOTE},
 *    because the API returns on the first and the second is then unreachable.
 *  - **The order was declared to matter and could not be changed.** The hint
 *    said this is the agent's number-key order; the only way to reorder was to
 *    delete an entry and retype it, and a built-in could not be deleted at all.
 *    The keycap now shows the key an agent presses and the arrows move it.
 *  - **The code was a jargon field asked twice.** It follows the label while it
 *    has not been edited by hand ({@link slugifyCode}), and on a built-in it is
 *    a locked chip rather than a `readOnly` input — a text box that refuses
 *    typing reads as a bug, not as a rule.
 *  - **A disposition's own retry had no control.** The retry table below says in
 *    so many words that voicemail retry "lives on the voicemail disposition, not
 *    in this table", and the default voicemail entry does carry a 4-hour, 2-try
 *    rule — which nothing on the screen showed and nothing could change, while
 *    `validateConfig` was already rendering errors for the field. It is offered
 *    here, and hidden behind the precedence note when `suppress` or `terminal`
 *    makes it unreachable rather than being shown as a control that does nothing.
 */

export type BehaviourSectionId = 'hours' | 'behaviour';

export interface CampaignBehaviourSectionProps {
  state: CampaignConfigState;
  onChange: (next: CampaignConfigState) => void;
  /** Keyed by body path — client findings and the server's `details` land alike. */
  fieldErrors: Record<string, string>;
  /** Injectable for tests; the echo is clock-derived. */
  now?: Date;
  /**
   * `sections` is the settings-page layout (titled cards). `plain` is the
   * builder step body — the page already supplies the title.
   */
  layout?: 'sections' | 'plain';
  /** Which editors to render. Defaults to both, so the settings page is unchanged. */
  include?: readonly BehaviourSectionId[];
}

export function CampaignBehaviourSection({
  state,
  onChange,
  fieldErrors,
  now,
  layout = 'sections',
  include = ['hours', 'behaviour'],
}: CampaignBehaviourSectionProps) {
  const errors = useConfigFieldErrors(fieldErrors);
  const showHours = include.includes('hours');
  const showBehaviour = include.includes('behaviour');

  const hours = (
    <CallingHoursFields
      window={state.window}
      onChange={(nextWindow) => onChange({ ...state, window: nextWindow })}
      errors={errors}
      now={now}
    />
  );

  const behaviour = (
    <>
      <DispositionCatalogEditor
        dispositions={state.dispositions}
        onChange={(dispositions) => onChange({ ...state, dispositions })}
        errors={errors}
      />
      <RetryPolicyTable
        retryPolicy={state.retryPolicy}
        onChange={(retryPolicy) => onChange({ ...state, retryPolicy })}
        errors={errors}
      />
      <WrapupFields
        wrapupSeconds={state.wrapupSeconds}
        autoReturn={state.autoReturn}
        onChange={(patch) => onChange({ ...state, ...patch })}
        errors={errors}
      />
    </>
  );

  if (layout === 'plain') {
    return (
      <>
        {showHours ? hours : null}
        {showBehaviour ? behaviour : null}
      </>
    );
  }

  return (
    <>
      {showHours ? (
        <ComposerSection
          title="Calling hours"
          helper="When this campaign is allowed to dial."
        >
          {hours}
        </ComposerSection>
      ) : null}
      {showBehaviour ? (
        <ComposerSection
          title="Behaviour"
          helper="Outcomes agents can pick, how retries work, and wrap-up."
        >
          {behaviour}
        </ComposerSection>
      ) : null}
    </>
  );
}
