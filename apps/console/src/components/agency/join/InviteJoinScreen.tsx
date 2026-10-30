import { useParams } from 'react-router-dom';
import { Mail, type LucideIcon } from 'lucide-react';
import { formatDate } from '@magick-agency/web-ui/format';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { roleLabel } from '../../../utils/agencyInviteJoinCopy';
import { GoogleMark } from '../GoogleMark';
import { JoinCardHeader } from './JoinCardHeader';
import { Unavailable } from './Unavailable';
import { Unreachable } from './Unreachable';
import { AddressMismatch } from './AddressMismatch';
import { GuardedLink } from './GuardedLink';
import { CredentialForm } from './CredentialForm';
import { JOIN_DOORS, type JoinDoor } from './joinDoor';
import { useInviteClaim, type InviteJoinEvents } from './useInviteClaim';
import styles from './AgencyJoin.module.css';

/** One numbered step in the panel beside the card. */
export interface JoinStep {
  icon: LucideIcon;
  title: string;
  desc: string;
}

/**
 * The invitation card, its skeleton, its five outcomes and the steps beside it —
 * everything an invite page renders, for either door.
 *
 * ── Why the page body is shared as well as the claim ───────────────────────
 * The two pages differ in what they PROMISE (the steps panel, the eyebrow, the
 * terminal screens' sentences, which sign-in page they point at) and in nothing
 * they DO. Everything on the card is a decision made once about how an
 * invitation is presented — the address set apart, the read-only field, Google
 * ranked first, the one alert slot, the `ph-no-capture` boundary — and each of
 * those is a fix somebody had to find on the agency page first. Rendering the
 * card here means the workspace page has every one of them by construction, and
 * a sixth fix lands on both. What varies is passed in or read off the door
 * ({@link JOIN_DOORS}).
 */
