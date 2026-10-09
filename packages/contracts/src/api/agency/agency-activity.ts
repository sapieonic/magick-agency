/**
 * One campaign's audit trail, merged by the public API layer from BOTH audit stores.
 *
 * The two services keep separate databases with different schemas, so `source`
 * is not an implementation leak — it is the field that tells apart the two rows
 * a single Pause produces: the public API layer recorded that a supervisor pressed the button,
 * the dialer runtime recorded that the campaign actually transitioned. Rendering only one, or
 * folding them together, loses the distinction a reviewer is here for.
 */
export type ActivitySource = 'master' | 'core';

/**
 * What kind of principal a row is attributed to.
 *
 * `string` rather than a union, for the reason every other served vocabulary in
 * this client is: a value the public API layer adds must be a new thing to render, never a
 * console build break. {@link activityActorKind} narrows it.
 *
 * Four values reach the wire today — `'human'`, `'api_key'`, `'system'`, and
 * `'unknown'` for a row whose attribution was never recorded. That last one is
 * **not** in the public API layer's served `available_actor_types` vocabulary and never will
 * be: that list is the audit log's FILTER, and "not recorded" is an absence
 * rather than something to select. The public API layer says in as many words that this
 * client owns the label for it — see {@link activityActorKind}.
 */
export type ActivityActorType = string;

/**
 * Every key is always present — `display` names whoever or whatever acted.
 *
 * ── `type` is the recorded fact; `system` is the rendering flag ─────────────
 * They agree on every row the public API layer has written since its migration 067. They
 * deliberately DISAGREE on an older one, and collapsing them is a trap the public API layer's
 * own contract calls out: a pre-067 row reports `type: 'unknown'` (nothing was
 * recorded) while `system` keeps the inference the trail made before the column
 * existed, so historical rows render exactly as they always have.
 *
 * **So: read `system` to decide what to show, and `type` to know whether the
 * distinction was actually captured.** Rewriting a cell as `type === 'system'`
 * would flip every historical background row in every campaign trail to an
 * unhandled `'unknown'` — a visible rewrite of history, from a change whose
 * whole promise was that history renders unchanged.
 *
 * `user_id` is only ever set on a public API layer row: the dialer runtime has no user table, so its
 * `display` is an originator string that must not be rendered as a person. It
 * is also **null on a key-authenticated row** — the public API layer stops naming the key's
 * creator there, which was previously a defect, so an absent
 * `user_id` no longer means "no principal".
 */
export interface ActivityActor {
  type: ActivityActorType;
  /**
   * Whether to render this row as having no human behind it.
   *
   * See the interface header before assuming this is `type === 'system'` — on a
   * pre-067 row it is not.
   */
  system: boolean;
  user_id: string | null;
  /**
   * The platform API key that acted, when `type === 'api_key'`. Null otherwise,
   * including on every dialer runtime row — the dialer runtime has no notion of the public API layer's credentials.
   *
   * The CREDENTIAL, never the person who minted it. That person is one join away
   * in the public API layer and is deliberately not here: they are a fact about the credential
   * rather than about this action, and conflating the two is the whole defect.
   */
  api_key_id: string | null;
  display: string | null;
}

/** How a row's actor cell should read. */
export type ActivityActorKind = 'system' | 'api_key' | 'client' | 'person';

/**
 * Which of the four actor renderings a row gets.
 *
 * Order is the contract, and each step is load-bearing:
 *
 *  1. **`system` first**, off the flag rather than off `type`. It is the only
 *     branch a pre-067 row can take, and taking it keeps that row rendering as
 *     it always has (see {@link ActivityActor}).
 *  2. **`api_key` next.** A key row is never `system`, so this cannot swallow
 *     one — and it must come before the `core` check even though it cannot occur
 *     on a dialer runtime row today, because "the dialer runtime has no credentials" is the dialer runtime's fact to
 *     change, not an invariant this client should encode by ordering.
 *  3. **An dialer runtime row is the CLIENT**, not a person: the dialer runtime has no user table, so its
 *     originator string names the calling application.
 *  4. Otherwise a person — or, on a `'unknown'` the public API layer row, the best this client
 *     can say about one.
 *
 * There is no separate `'unknown'` rendering, and that is deliberate rather than
 * an omission. The public API layer publishes no label for it, and inventing a visible
 * "unattributed" badge for every row written before the upgrade would mark the
 * whole of a tenant's history as suspect to make a point about a column. The
 * row already renders whatever identity it has; the fact that the distinction
 * was never captured is a property of the DEPLOYMENT, not of that supervisor's
 * campaign.
 */
