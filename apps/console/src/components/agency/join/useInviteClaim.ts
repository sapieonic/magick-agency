import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type InviteCredential } from '../../../contexts/AuthContext';
import { useTenant } from '../../../contexts/TenantContext';
import { getInvite, InviteIdentityInUseError, InviteUnavailableError } from '../../../api/invites';
import type { AgencyInvite, InviteUnavailableStatus } from '../../../types/invite';
import type { EventCatalog } from '../../../analytics/events';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import {
  analyticsRole,
  assessPassword,
  credentialMessage,
  firebaseCode,
  sameAddress,
} from '../../../utils/agencyInviteJoinCopy';
import { invitedTenantId } from '../../../utils/invitedTenant';
import { joinDoorFor, joinPathFor, type JoinDoor } from './joinDoor';
import type { JoinPending } from './joinPending';

/**
 * The invite claim, as one state machine both join pages run.
 *
 * ── Why a hook, and why both pages must share it ───────────────────────────
 * This was `AgencyJoinPage`'s body. When every role started getting a token and
 * `/join/:token` was added for the non-agent ones, the page around the claim had
 * to change and the claim itself did not — and the claim is where every hard-won
 * fix on that page lives: the sign-out on leaving with an unclaimed credential,
 * `claimSent` going up before the await, the lookup sequence counter, the
 * mismatch screen surviving `identity_in_use`, `replace` on the way out. A copy
 * of it in a second page would be a second place for each of those to be undone,
 * and nothing would notice the two drifting until one of them stranded somebody.
 * So both pages call this, and differ only in what they render around it and in
 * the three things passed in: which door they are, where a claim lands, and which
 * analytics family they report to.
 *
 * Everything below is described in terms of "the page" — whichever one is on
 * screen.
 */

/** The state of the invite lookup. Kept as one value so no render can show a
 *  half-resolved page — a skeleton and an outcome are never both true. */
export type Lookup =
  | { phase: 'loading' }
  | { phase: 'invite'; invite: AgencyInvite }
  | { phase: 'unavailable'; status: InviteUnavailableStatus }
  | { phase: 'unreachable'; message: string };

/**
 * The five funnel events, as one page's family.
 *
 * Passed in rather than imported here, so each page names its own family in its
 * own source — `agency_invite_*` for the agent's door, `workspace_invite_*` for
 * everyone else's — and neither page's module graph (or test mock) depends on the
 * other's. The two families share their property shapes in the catalog, which is
 * what lets one type describe both.
 */
export interface InviteJoinEvents {
  viewed: (props: EventCatalog['agency_invite_viewed']) => void;
  claimAttempted: (props: EventCatalog['agency_invite_claim_attempted']) => void;
  claimSucceeded: (props: EventCatalog['agency_invite_claim_succeeded']) => void;
  claimFailed: (props: EventCatalog['agency_invite_claim_failed']) => void;
  addressMismatch: (props: EventCatalog['agency_invite_address_mismatch']) => void;
}

export interface InviteClaimOptions {
  token: string;
  /** Which page this is. Decides which invitations it serves and which it forwards. */
  door: JoinDoor;
  /** Where a claimed invitation lands. Always navigated to with `replace`. */
  destination: string;
  /** A module-level constant in each page, so the callbacks below stay stable. */
  events: InviteJoinEvents;
}

/**
 * What the page that forwards a wrong-door link hands the page it forwards to.
 *
 * ── Why the invitation travels with the redirect ───────────────────────────
 * The forwarding page has just read the invitation — that is how it learned the
 * role belonged on the other door — and the receiving page would otherwise read
 * the same token again a moment later. That is one more call to a public endpoint
 * rate-limited per IP, and a second skeleton flash on the one page somebody sees
 * exactly once. Router state rather than a module cache, because it is scoped to
 * the history entry it was written for and nothing else can read it.
 *
 * It is a HINT and is checked like one ({@link readHandoff}): taken only for the
 * same token, and only when its role belongs on the receiving door — so a state
 * entry that does not fit is ignored and the page reads the invitation itself, and
 * no pairing of entries can bounce a visitor between the two pages. History state
 * survives a reload, so a reloaded page can render a pending invitation that has
 * since been claimed elsewhere; the claim then answers 409 and the page switches
 * to that status's screen, which is the same path a second tab winning the race
 * takes.
 */
interface InviteHandoff {
  inviteHandoff: { token: string; invite: AgencyInvite };
}