export function InviteJoinScreen({
  door,
  destination,
  events,
  steps,
}: {
  door: JoinDoor;
  destination: string;
  events: InviteJoinEvents;
  /** What happens after they finish, in order — the page's own promise. */
  steps: readonly JoinStep[];
}) {
  const { token = '' } = useParams<{ token: string }>();
  const {
    lookup,
    load,
    showPassword,
    revealPassword,
    existing,
    password,
    setPassword,
    assessment,
    pending,
    error,
    errorAction,
    mismatch,
    handleGoogle,
    handleMismatchConfirm,
    handleMismatchDecline,
    handleCredentialSubmit,
  } = useInviteClaim({ token, door, destination, events });
  const { signInPath } = JOIN_DOORS[door];

  if (lookup.phase === 'loading') {
    return (
      <div className={styles.page}>
        <div className={styles.glow} />
        {/*
          A skeleton in the card's own shape rather than a bare spinner, and never
          a flash of the wrong state: the invitation and all five outcomes render
          in the same box, so anything that guessed before the answer arrived would
          be visibly replaced a moment later. The one thing this can honestly say
          before the lookup returns is that it is an invitation.

          It is also what stays on screen while a wrong-door link is forwarded
          (see `useInviteClaim`), so that redirect reads as one load, not two.
        */}
        <div className={styles.card} aria-busy="true">
          <JoinCardHeader door={door} />
          <div className={styles.skeleton}>
            <span className={styles.skelLine} style={{ width: '82%' }} />
            <span className={styles.skelLine} style={{ width: '64%' }} />
            <span className={styles.skelBlock} />
            <span className={styles.skelButton} />
          </div>
          <div className={styles.skeletonStatus}>
            <LoadingSpinner size="sm" />
            <span>Opening your invitation…</span>
          </div>
        </div>
      </div>
    );
  }

  if (lookup.phase === 'unavailable') {
    return (
      <div className={styles.page}>
        <div className={styles.glow} />
        <Unavailable status={lookup.status} door={door} />
      </div>
    );
  }

  if (lookup.phase === 'unreachable') {
    return (
      <div className={styles.page}>
        <div className={styles.glow} />
        <Unreachable message={lookup.message} onRetry={load} door={door} />
      </div>
    );
  }

  const { invite: pendingInvite } = lookup;

  return (
    <div className={styles.page}>
      <div className={styles.glow} />

      <div className={styles.layout}>
        {/*
          `ph-no-capture` — a security control on this card, not a preference.

          ── What was leaving the browser ────────────────────────────────────
          Autocapture, rage clicks and dead clicks are all on (`analytics/posthog.ts`),
          and posthog-js records the clicked element's own text. Everything this
          card renders is what the PII rule exists for: the invitee's address, the
          inviter's name, the workspace's name — and `capture_dead_clicks` means a
          click that does nothing at all, which on a page of static text is most of
          them, is captured too. The `before_send` redactor added alongside it
          removes invite TOKENS and nothing else; a name is not token-shaped, so
          `$elements[].$el_text` carried it out regardless.

          ── Why the class, and that it was checked rather than assumed ──────
          posthog-js walks the clicked element's ancestor chain, and a
          `ph-no-capture` anywhere in it sets `explicitNoCapture`, which makes the
          autocapture handler return before sending anything and reduces a dead
          click's properties to an empty bag. Read out of the build this repo pins
          rather than taken from the docs, and pinned in two places:
          `analytics/autocaptureOptOut.test.ts` watches the dependency, and each
          join page's own suite watches that the PII is inside the marked subtree.

          It is not the only line of defence, because it is a dependency's
          behaviour: `analytics/redact.ts`'s `stripJoinPageElements` takes the
          element payload off any capture made on either join route at the
          `before_send` boundary, which covers a click outside this card as well as
          a posthog-js that ever stops honouring the class.

          The whole card rather than the four PII elements inside it, because the
          rule "nothing on this card is capturable" survives somebody adding a
          fifth line to it and a per-element list does not. Nothing is lost from
          the funnel: every step of it is an explicit `*_invite_*` event with
          PII-free properties, and those are `posthog.capture` calls that this
          class does not touch.
        */}
        <div className={`${styles.card} ph-no-capture`}>
          <JoinCardHeader door={door} />

          {/*
            `product_name` is the server's, rendered rather than assembled: the
            agency's product for an agent, the brand for everyone else, and
            whitelabel-dependent either way. This client never decides it.
          */}
          <h1 className={styles.title}>
            You have been added to {pendingInvite.product_name}
          </h1>
          {/*
            Two independent absences, each dropping its own clause rather than
            filling it. `inviter_name` is null for a system or API invite;
            `tenant_name` is null whenever the server's tenant lookup came back empty
            — it sends `tenant?.name ?? null` on purpose, refusing to substitute
            a raw tenant UUID for a name at an unauthenticated caller. Typed as a
            plain string, this rendered "You have been set up as Agent at ." with
            an empty `<strong>` mid-sentence, on the one page in the product that
            most has to not look like phishing. There is nothing honest to put
            there — inventing "your workspace" would be this client asserting
            something the server declined to say — so the sentence simply ends.
          */}
          <p className={styles.lede}>
            {pendingInvite.inviter_name ? (
              <>
                <strong className={styles.strong}>{pendingInvite.inviter_name}</strong> has
                set you up as {roleLabel(pendingInvite.role)}
              </>
            ) : (
              <>You have been set up as {roleLabel(pendingInvite.role)}</>
            )}
            {pendingInvite.tenant_name ? (
              <> at <strong className={styles.strong}>{pendingInvite.tenant_name}</strong></>
            ) : null}.
          </p>

          {/*
            The invited address, set apart rather than folded into the sentence
            above. It is the identity being claimed and the thing the whole flow
            has historically got wrong, so it is shown once, plainly, where nobody
            can skim past it — and it is the same value the read-only field below
            carries.
          */}
          <p className={styles.address}>
            <Mail size={15} aria-hidden="true" />
            <span>{pendingInvite.email}</span>
          </p>

          {mismatch ? (
            <AddressMismatch
              signedInAs={mismatch.email ?? 'that Google account'}
              invitedAs={pendingInvite.email}
              onConfirm={handleMismatchConfirm}
              onDecline={handleMismatchDecline}
              pending={pending}
            />
          ) : (
            <>
              {/*
                Two options, deliberately unequal. Google is the primary because it
                is the shorter road and the one that needs no new secret; the
                password path is the reason this page exists at all — an invitee
                without a Google account had no way in before it — so it is one
                click away rather than hidden.
              */}
              <button
                type="button"
                className={styles.googleBtn}
                onClick={handleGoogle}
                disabled={pending !== null}
              >
                <GoogleMark />
                {pending === 'google' ? 'Waiting for Google…' : 'Continue with Google'}
              </button>

              {showPassword ? (
                <>
                  <div className={styles.divider}><span>or with a password</span></div>
                  <CredentialForm
                    invite={pendingInvite}
                    password={password}
                    onPasswordChange={setPassword}
                    assessment={assessment}
                    existing={existing}
                    pending={pending}
                    onSubmit={handleCredentialSubmit}
                  />
                </>
              ) : (
                <button
                  type="button"
                  className={styles.secondaryChoice}
                  onClick={revealPassword}
                  disabled={pending !== null}
                >
                  Create a password instead
                </button>
              )}
            </>
          )}

          {/*
            One alert slot for the whole card. `role="alert"` is an assertive live
            region, so a failure announces itself wherever focus happens to be —
            which on this page is routinely inside the password field, several
            elements above where the message renders.

            The link lives INSIDE the region so it is announced with the sentence
            that calls for it. It is the remedy for the server's `identity_in_use`
            refusal, whose own message ends "sign in with it directly" — advice
            this page previously gave with nothing to press.
          */}
          {error && (
            <div className={styles.errorText} role="alert">
              <span>{error}</span>
              {errorAction === 'sign_in' && (
                <>
                  <br />
                  <GuardedLink
                    to={signInPath}
                    className={styles.errorLink}
                    disabled={pending !== null}
                  >
                    Go to sign in
                  </GuardedLink>
                </>
              )}
            </div>
          )}

          <p className={styles.expiry}>
            This invitation stops working on {formatDate(pendingInvite.expires_at)}.
          </p>
        </div>

        {/*
          The steps sit BESIDE the card on a desktop and BELOW it on a phone
          — not hidden, which is what `/agency/login` does with its own left panel.
          The difference is what the panel carries: there it is a persona pitch a
          returning agent has read a hundred times, here it is the only answer to
          "what am I agreeing to?" on a page somebody sees exactly once, opened
          from an email on a phone as often as not.
        */}
        <aside className={styles.steps} aria-label="What happens next">
          <p className={styles.stepsHeading}>What happens next</p>
          <ol className={styles.stepList}>
            {steps.map(({ icon: Icon, title, desc }, index) => (
              <li key={title} className={styles.step}>
                <span className={styles.stepMark} aria-hidden="true">
                  <Icon size={16} />
                  <span className={styles.stepNumber}>{index + 1}</span>
                </span>
                <span>
                  <span className={styles.stepTitle}>{title}</span>
                  <span className={styles.stepDesc}>{desc}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className={styles.stepsFooter}>
            Already set up?{' '}
            <GuardedLink to={signInPath} disabled={pending !== null}>
              Sign in instead
            </GuardedLink>
          </p>
        </aside>
      </div>
    </div>
  );
}