export function activityActorKind(row: {
  actor: ActivityActor;
  source: ActivitySource;
}): ActivityActorKind {
  if (row.actor.system) return 'system';
  if (row.actor.type === 'api_key') return 'api_key';
  if (row.source === 'core') return 'client';
  return 'person';
}

export interface ActivityRow {
  id: string;
  /** ISO 8601. */
  at: string;
  source: ActivitySource;
  action: string;
  actor: ActivityActor;
  target: { type: string | null; id: string | null };
  detail: Record<string, unknown>;
}

/**
 * How far back the trail can answer for.
 *
 * The dialer runtime's audit table is monthly-partitioned and the retention purge DROPs whole
 * partitions, so a campaign older than the window returns a partial trail that
 * looks like a complete one. `source` distinguishes a real horizon from the two
 * cases where there is none to state, and neither may be rendered as a date:
 *
 *  - `partition_bound` — `earliest_retained_at` is real.
 *  - `unbounded` — nothing has aged out yet; there is no horizon.
 *  - `unknown` — the horizon could not be determined. Say so; do not guess.
 */
export interface ActivityRetention {
  earliest_retained_at: string | null;
  source: 'partition_bound' | 'unbounded' | 'unknown' | string;
}

export interface ActivityPage {
  rows: ActivityRow[];
  /** `null` when the stream is exhausted. Opaque — never parse it. */
  next_cursor: string | null;
  /** `null` when `partial`, because half a count is not a total. */
  total: number | null;
  /**
   * The dialer runtime's half is missing. Always present, never inferred from absence — a key
   * that appeared only when something was wrong could not be told apart from a
   * client that forgot to read it, which is how a short list ships looking
   * complete.
   */
  partial: boolean;
  partial_reason: string | null;
  retention: ActivityRetention | null;
  /**
   * The action vocabulary the filter is built from, served by the public API layer.
   *
   * Optional because the console and server deploy independently: this client can be
   * running against a public API layer that predates the field. It is the only reason the
   * key is optional — a public API layer that serves it always serves it, on a degraded
   * page too, since the list does not come from dialer runtime.
   */
  available_actions?: ActivityActionOption[];
}

export interface ActivityFilters {
  /** Action names, applied to both stores. Empty means no filter. */
  actions?: string[];
  /** ISO 8601. */
  from?: string;
  to?: string;
}

/**
 * One entry of the action vocabulary, exactly as the public API layer serves it.
 *
 * This is deliberately not a hand-maintained list in this file: a copy would
 * drift from public API layer's `PLATFORM_AUDIT_ACTIONS` and the internal
 * handler's agency event types. The public API layer knows both halves, so
 * it publishes them on the response they filter (`available_actions`) and
 * nothing is copied.
 */
export interface ActivityActionOption {
  /** The wire value, sent back unchanged as the `action` filter. */
  value: string;
  label: string;
  /** The filter section this belongs under — "Campaign", "Calls", "Staffing". */
  group: string;
}

/**
 * The served vocabulary as a label lookup.
 *
 * Built per page rather than at module scope: the list arrives with the data,
 * and a module-level cache would be a copy again — one that outlived the
 * response it came from.
 */
export function activityActionLabels(
  available: readonly ActivityActionOption[] | undefined,
): ReadonlyMap<string, string> {
  return new Map((available ?? []).map((action) => [action.value, action.label] as const));
}

/**
 * The vocabulary in render order, split into its sections.
 *
 * The public API layer's order is kept as-is (campaign lifecycle, then calls, then staffing) —
 * re-sorting here would put "Auto-paused" next to "Created" alphabetically,
 * which reads as noise to someone scanning for the pause. Groups appear in the
 * order they are first seen, for the same reason.
 */
export function groupActivityActions(
  available: readonly ActivityActionOption[] | undefined,
): Array<{ label: string; actions: ActivityActionOption[] }> {
  const groups: Array<{ label: string; actions: ActivityActionOption[] }> = [];
  for (const action of available ?? []) {
    const existing = groups.find((group) => group.label === action.group);
    if (existing) existing.actions.push(action);
    else groups.push({ label: action.group, actions: [action] });
  }
  return groups;
}

/**
 * A readable label for an action, resolved against what the API returned and
 * falling back to the raw name.
 *
 * The fallback is load-bearing, not defensive: the served list is the set of
 * actions worth OFFERING as a filter, never a claim about what the trail can
 * contain, and a row this build does not recognise must still be legible rather
 * than blank — and obviously unrecognised rather than dressed up as something
 * else. Hiding it is the one omission this view cannot afford, so it survives an
 * older public API layer serving no vocabulary at all.
 */
export function activityActionLabel(
  action: string,
  labels: ReadonlyMap<string, string>,
): string {
  return labels.get(action) ?? action;
}