function readHandoff(state: unknown, token: string, door: JoinDoor): AgencyInvite | null {
  if (typeof state !== 'object' || state === null) return null;
  const handoff = (state as Partial<InviteHandoff>).inviteHandoff;
  if (typeof handoff !== 'object' || handoff === null) return null;
  if (handoff.token !== token) return null;
  const invite = handoff.invite;
  if (typeof invite !== 'object' || invite === null || typeof invite.email !== 'string') return null;
  return joinDoorFor(invite.role) === door ? invite : null;
}

export function useInviteClaim({ token, door, destination, events }: InviteClaimOptions) {
  const navigate = useNavigate();
  const location = useLocation();
  const { establishInviteCredential, claimInvite, logout } = useAuth();
  const { setActiveTenantId } = useTenant();

  const seed = useMemo(
    () => readHandoff(location.state, token, door),
    [location.state, token, door],
  );

  const [lookup, setLookup] = useState<Lookup>(() =>
    seed ? { phase: 'invite', invite: seed } : { phase: 'loading' },
  );
  const [showPassword, setShowPassword] = useState(false);
  const [existing, setExisting] = useState(false);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<JoinPending>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The way onward from the error, when the error has one.
   *
   * Only `identity_in_use` sets it today: the server refuses that claim because the
   * Google account already belongs to a different user row here, and its advice
   * — "sign in with it directly" — is a page this app has and had no link to.
   * Kept beside `error` rather than folded into the message so the remedy is a
   * control rather than a sentence describing one.
   */
  const [errorAction, setErrorAction] = useState<'sign_in' | null>(null);
  const [mismatch, setMismatch] = useState<InviteCredential | null>(null);

  /** Clear both halves of the alert. Every action that can fail starts here. */
  const clearError = useCallback(() => {
    setError(null);
    setErrorAction(null);
  }, []);

  /**
   * The three facts the cleanup below needs, none of which anything renders from:
   * whether the page is still on screen, whether a Firebase credential exists
   * that no claim has spent, and whether a claim has been SENT.
   *
   * ── `claimSent`, not `claimed`, and it goes up BEFORE the await ───────────
   * It used to be assigned after `await claimInvite(token)` returned, which left
   * a window where the request was in flight and the page believed nothing had
   * been claimed. Anything unmounting in that window — the two `<Link>`s, a
   * back-navigation, a phone switching apps — ran the sign-out below against a
   * claim that was landing, so `logout()` raced the `adoptSession` that had just
   * bound the membership. What that leaves is a signed-out invitee whose invitation
   * is already spent, on a door telling them to use an account they were just
   * signed out of, holding a token they cannot use twice. So the flag goes up
   * when the claim is issued and comes back down only if it is REFUSED, which is
   * the one case where the credential is still ours to clean up.
   *
   * See {@link AuthContextValue.claimInvite} for why the claim is what ends the
   * join.
   */
  const mounted = useRef(true);
  const liveCredential = useRef(false);
  const claimSent = useRef(false);

  /**
   * Drop a credential that arrived after the visitor had already gone.
   *
   * The page's continuations outlive it: `establishInviteCredential` opens a
   * popup somebody can walk away from, and the promise resolves either way. A
   * credential landing on a page nobody is looking at has no claim coming, so it
   * is precisely the orphan the whole flow is about — and on the mismatched-
   * address path it would otherwise be left signed into Firebase with no page
   * left to clean it up.
   *
   * A failed sign-out is not silently fine, but it is not the page's problem
   * either: `AuthContext` keeps the join marker standing whenever `signOut`
   * rejects, so the credential stays suppressed everywhere and the next load in
   * this tab drops it. That backstop is what makes catching here honest rather
   * than a swallow.
   */
  const dropStrandedCredential = useCallback(() => {
    liveCredential.current = false;
    void logout().catch(() => { /* the marker outlives it — see `AuthContext` */ });
  }, [logout]);

  /**
   * Leaving the page with an unclaimed credential SIGNS OUT.
   *
   * ── The two ways off the page that used to strand one ─────────────────────
   * "Sign in instead" in the panel beside the card, and "Go to sign in" on a
   * terminal screen, are ordinary `<Link>`s: nothing stopped somebody taking
   * either while signed into Firebase as an account that had just failed the
   * address check. The credential outlives the page (Firebase persists it in
   * localStorage), the suppression that keeps the provider from syncing it does
   * not survive a full page load, and `POST /auth/session` provisions a tenant
   * for an address the server does not recognise — so walking away from the mismatch
   * screen produced the stray empty tenant this page exists to abolish, one
   * navigation later.
   *
   * This is the same act as the mismatch screen's "Use a different account",
   * applied to every other way out. `logout()` also clears the join marker, so
   * the tab is left in a state where the next page load is an ordinary one.
   *
   * Deliberately NOT run once a claim has been SENT — that credential is being
   * bound to a real membership — nor when nothing was ever established, which is
   * what makes it safe under StrictMode's mount/unmount/mount in development.
   *
   * ── `mounted` is what the continuations read ──────────────────────────────
   * A cleanup can only act on what exists when it runs, so on its own it misses
   * the entire window before it: leaving while `establishInviteCredential` is
   * still pending escapes it, and the promise then carries on into a claim and a
   * `navigate(destination)` for somebody who is no longer here. So every
   * continuation on the page checks this ref, and the ones that receive a
   * credential hand it to {@link dropStrandedCredential}. Assigned on mount
   * rather than only initialised, because StrictMode mounts, cleans up and mounts
   * again against the same refs.
   */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (claimSent.current || !liveCredential.current) return;
      dropStrandedCredential();
    };
  }, [dropStrandedCredential]);

  /** The `viewed` event for an invitation that is being shown. One place, because
   *  it is reached from a lookup and from a forwarded invitation alike. */
  const reportPending = useCallback(
    (invite: AgencyInvite) => {
      events.viewed({
        status: 'pending',
        role: analyticsRole(invite.role),
        has_inviter: invite.inviter_name !== null,
      });
    },
    [events],
  );

  /**
   * The lookup, and the guard that keeps a superseded one from landing.
   *
   * ── Why this is a counter and not a closed-over `alive` flag ───────────────
   * It was one, and the flag did not guard the case its own docstring claimed.
   * Each call to `load` created its own `alive`, and the ONLY thing that ever
   * flipped one was the effect's cleanup — while `load` is also passed to
   * `Unreachable` as `onRetry`, where the returned disposer is dropped on the
   * floor. So the first request's flag stayed `true` for the life of the page: a
   * slow first answer landing after a newer one overwrote it, which is exactly
   * the sentence the flag was there to make false. It turns a resolved invitation
   * into "We could not open your invitation" and fires the `viewed` event twice
   * for one visit.
   *
   * A ref shared by every invocation fixes it because the question is not "was MY
   * request cancelled" but "is my answer still the newest" — one fact, so one
   * place to keep it. Each call takes a sequence number and only the current one
   * may write. That also covers what the old comment was right about: StrictMode
   * mounts the effect twice in development, and the second load supersedes the
   * first rather than both landing.
   */
  const lookupSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++lookupSeq.current;
    setLookup({ phase: 'loading' });
    void getInvite(token)
      .then((result) => {
        if (seq !== lookupSeq.current) return;
        if (result.status === 'pending') {
          /*
            A link on the wrong door is FORWARDED, never rendered and never
            refused. The server picks the door when it builds the email, so this is
            a hand-edited URL, a link from before the doors split, or a client and
            server that disagree about a role — and in every one of those cases the
            invitation is fine and the page around it is wrong. Rendering it here
            would tell an operator about a station or an agent about a workspace
            shell; refusing it would strand a working invitation behind the wrong
            words. `replace`, so the back button does not return to a page whose
            only behaviour is to leave again.

            No `viewed` event here: the receiving page reports the view, so one
            visit is one view in exactly one funnel — the one its role belongs to.
          */
          const belongs = joinDoorFor(result.invite.role);
          if (belongs !== door) {
            const state: InviteHandoff = { inviteHandoff: { token, invite: result.invite } };
            navigate(joinPathFor(belongs, token), { replace: true, state });
            return;
          }
          setLookup({ phase: 'invite', invite: result.invite });
          reportPending(result.invite);
          return;
        }
        setLookup({ phase: 'unavailable', status: result.status });
        events.viewed({ status: result.status, role: null, has_inviter: false });
      })
      .catch((err: unknown) => {
        if (seq !== lookupSeq.current) return;
        setLookup({
          phase: 'unreachable',
          message: getErrorMessage(err, 'We could not read that invitation.'),
        });
        events.viewed({ status: 'unreachable', role: null, has_inviter: false });
      });
  }, [door, events, navigate, reportPending, token]);

  /**
   * Whether the forwarded invitation has been reported yet. A ref because
   * StrictMode runs the effect below twice against one instance, and one visit is
   * one `viewed` event however many times React mounts it.
   */
  const seedReported = useRef(false);

  useEffect(() => {
    if (seed) {
      // Already read by the page that forwarded it — see `InviteHandoff`.
      if (!seedReported.current) {
        seedReported.current = true;
        reportPending(seed);
      }
      return undefined;
    }
    load();
    // Unmounting supersedes whatever is still in flight, so a late answer cannot
    // set state on a page that is gone — and a remount (StrictMode, or a changed
    // token) starts from a number no in-flight request holds.
    return () => { lookupSeq.current += 1; };
  }, [load, reportPending, seed]);

  /**
   * Claim, then leave — with `replace`, which is load-bearing rather than tidy.
   *
   * The token in the URL is spent the instant this succeeds. Pushing onto the
   * history stack would leave it one back-navigation away, and a browser's back
   * button after a successful join is an ordinary thing to press: the invitee would
   * land on "This invitation has already been used" moments after it worked, on a
   * screen whose only affordance is a link to a sign-in page they no longer need.
   */
  const finishClaim = useCallback(
    async (method: 'create' | 'sign_in' | 'google', matched: boolean, invite: AgencyInvite) => {
      /*
        Recorded BEFORE the request, not after the answer. From this line on, the
        unmount cleanup must read this as a join being finished rather than as an
        abandoned credential: the claim may already have bound the membership, and
        signing out from underneath it is the race described where these refs are
        declared. Put back down if — and only if — the server refuses, because then
        nothing was spent and the credential is ours to clean up again.
      */
      claimSent.current = true;
      let session: Awaited<ReturnType<typeof claimInvite>>;
      try {
        session = await claimInvite(token);
      } catch (err) {
        claimSent.current = false;
        /*
          Refused, and nobody is here to be told: the cleanup has already run and
          declined to act, so this is the last chance to drop the credential
          rather than leave it signed into Firebase.
        */
        if (!mounted.current) dropStrandedCredential();
        throw err;
      }
      events.claimSucceeded({ method, address_matched: matched });
      /*
        The claim landed on a page the visitor has left. It is a real session and
        it stays — but navigating somebody who has gone elsewhere would be this
        page reaching out of its own life to move them, and so would switching the
        workspace under whatever they are looking at now.
      */
      if (!mounted.current) return;
      /*
        Land them in the workspace they just JOINED, not the one they were last
        in. The session lists every tenant the person belongs to and
        `TenantContext` restores whichever one this browser last had open — so
        somebody who already works elsewhere would accept this invitation and be
        put back in their old workspace. See `invitedTenantId` for how the tenant
        is recognised without the wire naming it, and why it sometimes declines to.
      */
      const tenantId = invitedTenantId(session, invite);
      if (tenantId) setActiveTenantId(tenantId);
      navigate(destination, { replace: true });
    },
    [claimInvite, destination, dropStrandedCredential, events, navigate, setActiveTenantId, token],
  );

  /** Turn a thrown value into the right screen. An invite that went terminal
   *  between the lookup and the claim is a state change, not an error under a
   *  form — the form can no longer succeed, so it stops being shown. */
  const handleFailure = useCallback(
    (err: unknown, method: 'create' | 'sign_in' | 'google') => {
      if (err instanceof InviteUnavailableError) {
        events.claimFailed({ method, reason: 'invite_unavailable' });
        setLookup({ phase: 'unavailable', status: err.status });
        return;
      }
      /*
        The server's `identity_in_use`: the account they signed in with already
        belongs to a different user row here. The INVITATION is untouched and
        another account still claims it, so this is a message under the options
        rather than a terminal screen — and it is the one failure on the page
        whose remedy is somewhere else, so it carries a link there. Without it a
        visitor was told to "sign in with it directly" on a page with nothing to
        press.
      */
      if (err instanceof InviteIdentityInUseError) {
        events.claimFailed({ method, reason: 'identity_in_use' });
        setError(err.message);
        setErrorAction('sign_in');
        return;
      }
      const code = firebaseCode(err);
      events.claimFailed({
        method,
        reason: code.startsWith('auth/') ? 'credential_error' : 'claim_error',
      });
      setError(credentialMessage(err));
      setErrorAction(null);
    },
    [events],
  );

  const invite = lookup.phase === 'invite' ? lookup.invite : null;
  const assessment = assessPassword(password, invite?.email ?? '');

  const handleGoogle = async () => {
    if (!invite) return;
    clearError();
    setPending('google');
    events.claimAttempted({ method: 'google' });
    try {
      const credential = await establishInviteCredential({ method: 'google' });
      liveCredential.current = true;
      /*
        The popup is a place people walk away from — a phone switching apps, a
        back-navigation, the "Sign in instead" link taken while it was open — and
        this promise resolves regardless. Nothing here can claim any more, so the
        credential that just arrived is dropped rather than left signed in behind
        a page that no longer exists.
      */
      if (!mounted.current) {
        dropStrandedCredential();
        return;
      }
      if (!sameAddress(credential.email, invite.email)) {
        /*
          Stop here. Everything up to this point is identical to the flow that
          silently produced a stray tenant; the difference is that this branch
          exists at all, so the claim waits for an answer.
        */
        events.addressMismatch({ outcome: 'shown' });
        setMismatch(credential);
        return;
      }
      await finishClaim('google', true, invite);
    } catch (err) {
      // Nothing was established, or the claim was refused after the visitor left:
      // `finishClaim` has already dealt with the credential, and there is no
      // longer a card to render a message in.
      if (!mounted.current) return;
      handleFailure(err, 'google');
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  const handleMismatchConfirm = async () => {
    if (!mismatch || !invite) return;
    clearError();
    setPending('confirm');
    events.addressMismatch({ outcome: 'confirmed' });
    try {
      await finishClaim('google', false, invite);
    } catch (err) {
      /*
        The confirmation STAYS on screen, and that is the fix rather than an
        omission. Clearing it here tore down `AddressMismatch` — and with it "Use
        a different account", the only control on the page that signs out — so a
        refused claim returned the visitor to the two options while Firebase still
        held the colliding account, where pressing Continue with Google
        re-selected it and failed identically. A loop with no exit, on the server's
        commonest claim conflict (`identity_in_use`, which is REACHABLE precisely
        because the page allows a mismatched address).

        Nothing needs clearing on the other branch either: an
        `InviteUnavailableError` replaces the whole card with that status's
        screen, which renders above this state and never reads it.
      */
      if (!mounted.current) return;
      handleFailure(err, 'google');
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  const handleMismatchDecline = async () => {
    clearError();
    setPending('decline');
    events.addressMismatch({ outcome: 'declined' });
    events.claimFailed({ method: 'google', reason: 'mismatch_declined' });
    try {
      /*
        The credential goes, not just the screen. Leaving the wrong Google account
        as the browser's current user means the next popup re-selects it without
        asking, and the way out lands them back where they started.
      */
      await logout();
    } catch {
      /* Signing out is best-effort; the screen must clear either way, or the only
         escape from the confirmation depends on the network. */
    }
    liveCredential.current = false;
    if (!mounted.current) return;
    setMismatch(null);
    setPending(null);
  };

  const handleCredentialSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!invite) return;
    clearError();
    const method = existing ? 'sign_in' : 'create';
    events.claimAttempted({ method });

    /*
      The strength rule applies only to a password being CREATED. Applied to a
      sign-in it would lock somebody out of a workspace over a password they
      already have and cannot change from here — a rule about future passwords
      enforced against a past one.
    */
    if (method === 'create' && assessment.blocker) {
      events.claimFailed({ method, reason: 'weak_password' });
      setError(assessment.blocker);
      return;
    }

    setPending(method);
    try {
      await establishInviteCredential({
        method,
        email: invite.email,
        password,
      });
      liveCredential.current = true;
      // Same as the Google path: a credential that lands after the visitor has
      // gone has no claim coming, so it is dropped rather than stranded.
      if (!mounted.current) {
        dropStrandedCredential();
        return;
      }
      /*
        `matched` is unconditionally true on this path: the address came from the
        read-only field, which came from the invite. That is the whole value of
        locking it.
      */
      await finishClaim(method, true, invite);
    } catch (err) {
      if (!mounted.current) return;
      if (firebaseCode(err) === 'auth/email-already-in-use') {
        /*
          Not a failure — somebody invited to a SECOND workspace, who already has
          a credential from the first. The form becomes a sign-in rather than a
          create, and the claim then attaches this membership to the account they
          already have. Reported to analytics all the same: it is a stumble in the
          flow, and how often it happens is how many people work across more than
          one workspace.
        */
        events.claimFailed({ method, reason: 'email_in_use' });
        setExisting(true);
        setPassword('');
        setError('That address already has a password. Enter it and we will add this workspace to it.');
      } else {
        handleFailure(err, method);
      }
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  return {
    lookup,
    /** The retry behind `Unreachable`. */
    load,
    showPassword,
    revealPassword: () => setShowPassword(true),
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
  };
}
