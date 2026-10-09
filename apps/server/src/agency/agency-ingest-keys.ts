/**
 * The S3 key shapes under `agency-ingest/`, and the one question a route may ask
 * about a CLIENT-SUPPLIED key: is it an upload this tenant may read back?
 *
 * Deliberately import-free, and a module of its own rather than a helper inside
 * the route file or the ingest service: both of those are mocked wholesale by
 * the route suites, and the writer of a key and the checker of it must read the
 * same definition — two hand-written templates is how the gap below opened.
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 * Two kinds of object live under `agency-ingest/{tenant}/`: the operator's own
 * UPLOAD (`…/{uploadId}/{file}`) and the server-written REJECTED-ROWS EXPORT
 * (`…/{jobId}/rejected-rows.csv`). The ownership check was a bare tenant-prefix
 * test, so both passed it — and the export's key is derived from nothing but the
 * JOB ID. An account-scoped caller who knew a sibling account's job id could
 * therefore skip the (now account-scoped) `GET …/rejected.csv` entirely and name
 * the export as an `s3_key`: `POST /ingest/analyze` handed back its headers and
 * sample values, and a dry-run `POST /ingest/jobs` re-ingested it into a job the
 * caller owned, whose own rejected-rows download then served the sibling's PII.
 *
 * A rejected export is never a legitimate client-supplied key — nothing in the
 * product uploads one by name; an operator who fixes one re-uploads it, which
 * mints a fresh upload key — so it is refused outright rather than checked
 * against an account. The upload route renames a file that would collide with
 * the export's name, so the refusal can never catch a genuine upload.
 *
 * ── Why an UPLOAD key is tenant-bound and not account-bound ─────────────────
 * The export's key was derivable from a job id, which siblings can learn. An
 * upload's is not: its id is a `crypto.randomUUID()` minted per upload, handed
 * back only in the uploader's own 201, and served by no route afterwards (the
 * job view carries `has_rejected_export`, never a key). Holding one is
 * therefore already proof of having uploaded it. Adding an account segment
 * would be defence in depth that also breaks every key minted before it — an
 * operator mid-wizard across a deploy — so it is deliberately not done. If a
 * route ever serves an upload key back (a job list, an audit `details`), this
 * stops being true and the key needs the account in it.
 */

const PREFIX = 'agency-ingest';

/** The basename every rejected-rows export is written under. */
export const REJECTED_EXPORT_FILE_NAME = 'rejected-rows.csv';

/** Where the ingest service writes a job's rejected rows. */
export function rejectedExportKey(tenantId: string, jobId: string): string {
  return `${PREFIX}/${tenantId}/${jobId}/${REJECTED_EXPORT_FILE_NAME}`;
}

/**
 * The key the upload route mints. `safeName` is the already-sanitised file name;
 * a name that would collide with the rejected export's is prefixed so the key
 * stays recognisable as an upload.
 */
export function uploadKey(tenantId: string, uploadId: string, safeName: string): string {
  const base = safeName.length > 0 ? safeName : 'upload.csv';
  const name = base === REJECTED_EXPORT_FILE_NAME ? `upload-${base}` : base;
  return `${PREFIX}/${tenantId}/${uploadId}/${name}`;
}

/**
 * May this tenant hand this key back to the analyzer or the ingest? True only
 * for the shape {@link uploadKey} mints — `agency-ingest/{tenant}/{id}/{name}`,
 * exactly four segments — and never for a rejected-rows export.
 *
 * The segment count is checked rather than a bare prefix so a key cannot pass on
 * its prefix alone. The id segment is NOT required to be a UUID: every key this
 * service mints has one, so the check would add nothing but a second definition
 * of the upload id.
 */
export function isTenantUploadKey(key: string, tenantId: string): boolean {
  const parts = key.split('/');
  if (parts.length !== 4) return false;
  const [prefix, tenant, id, name] = parts as [string, string, string, string];
  if (prefix !== PREFIX || tenant !== tenantId) return false;
  if (id.length === 0 || name.length === 0 || name === REJECTED_EXPORT_FILE_NAME) return false;
  return true;
}
