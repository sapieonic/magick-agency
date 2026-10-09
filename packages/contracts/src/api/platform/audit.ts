// Every vocabulary on
// this surface (actions, resource types, products, actor types) is SERVED by the
// API, so nothing here is product-specific; the "agency subset" is the server's
// choice of what it serves. The `product` axis (`AuditProductOption`,
// `AuditLogFilters.product`, `available_products`) is single-valued in a
// one-product app and is a candidate deletion.

export interface AuditLogEntry {
  id: string;
  tenant_id: string;
  /**
   * The HUMAN who acted — and only ever that.
   *
   * ⚠️ Rows with no recorded `actor_type` may mean something else, which is why {@link AuditActorType} exists.
   * The public API layer's API-key branch loads `platform_api_keys.created_by` into the
   * request user, so a key-authenticated action without an `actor_type` wrote this column
   * with the id of whoever MINTED the credential, possibly years earlier — a row
   * indistinguishable from that person acting in a browser. The public API layer leaves it
   * null for a key and records the credential in {@link api_key_id} instead.
   *
   * The consequence for this client: `user_id === null` no longer means "no
   * human, therefore the system". Read `actor_type`.
   */
  user_id: string | null;
  /**
   * What KIND of principal acted. See {@link AuditActorType}.
   *
   * Optional AND nullable, and the two absences mean different things:
   *
   *  - **absent** — an older public API layer that predates the column (the console and server deploy independently, so this client can run against one).
   *  - **`null`** — a current public API layer serving a row with no recorded
   *    `actor_type`. The public API layer deliberately does not backfill: such a row
   *    carrying a `user_id` may be a person OR a creator-backed key, and that is
   *    not recoverable now, so stamping `'human'` on all of them would have made
   *    the trail assert something false.
   *
   * Both land on the same rendering, which is the legacy inference — see
   * {@link auditEntryActor}.
   */
  actor_type?: AuditActorType | null;
  /**
   * The platform API key that acted, when `actor_type === 'api_key'`.
   *
   * The credential, NOT the person who created it. That person is reachable in
   * the public API layer from `platform_api_keys.created_by` and is deliberately one join
   * away: they are a fact about the credential rather than about this action,
   * and conflating the two is the defect the column exists to remove. Nothing
   * here should present it as a human.
   */
  api_key_id?: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

/**
 * What kind of principal performed an audited action.
 *
 * `string` rather than a union of the three values the public API layer writes today, for the
 * same reason `group` and `product` are: a value the public API layer adds must be a new label
 * to render, never a console build break. {@link auditEntryActor} narrows it.
 */
export type AuditActorType = string;

/**
 * The actor axis as a filter option, served like the other three.
 *
 * `description` is the one addition over the other vocabularies, and it is
 * load-bearing rather than decorative: `api_key` and `system` both render as a
 * row with nobody's name on it, and they mean OPPOSITE things for an incident —
 * "someone used a credential" versus "nothing human was involved". Two short
 * labels cannot carry that on their own.
 */
export interface AuditActorTypeOption {
  value: string;
  label: string;
  description?: string;
}

/** What to render in an audit row's actor cell. */
export type AuditEntryActor =
  | { kind: 'human'; userId: string }
  | { kind: 'api_key'; apiKeyId: string | null }
  | { kind: 'system' }
  /** Written before the distinction was recorded — see {@link AuditLogEntry.actor_type}. */
  | { kind: 'legacy_human'; userId: string }
  | { kind: 'legacy_system' }
  /**
   * The public API layer recorded an actor kind this build does not know — a value newer than
   * this bundle, which {@link AuditActorType} being `string` exists to allow.
   *
   * Carries the raw `actorType` so the cell can render what the public API layer actually
   * said, and `userId` because a future kind may well have one. It is
   * deliberately NOT a `legacy_*` kind: those mean "nothing was recorded", and
   * this means "something was recorded that we cannot name" — which is the
   * whole distinction this variant exists to keep.
   */
  | { kind: 'unrecognized'; actorType: string; userId: string | null };

/**
 * How one row's actor cell should read.
 *
 * ── The rule this encodes, from the public API layer's own contract ──────────────────
 * **Never infer the actor from `user_id`.** `user_id === null ? 'System' : id`
 * is exactly what this page used to do, and it is a live
 * defect: a key-authenticated row now has a null `user_id`, so that reading
 * labels somebody's credential "System" — telling an operator nothing human was
 * involved in an action a credential performed. That is the opposite conclusion,
 * on the one page whose whole job is to be believable.
 *
 * ── …but a row that predates the column keeps the old reading ──────────────
 * An absent or `null` `actor_type` means the distinction was never captured, so
 * there is nothing to read and the legacy inference is the only thing available.
 * It is kept EXACTLY as it was, so historical rows render as they always have —
 * a display shift on old rows reads as the audit being rewritten. The two
 * `legacy_*` kinds are separate from `human`/`system` so a caller can tell a
 * recorded fact from an inferred one; they render identically today.
 *
 * `system` is not reachable through the legacy branch by accident: it is
 * returned only when the public API layer actually said `'system'`.
 *
 * ── The legacy branch is for a MISSING value, never an unknown one ─────────
 * `AuditActorType` is `string` on purpose, so the public API layer can add a kind without
 * breaking this build — which means a value like `service_account` will arrive
 * here one day. Sweeping it into the legacy branch would render it from
 * `user_id`: a `service_account` row with no user reads as "System", i.e. this
 * helper reinstating the exact inference it exists to remove, on a row where
 * the public API layer DID record the answer. Only `null`/`undefined` — a row with no recorded `actor_type` —
 * may take the legacy reading; anything else is `unrecognized` and renders as
 * what the public API layer said.
 */
export function auditEntryActor(entry: AuditLogEntry): AuditEntryActor {
  switch (entry.actor_type) {
    case 'human':
      // A `human` row always carries an id in practice; falling back to the
      // legacy system reading beats rendering an empty cell if one ever does not.
      return entry.user_id ? { kind: 'human', userId: entry.user_id } : { kind: 'legacy_system' };
    case 'api_key':
      return { kind: 'api_key', apiKeyId: entry.api_key_id ?? null };
    case 'system':
      return { kind: 'system' };
    case null:
    case undefined:
      return entry.user_id
        ? { kind: 'legacy_human', userId: entry.user_id }
        : { kind: 'legacy_system' };
    default:
      return {
        kind: 'unrecognized',
        actorType: entry.actor_type,
        userId: entry.user_id ?? null,
      };
  }
}

/**
 * One entry of the action vocabulary, exactly as the public API layer serves it.
 *
 * The public API layer owns the catalog it filters by, so it serves the
 * vocabulary on the response and nothing here is transcribed: a hand-kept copy
 * would drift, and a drift test comparing it to a second transcription of the
 * same list would stay green.
 */
export interface AuditActionOption {
  /** The wire value, sent back unchanged as the `action` filter. */
  value: string;
  label: string;
  /**
   * The filter section this belongs under — "Campaign", "Calls", "Staffing",
   * "Scheduling". Deliberately `string` and not a union: the public API layer adding a group
   * is a new heading in a dropdown, and it must not be a console build break.
   */
  group: string;
  /**
   * Which product's surface this action happens on — `'ai'` or `'agency'` today.
   *
   * A second axis, orthogonal to `group`: `group` says what KIND of thing
   * happened, `product` says which half of the subscription it happened on. They
   * do not nest — the public API layer's "Calls" group holds agency campaign actions and both
   * DNC ones.
   *
   * `string` and not a union, for the reason `group` is: the public API layer's own
   * `AuditProduct` gains `'platform'` the day it writes a platform-zone action,
   * and a union here would make that a console build break over a value this
   * client only renders and echoes back.
   *
   * Optional because the console and server deploy independently, so this client can
   * run against a public API layer that predates the axis. It is also what keeps the
   * product filter from contradicting the action filter — see
   * {@link groupAuditActions}.
   */
  product?: string;
}

/** The resource-type vocabulary, served the same way. Ungrouped — it is short. */
export interface AuditResourceTypeOption {
  value: string;
  label: string;
}

/**
 * The product vocabulary, served the same way and for the same reason.
 *
 * The public API layer derives an action's product from its key rather than storing it, so the
 * axis is a property of the catalog and not a column — which is exactly why it
 * rides on the response beside the actions it partitions rather than being a
 * list this client keeps. A hand-written copy of another
 * service's vocabulary cannot be checked against anything from here.
 */
export interface AuditProductOption {
  value: string;
  label: string;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
  /**
   * The vocabularies the three filters are built from, served by the public API layer.
   *
   * Optional for one reason and one reason only: the console and server deploy independently, so this client can be running against a
   * the public API layer that predates the fields. A public API layer that serves them always serves
   * them, on every page and under every filter — so absence means "older
   * the public API layer", never "nothing to offer this time".
   */
  available_actions?: AuditActionOption[];
  available_resource_types?: AuditResourceTypeOption[];
  available_products?: AuditProductOption[];
  available_actor_types?: AuditActorTypeOption[];
}

export interface AuditLogFilters {
  action?: string;
  resource_type?: string;
  /**
   * One product's actions. The public API layer expands it to an action list from the catalog
   * rather than querying a column.
   *
   * It composes with `action` as an AND, and the public API layer **400s** a pair that cannot
   * both hold (`?product=agency&action=schedule.failed`) rather than answering
   * with an empty page — an empty audit log reads as a statement about the
   * tenant. So the UI must not be able to build such a pair; the action control
   * is drawn from this product's actions alone, which makes the contradiction
   * unconstructible rather than validated against.
   */
  product?: string;
  /**
   * One kind of principal.
   *
   * A plain equality filter on the public API layer, so a row with a
   * null `actor_type` matches NO value — deliberately, and the page says so
   * rather than letting an operator read a short list as a complete one.
   */
  actor_type?: string;
  limit?: number;
  offset?: number;
}

/**
 * A served vocabulary as a label lookup.
 *
 * Built per response rather than at module scope: the list arrives with the
 * data, and a module-level cache would be a copy again — one that outlived the
 * response it came from. Shared by both vocabularies, which differ only in
 * whether they carry a `group`.
 */
export function auditOptionLabels(
  available: readonly { value: string; label: string }[] | undefined,
): ReadonlyMap<string, string> {
  return new Map((available ?? []).map((option) => [option.value, option.label] as const));
}

/**
 * The action vocabulary in render order, split into its sections.
 *
 * The public API layer's order is kept as-is (campaign lifecycle, then calls, then staffing,
 * then scheduling) — re-sorting here would scatter a lifecycle across the
 * alphabet, which reads as noise to someone scanning for the pause. Groups
 * appear in the order they are first seen, for the same reason.
 *
 * ── `product` narrows the list rather than validating a pair ────────────────
 * The public API layer 400s `?product=` and `?action=` that cannot both hold, because
 * answering with an empty page would read as "the agency side did nothing
 * today". A UI that can construct such a pair and then explains the 400 is the
 * worse half of that trade, so the action control is built from ONE product's
 * actions whenever a product is chosen — the contradiction has nowhere to come
 * from.
 *
 * An action carrying no `product` is excluded while a product is chosen, which
 * is the same answer the public API layer gives: `auditProductForAction` returns `null` for a
 * key outside its catalog, so the pair is unsatisfiable there too. In practice
 * this cannot bite — a public API layer old enough to serve actions without `product`
 * serves no `available_products` either, so the control that sets it is not on
 * screen.
 */
export function groupAuditActions(
  available: readonly AuditActionOption[] | undefined,
  product?: string,
): Array<{ label: string; actions: AuditActionOption[] }> {
  const groups: Array<{ label: string; actions: AuditActionOption[] }> = [];
  for (const action of available ?? []) {
    if (product && action.product !== product) continue;
    const existing = groups.find((group) => group.label === action.group);
    if (existing) existing.actions.push(action);
    else groups.push({ label: action.group, actions: [action] });
  }
  return groups;
}

/**
 * A readable label for a wire value, resolved against what the API returned and
 * falling back to the raw value.
 *
 * The fallback is load-bearing, not defensive: the served list is the set of
 * values worth OFFERING as a filter, never a claim about what the log can
 * contain, and a row this build does not recognise must still be legible rather
 * than blank — and obviously unrecognised rather than dressed up as something
 * else. An audit view cannot afford to hide the one row nobody anticipated, and
 * that row is the likeliest reason someone opened this page. It also keeps every
 * row readable against an older public API layer serving no vocabulary at all.
 */
export function auditLabel(value: string, labels: ReadonlyMap<string, string>): string {
  return labels.get(value) ?? value;
}
