import { describe, it, expect } from 'vitest';
import {
  PLATFORM_AUDIT_ACTION_VOCABULARY,
  PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY,
  PLATFORM_AUDIT_PRODUCT_VOCABULARY,
  PLATFORM_AUDIT_ACTOR_TYPE_VOCABULARY,
  AUDIT_PRODUCTS,
  auditActionsForProduct,
  auditProductForAction,
  type AuditActionGroup,
} from '../../../../src/audit/platform/vocabulary.js';
import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_ACTOR_TYPES,
  PLATFORM_AUDIT_RESOURCE_TYPES,
} from '../../../../src/audit/platform/catalog.js';
import { CAMPAIGN_ACTIVITY_ACTIONS } from '../../../../src/agency/agency-activity-actions.js';

/**
 * The vocabulary the console's Audit Log filters are built from.
 *
 * It replaced a hand-maintained copy of both catalog arrays in the console,
 * so the guarantee has to live here instead. Unlike the campaign trail's list,
 * every check below is total: `platform_audit_log` is owned by the platform, so
 * `catalog.ts` is the whole truth and nothing here is a transcription of a
 * store this repo cannot see.
 *
 * The type-level guards in the module catch all of this at `npm run lint`
 * already. These tests exist because vitest does not type-check: a source file
 * with a type error still runs, so without them `npm test` would pass on
 * exactly the drift the module is here to prevent.
 */

/**
 * Transcribed rather than derived, deliberately: `AuditActionGroup` is a type
 * and vitest does not type-check, so a runtime list is the only thing that can
 * fail under `npm test`. Add a group to the union and it must be added here too
 * — which is the point, since an unrecognised group renders outside every
 * section of the filter rather than as an obvious bug.
 */
const GROUPS: readonly AuditActionGroup[] = ['Campaign', 'Calls', 'Staffing', 'Team'];

const servedActions = PLATFORM_AUDIT_ACTION_VOCABULARY.map((action) => action.value);
const servedResourceTypes = PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY.map((type) => type.value);

