/**
 * Status/role display helpers for the Super Admin UI.
 *
 * Deliberately SEPARATE from the customer `vocabulary.ts`: Super Admin users are
 * technical operators, so we KEEP operational terms (active / retired / deleted /
 * tenant_admin) instead of the customer "zero-jargon" labels. This module only
 * normalizes casing and attaches a consistent color/tone — it never rewrites a
 * status into friendlier copy. Everything here is DISPLAY-ONLY and never changes
 * values sent to or received from the backend.
 *
 * Surfaces import `saStatusMeta` (or the `saStatusColor` / `saStatusLabel`
 * convenience helpers) instead of hand-rolling `status.replace(/_/g, ' ')` or
 * scattering color literals.
 */

/** Coarse tone used to pick a color for a status. */
export type SaTone = 'positive' | 'neutral' | 'warning' | 'negative';

export interface SaStatusMeta {
  /** Title-cased, human-readable label (never leaks snake_case). */
  label: string;
  /** CSS custom-property color expression for the tone. */
  color: string;
  /** Coarse tone for color selection. */
  tone: SaTone;
}

/** Tone → design-token color. */
const TONE_COLOR: Record<SaTone, string> = {
  positive: 'var(--success)',
  neutral: 'var(--text-muted)',
  warning: 'var(--warning)',
  negative: 'var(--danger)',
};

/**
 * Normalize a raw status into the lookup key used by the tone map: lowercased,
 * trimmed, with underscores collapsed to single spaces. Mirrors the approach in
 * `vocabulary.normalizeStatusKey` so the same keys work across surfaces.
 */
function normalizeStatusKey(raw: string): string {
  return raw.toLowerCase().trim().replace(/_+/g, ' ').replace(/\s+/g, ' ');
}

/** Title-case a normalized (space-separated) key so we never show raw snake_case. */
function titleCase(key: string): string {
  return key
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Normalized status key → tone. Keys are space-separated, lowercase. */
const STATUS_TONE: Record<string, SaTone> = {
  // positive
  active: 'positive',
  enabled: 'positive',
  available: 'positive',
  assigned: 'positive',
  connected: 'positive',
  healthy: 'positive',
  // neutral
  inactive: 'neutral',
  disabled: 'neutral',
  unassigned: 'neutral',
  unknown: 'neutral',
  // warning
  retired: 'warning',
  pending: 'warning',
  reserved: 'warning',
  provisioning: 'warning',
  degraded: 'warning',
  // negative
  deleted: 'negative',
  released: 'negative',
  suspended: 'negative',
  blocked: 'negative',
  failed: 'negative',
  error: 'negative',
};

/**
 * Resolve a raw status into a label + color + tone for the Super Admin UI.
 * Unknown statuses are title-cased and treated as neutral, so the UI degrades
 * gracefully and never leaks snake_case. Null / undefined / empty → "Unknown".
 */
export function saStatusMeta(raw: string | null | undefined): SaStatusMeta {
  const key = normalizeStatusKey(raw ?? '');
  if (!key) {
    return { label: 'Unknown', color: TONE_COLOR.neutral, tone: 'neutral' };
  }
  const tone = STATUS_TONE[key] ?? 'neutral';
  return { label: titleCase(key), color: TONE_COLOR[tone], tone };
}

/** Convenience: just the tone color for a status. */
export function saStatusColor(raw: string | null | undefined): string {
  return saStatusMeta(raw).color;
}

/** Convenience: just the title-cased label for a status. */
export function saStatusLabel(raw: string | null | undefined): string {
  return saStatusMeta(raw).label;
}

/** Known RBAC roles → friendly label. Display-only. */
const ROLE_LABELS: Record<string, string> = {
  agent: 'Agent',
  viewer: 'Viewer',
  operator: 'Operator',
  account_admin: 'Account admin',
  tenant_admin: 'Tenant admin',
  tenant_owner: 'Tenant owner',
};

/**
 * Friendly label for an RBAC role. Known roles use the canonical label; unknown
 * roles are title-cased with underscores replaced by spaces. Null / empty → "—".
 */
export function roleLabel(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '—';
  const known = ROLE_LABELS[trimmed.toLowerCase()];
  if (known) return known;
  return titleCase(normalizeStatusKey(trimmed));
}
