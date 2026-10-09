import posthog, { type CaptureResult } from 'posthog-js';
import { redactAnalyticsProperties, stripJoinPageElements } from './redact';

/**
 * Thin, fail-safe wrapper over posthog-js for frontend product analytics.
 *
 * Disabled by default: gated entirely on VITE_POSTHOG_KEY. When the key is
 * absent/empty, init is a no-op and every emitter is a cheap no-op — so dev
 * without a key just works and analytics can never break the app or the build.
 *
 * Identity model mirrors the backend (and auth scoping):
 *   distinct_id = user.id, groups `tenant` = tenant_id and `account` = account_id.
 * This unifies UI events and server events under one person/tenant/account.
 *
 * Uses the same PostHog project key as the backend services (the public
 * `phc_...` project API key — safe to ship in the browser).
 */

let enabled = false;

const isBrowser = (): boolean => typeof window !== 'undefined';

/**
 * The last thing that happens to an event before it leaves the browser.
 *
 * ── Why a boundary hook and not five careful call sites ────────────────────
 * posthog-js attaches `$current_url`, `$pathname` and `$host` to EVERY capture,
 * and `/agency/join/:token` is the one route in this app whose URL parameter is a
 * secret — a single-use invitation token that claims a membership for whoever
 * holds it. So the token rode in the envelope of the `$pageview`, of every
 * autocapture click, rage click and dead click, and of all five invite events,
 * including `agency_invite_viewed`, which fires while the invitation is still
 * pending. No call site could have prevented that: the properties this repo
 * writes never carried it, and the ones posthog-js writes are not ours to shape.
 * A hook here holds for captures nobody in this repo wrote — which is the whole
 * requirement. See `analytics/redact.ts`.
 *
 * `before_send` rather than the deprecated `sanitize_properties`, and it walks
 * `$set`/`$set_once` too: person properties carry `$initial_current_url`, which
 * would otherwise pin the token to a profile permanently.
 *
 * ── The token is not the only thing on that page ───────────────────────────
 * `/agency/join/:token` also renders the invitee's address, the inviter's name
 * and the workspace's name, and autocapture — with `capture_dead_clicks`, so a
 * click that does nothing counts — reads the clicked element's text off the DOM.
 * None of that is token-shaped, so the redaction above never touched it. The page
 * itself opts its card out of autocapture with `ph-no-capture`, which is the
 * primary fix; {@link stripJoinPageElements} is the second line here, for the
 * reasons its own docstring gives. Applied AFTER the token pass, so it can read
 * the (already redacted) route off the same properties.
 *
 * ── It fails CLOSED ────────────────────────────────────────────────────────
 * A throw drops the event rather than sending it unredacted. The redactor is pure
 * string work over a property bag and has no way to throw that is not a bug in
 * it; if one ever exists, losing an event is recoverable and publishing a live
 * invite token to everybody with PostHog read access is not.
 */
function redactBeforeSend(cr: CaptureResult | null): CaptureResult | null {
  if (!cr) return cr;
  try {
    return {
      ...cr,
      properties: stripJoinPageElements(redactAnalyticsProperties(cr.properties)),
      ...(cr.$set ? { $set: redactAnalyticsProperties(cr.$set) } : {}),
      ...(cr.$set_once ? { $set_once: redactAnalyticsProperties(cr.$set_once) } : {}),
    };
  } catch {
    return null;
  }
}

/** Initialize PostHog once at app bootstrap. Silent no-op when no key is set. */
export function initAnalytics(): void {
  if (enabled || !isBrowser()) return;

  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key) return; // disabled — no key configured

  try {
    posthog.init(key, {
      api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: true,
      // Friction signals: rage clicks (rapid repeated clicks on one element)
      // and dead clicks (clicks that produce no DOM/URL change) are captured
      // automatically by autocapture — surfaced as `$rageclick` / `$dead_click`.
      rageclick: true,
      capture_dead_clicks: true,
      disable_session_recording: true,
      // Strips the single-use invite token out of every capture, autocapture
      // included. See {@link redactBeforeSend} — this is a security control, not
      // a tidiness one.
      before_send: redactBeforeSend,
    });

    // Tag every event so staging/prod are distinguishable within one project,
    // consistent with the backend's `environment` super-property.
    posthog.register({
      environment: import.meta.env.VITE_POSTHOG_ENVIRONMENT || import.meta.env.MODE,
    });

    enabled = true;
  } catch {
    // Never let analytics init break the app.
    enabled = false;
  }
}