describe('the platform audit action vocabulary', () => {
  /**
   * Adding an action to `PLATFORM_AUDIT_ACTIONS` and not here ships a filter
   * that cannot select rows the platform is already writing.
   */
  it('offers every action the platform writes', () => {
    const missing = (PLATFORM_AUDIT_ACTIONS as readonly string[])
      .filter((action) => !(servedActions as readonly string[]).includes(action)); // type-only cast (vitest does not type-check)

    expect(
      missing,
      `in PLATFORM_AUDIT_ACTIONS but not offered as a filter: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The other direction, and the worse failure: an option that always returns
   * an empty log reads to an operator as "this never happened".
   */
  it('offers nothing the platform does not write', () => {
    const unwritten = servedActions
      .filter((action) => !(PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(action));

    expect(
      unwritten,
      `offered as a filter but never written: ${unwritten.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The `Exclude` guards in the module compare unions, and a union collapses
   * duplicates — two entries with the same value would satisfy both directions
   * and render as the same option twice.
   */
  it('lists each action exactly once', () => {
    expect(new Set(servedActions).size).toBe(servedActions.length);
  });

  /**
   * The filter is rendered directly from this list, so an entry with no label
   * would render as a nameless option rather than as an obvious bug, and an
   * unknown group would render outside every section.
   */
  it('gives every entry a label and a known group', () => {
    for (const action of PLATFORM_AUDIT_ACTION_VOCABULARY) {
      expect(action.label.trim(), action.value).not.toBe('');
      expect(GROUPS, action.value).toContain(action.group);
    }
  });

  /**
   * The labels are deliberately NOT a reuse of the campaign trail's. That filter
   * renders inside one campaign and can say "Paused"; this one is tenant-wide
   * and the subject is not on the screen, so every label has to name it.
   *
   * Stated as the specific divergences rather than as "no label may match",
   * because some legitimately do — `agency_attempt.hung_up` is "Call ended by
   * agent" on both, and it is already self-standing. The point is that the two
   * lists are free to differ, not that they must.
   */
  it('labels the campaign-scoped actions self-standingly', () => {
    const campaignLabels = new Map(CAMPAIGN_ACTIVITY_ACTIONS.map((a) => [a.value, a.label] as const));
    const served = new Map(PLATFORM_AUDIT_ACTION_VOCABULARY.map((a) => [a.value, a.label] as const));

    expect(campaignLabels.get('agency_campaign.paused')).toBe('Paused');
    expect(served.get('agency_campaign.paused')).toBe('Campaign paused');

    expect(campaignLabels.get('agency_session.joined')).toBe('Agent joined');
    expect(served.get('agency_session.joined')).toBe('Agent joined session');

    /**
     * Every action the platform writes is about a campaign, a session, a schedule or a
     * number, and the label has to say which — a one-word lifecycle label is the
     * shape that only works on a scoped screen.
     */
    for (const [value, label] of served) {
      expect(label.trim().includes(' '), value).toBe(true);
    }
  });
});

describe('the platform audit resource-type vocabulary', () => {
  it('offers every resource type the platform writes', () => {
    const missing = (PLATFORM_AUDIT_RESOURCE_TYPES as readonly string[])
      .filter((type) => !(servedResourceTypes as readonly string[]).includes(type)); // type-only cast

    expect(
      missing,
      `in PLATFORM_AUDIT_RESOURCE_TYPES but not offered as a filter: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('offers nothing the platform does not write', () => {
    const unwritten = servedResourceTypes
      .filter((type) => !(PLATFORM_AUDIT_RESOURCE_TYPES as readonly string[]).includes(type));

    expect(
      unwritten,
      `offered as a filter but never written: ${unwritten.join(', ')}`,
    ).toEqual([]);
  });

  it('lists each resource type exactly once', () => {
    expect(new Set(servedResourceTypes).size).toBe(servedResourceTypes.length);
  });

  it('gives every entry a label', () => {
    for (const type of PLATFORM_AUDIT_RESOURCE_TYPE_VOCABULARY) {
      expect(type.label.trim(), type.value).not.toBe('');
    }
  });
});

/**
 * The product axis (E9) — reserved before anyone asked to filter by it, so the
 * checks here are what stop it rotting while nothing reads it.
 *
 * The type system already forces every entry to declare a product (`product` is
 * required on `AuditActionOption`, and the module's `Exclude` pairs make the
 * vocabulary total over `catalog.ts`). As with every other guard in this file,
 * these exist because vitest does not type-check.
 */
describe('the audit product axis', () => {
  it('assigns every offered action to a known product', () => {
    for (const action of PLATFORM_AUDIT_ACTION_VOCABULARY) {
      expect(AUDIT_PRODUCTS as readonly string[], action.value).toContain(action.product);
    }
  });

  it('offers exactly the products the actions use, each once', () => {
    const offered = PLATFORM_AUDIT_PRODUCT_VOCABULARY.map((p) => p.value);
    expect(new Set(offered).size).toBe(offered.length);
    expect([...offered].sort()).toEqual([...AUDIT_PRODUCTS].sort());
    for (const product of PLATFORM_AUDIT_PRODUCT_VOCABULARY) {
      expect(product.label.trim(), product.value).not.toBe('');
    }
  });

  /**
   * A product option that selects nothing reads to an operator as "this product
   * did nothing", which is the same failure the two-direction action checks
   * exist to prevent.
   */
  it('leaves no product without actions', () => {
    for (const product of AUDIT_PRODUCTS) {
      expect(auditActionsForProduct(product).length, product).toBeGreaterThan(0);
    }
  });

  it('partitions the actions — every action in exactly one product', () => {
    const expanded = AUDIT_PRODUCTS.flatMap((product) => auditActionsForProduct(product));
    expect(new Set(expanded).size).toBe(expanded.length);
    expect([...expanded].sort()).toEqual([...servedActions].sort());
  });

  /**
   * The classification itself, spot-checked where getting it wrong would be
   * invisible.
   *
   * `dnc_entry.*` is the case that matters: Q2 settled that do-not-call belongs
   * to the agency offering alone, and the action name carries no `agency_`
   * prefix — so a prefix-derived axis would file every DNC mark under the AI
   * product. That is exactly why the mapping is stated per action.
   */
  it('files DNC under agency (Q2), despite the AI-neutral action name', () => {
    expect(auditProductForAction('dnc_entry.created')).toBe('agency');
    expect(auditProductForAction('dnc_entry.deleted')).toBe('agency');
  });

  it('files the scheduler under the AI product and the campaign lifecycle under agency', () => {
    expect(auditProductForAction('agency_campaign.stopped')).toBe('agency');
    expect(auditProductForAction('agency_session.joined')).toBe('agency');
  });

  /**
   * A row whose action is absent from the catalog must still render — the module
   * header's rule for the vocabulary as a whole. So the axis answers `null`
   * rather than guessing a product for it.
   */
  it('answers null for an action it does not know, rather than guessing', () => {
    expect(auditProductForAction('user.invited')).toBeNull();
    expect(auditProductForAction('')).toBeNull();
    expect(auditProductForAction('agency_something.new')).toBeNull();
  });
});

/**
 * The actor-type axis, checked the same two ways as the others and
 * for the same reason: the module's `Exclude` pairs only fail `npm run lint`,
 * and vitest does not type-check.
 */
describe('the actor-type vocabulary', () => {
  const servedActorTypes = PLATFORM_AUDIT_ACTOR_TYPE_VOCABULARY.map((entry) => entry.value);

  it('serves every actor type the catalog defines, and no others', () => {
    expect([...servedActorTypes].sort()).toEqual([...PLATFORM_AUDIT_ACTOR_TYPES].sort());
  });

  it('has no duplicate values', () => {
    expect(new Set(servedActorTypes).size).toBe(servedActorTypes.length);
  });

  it('labels every entry, in operator vocabulary rather than the schema\'s', () => {
    for (const entry of PLATFORM_AUDIT_ACTOR_TYPE_VOCABULARY) {
      expect(entry.label.length, entry.value).toBeGreaterThan(0);
      expect(entry.label, entry.value).not.toBe(entry.value);
      expect(entry.description.length, entry.value).toBeGreaterThan(0);
    }
  });

  /**
   * Rows written before migration 067 carry a NULL `actor_type` and are not
   * offerable as a filter: "not recorded" is an absence, and an option for it
   * would be a date range wearing a different name.
   */
  it('offers no option for an unrecorded actor', () => {
    expect(servedActorTypes).not.toContain('unknown');
    expect(servedActorTypes).not.toContain(null);
  });
});
