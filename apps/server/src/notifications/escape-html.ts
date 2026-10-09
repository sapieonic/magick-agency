/**
 * HTML-escape a value that is being interpolated into an email body.
 *
 * ── Why this is now one function instead of three copies ────────────────────
 * `job-completion.ts` and `agency-campaign-completion.ts` each carried a
 * byte-identical private copy, and the agent-invite template needed a third.
 * Three copies of an escaping routine is how one of them ends up missing a case:
 * the values passing through here are customer-authored (a tenant name, a
 * campaign name, an inviter's display name) and they land in a document that a
 * mail client renders. A tenant called `<script>` is not a hypothetical attack
 * so much as an ordinary way to break the layout of every mail sent about them.
 *
 * ── What it escapes, and the one it does NOT ────────────────────────────────
 * `&`, `<`, `>`, `"` — ampersand FIRST, or the replacement's own `&` would be
 * re-escaped by the later passes into `&amp;lt;`.
 *
 * `'` is deliberately absent, and that is safe only because of a rule the
 * callers keep: **every attribute in these templates is double-quoted.** A
 * single quote cannot terminate a double-quoted attribute, so it is inert. If a
 * template ever emits `href='...'`, this function becomes insufficient — which
 * is the reason the rule is stated here, at the escaper, rather than left as an
 * assumption in three template files.
 *
 * ── This is not a URL escaper ──────────────────────────────────────────────
 * A value going into an `href` needs the URL to be well-formed BEFORE it gets
 * here; this only stops it from breaking out of the attribute. Tokens and ids
 * that form part of a path are `encodeURIComponent`'d at the point they are
 * assembled into the URL.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