/** Whether init ran with a key. */
export function isEnabled(): boolean {
  return enabled;
}

/**
 * PII-free organization metadata attached to a `tenant`/`account` group profile.
 * Group properties describe the org (name/slug/status/age) and power group
 * analytics: per-tenant funnels, retention, and cohorts by plan or age.
 */
export interface GroupProperties {
  name?: string;
  slug?: string;
  status?: string;
  created_at?: string;
}

export interface IdentifyParams {
  userId: string;
  email?: string;
  displayName?: string;
  /** The user's role in the active tenant/account — set as a person property. */
  role?: string;
  tenantId?: string;
  accountId?: string;
  /** Group-level properties for the active tenant (set on the `tenant` group). */
  tenant?: GroupProperties;
  /** Group-level properties for the active account (set on the `account` group). */
  account?: GroupProperties;
}

/**
 * Identify the current user and associate tenant/account groups.
 * Email/display name/role are attached to the identified person profile only —
 * never placed on custom event properties. When group properties are supplied
 * they are written to the group profile so group analytics can segment by org.
 *
 * The active tenant/account id + name are also mirrored onto super properties
 * (`tenant_id`/`tenant_name`/`account_id`/`account_name`) so EVERY event —
 * custom events, autocapture, pageviews, and errors — carries readable org
 * context without threading it through each call site. Super properties are
 * re-synced here on each identify (e.g. on tenant/account switch) and cleared
 * by `resetAnalytics()` on logout.
 */
export function identifyUser(params: IdentifyParams): void {
  if (!enabled) return;
  const { userId, email, displayName, role, tenantId, accountId, tenant, account } = params;
  if (!userId) return;

  try {
    posthog.identify(userId, {
      ...(email ? { email } : {}),
      ...(displayName ? { display_name: displayName } : {}),
      ...(role ? { role } : {}),
    });
    // Pass the 3rd arg only when properties exist, so plain association calls
    // (no metadata) keep PostHog's 2-arg group() signature.
    if (tenantId) {
      if (tenant) posthog.group('tenant', tenantId, tenant);
      else posthog.group('tenant', tenantId);
    }
    if (accountId) {
      if (account) posthog.group('account', accountId, account);
      else posthog.group('account', accountId);
    }

    // Mirror org identity (id + name) onto super properties, registering what
    // is present and unregistering what is absent so events never carry a stale
    // tenant/account after a switch.
    const toRegister: Record<string, string> = {};
    const toUnregister: string[] = [];
    if (tenantId) toRegister.tenant_id = tenantId;
    else toUnregister.push('tenant_id');
    if (tenant?.name) toRegister.tenant_name = tenant.name;
    else toUnregister.push('tenant_name');
    if (accountId) toRegister.account_id = accountId;
    else toUnregister.push('account_id');
    if (account?.name) toRegister.account_name = account.name;
    else toUnregister.push('account_name');
    if (Object.keys(toRegister).length > 0) posthog.register(toRegister);
    for (const key of toUnregister) posthog.unregister(key);
  } catch {
    // best-effort
  }
}

/**
 * Which product the mounted shell belongs to — `AppLayout` is the primary AI
 * application, `AgencyLayout` is Magick Agency
 * (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b: two shells, one per product).
 */
export type ProductSurface = 'ai' | 'agency';

/**
 * Who owns the currently registered `product`, or `null` when nobody does.
 *
 * Tracked here rather than read back off PostHog so `clearProductSurface` can
 * refuse to clear a value a DIFFERENT shell has since registered. Crossing
 * between the shells unmounts one layout and mounts the other in one commit,
 * and this makes the outcome the same whichever order those two effects run in:
 * the shell that mounted wins, and the one leaving cannot clobber it.
 */
let productSurface: ProductSurface | null = null;

/**
 * Register the product super-property for the shell that just mounted.
 *
 * A super property rather than an event property: every one of the ~200 event
 * call sites belongs to whichever shell is on screen, so threading a product
 * argument through them would be 200 chances to pass the wrong one — and would
 * still leave autocapture, pageviews and error events unattributed.
 */
export function setProductSurface(product: ProductSurface): void {
  productSurface = product;
  if (!enabled) return;
  try {
    posthog.register({ product });
  } catch {
    // best-effort
  }
}

/**
 * Unregister it when that shell unmounts, so a surface outside BOTH shells —
 * login, onboarding, super-admin — sends events carrying no `product` at all.
 *
 * Absent is the deliberate answer. A stale value is worse than a missing one:
 * `product: 'agency'` on a login-page event is indistinguishable from a real
 * one, and would quietly misattribute whole funnels to whichever shell happened
 * to mount last.
 *
 * Pass the product you registered — a shell may only clear its own.
 */
export function clearProductSurface(product: ProductSurface): void {
  if (productSurface !== product) return;
  productSurface = null;
  if (!enabled) return;
  try {
    posthog.unregister('product');
  } catch {
    // best-effort
  }
}

/** Reset identity on logout. */
export function resetAnalytics(): void {
  // `reset()` drops every super property, `product` included, so the record of
  // who owns it goes with them: after a reset NOBODY owns the dimension, and a
  // record saying otherwise is a lie the next ownership decision reads.
  //
  // Bookkeeping rather than the fix for a live bug — the previous comment here
  // claimed "otherwise the next shell's clear is refused", which does not happen:
  // on the logout path the leaving shell clears the same product it set, so its
  // clear is allowed either way. The only observable difference is a redundant
  // `unregister` after a `reset` that already dropped the property. Kept because
  // the invariant — this variable mirrors what PostHog actually holds — is what
  // makes `clearProductSurface`'s ownership check mean anything.
  productSurface = null;
  if (!enabled) return;
  try {
    posthog.reset();
  } catch {
    // best-effort
  }
}

/**
 * Capture a product/interaction event. Properties MUST be PII-free
 * (IDs/labels/counts/paths only — never bodies, emails, phones, or contact data).
 */
export function captureEvent(name: string, props: Record<string, unknown> = {}): void {
  if (!enabled) return;
  try {
    posthog.capture(name, props);
  } catch {
    // best-effort
  }
}

/**
 * Capture a client-side error event. Properties MUST be PII-free
 * (IDs/status/path/message only — never bodies, emails, phones, or contact data).
 */
export function captureError(name: string, props: Record<string, unknown>): void {
  captureEvent(name, props);
}

/**
 * Read a boolean feature flag. Returns false when analytics is disabled or the
 * flag has not resolved yet, so callers can treat the result as a safe
 * default-off gate.
 */
export function isFeatureEnabled(flag: string): boolean {
  if (!enabled) return false;
  try {
    return posthog.isFeatureEnabled(flag) ?? false;
  } catch {
    return false;
  }
}

/**
 * Read a feature flag's value — `true`/`false` for boolean flags, or the
 * variant key (string) for multivariate flags. Returns undefined when
 * analytics is disabled or the flag is unresolved.
 */
export function getFeatureFlag(flag: string): boolean | string | undefined {
  if (!enabled) return undefined;
  try {
    return posthog.getFeatureFlag(flag);
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to feature-flag (re)loads. The callback fires once flags first
 * resolve and again whenever they change (e.g. after identify). Returns an
 * unsubscribe function; a no-op when analytics is disabled.
 */
export function onFeatureFlags(cb: () => void): () => void {
  if (!enabled) return () => {};
  try {
    return posthog.onFeatureFlags(cb) ?? (() => {});
  } catch {
    return () => {};
  }
}
