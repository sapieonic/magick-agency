#!/bin/sh
# Writes the two files that let the mobile app open invite links (Universal Links on iOS,
# App Links on Android), from the web container's environment, at every container start.
# docker/web.Dockerfile installs it as /docker-entrypoint.d/40-mobile-app-links.sh, which
# the nginx image runs before nginx starts; docker/nginx.conf serves the results at
#   /.well-known/apple-app-site-association   (when MOBILE_IOS_APP_IDS is set)
#   /.well-known/assetlinks.json              (when MOBILE_ANDROID_CERT_SHA256 is set)
# as application/json, with no redirect.
#
#   MOBILE_IOS_APP_IDS          TEAMID.bundle.id, comma-separated (TEAMID: 10 characters)
#   MOBILE_ANDROID_PACKAGE      default com.magickagency.agent
#   MOBILE_ANDROID_CERT_SHA256  SHA-256 fingerprints of the Play App Signing certificate
#                               (and an upload or debug key, if wanted), comma-separated,
#                               AA:BB:... (64 hex digits; case and separators normalised)
#
# A file whose variable is unset or empty, or holds a value that does not validate, is NOT
# written (and a stale one from an earlier start is removed), so nginx answers 404. A bad
# file is worse than none: iOS caches the association, and a wrong fingerprint silently
# disables verification. Never fails the container: the console must come up either way.
# MOBILE_APP_LINKS_DIR overrides the output directory (the tests use it).
#
# The AASA covers ONLY /agency/join/* (the agent invite link). Android App Links cannot be
# narrowed here (assetlinks.json has no paths); the app's manifest intent filter names the
# same prefix.

set -u

OUT="${MOBILE_APP_LINKS_DIR:-/usr/share/nginx/app-links/.well-known}"
AASA="$OUT/apple-app-site-association"
ASSETLINKS="$OUT/assetlinks.json"
JOIN_PATH='/agency/join/*'

log() { echo "mobile-app-links: $*" >&2; }

# Comma-separated list -> one trimmed, non-empty item per line.
split_list() {
  printf '%s\n' "$1" | tr ',' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$'
}

# Items (one per line on stdin) -> a JSON array of strings. Only called with values that
# already passed a regex allowing no quote, backslash or control character.
json_array() {
  awk 'BEGIN { printf "[" } { printf "%s\"%s\"", (NR > 1 ? ", " : ""), $0 } END { printf "]" }'
}

mkdir -p "$OUT" || { log "cannot create $OUT; no app link files"; exit 0; }
rm -f "$AASA" "$ASSETLINKS"

# ── iOS: apple-app-site-association ─────────────────────────────────────────
ios_ids="${MOBILE_IOS_APP_IDS:-}"
if [ -z "$ios_ids" ]; then
  log "MOBILE_IOS_APP_IDS unset: not serving apple-app-site-association"
else
  ids="$(split_list "$ios_ids")"
  bad="$(printf '%s\n' "$ids" | grep -Ev '^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$' || true)"
  if [ -z "$ids" ] || [ -n "$bad" ]; then
    log "MOBILE_IOS_APP_IDS has an invalid app ID ($(printf '%s' "$bad" | tr '\n' ' ')); expected TEAMID.bundle.id: not serving apple-app-site-association"
  else
    tmp="$AASA.tmp"
    {
      printf '{"applinks":{"details":[{"appIDs":%s,' "$(printf '%s\n' "$ids" | json_array)"
      printf '"components":[{"/":"%s","comment":"Agent invite links"}]}]}}\n' "$JOIN_PATH"
    } > "$tmp" && mv "$tmp" "$AASA" && log "wrote $AASA"
  fi
fi

# ── Android: assetlinks.json ────────────────────────────────────────────────
package="${MOBILE_ANDROID_PACKAGE:-com.magickagency.agent}"
certs="${MOBILE_ANDROID_CERT_SHA256:-}"
if [ -z "$certs" ]; then
  log "MOBILE_ANDROID_CERT_SHA256 unset: not serving assetlinks.json"
elif ! printf '%s\n' "$package" | grep -Eq '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'; then
  log "MOBILE_ANDROID_PACKAGE '$package' is not a package name: not serving assetlinks.json"
else
  # Normalise each fingerprint to AA:BB:… upper case, whatever separators it came with.
  fps="$(split_list "$certs" | tr 'a-f' 'A-F' | tr -d ': ' | sed -e 's/\(..\)/\1:/g' -e 's/:$//')"
  bad="$(printf '%s\n' "$fps" | grep -Ev '^([0-9A-F]{2}:){31}[0-9A-F]{2}$' || true)"
  if [ -z "$fps" ] || [ -n "$bad" ]; then
    log "MOBILE_ANDROID_CERT_SHA256 has a value that is not a SHA-256 fingerprint: not serving assetlinks.json"
  else
    tmp="$ASSETLINKS.tmp"
    {
      printf '[{"relation":["delegate_permission/common.handle_all_urls"],'
      printf '"target":{"namespace":"android_app","package_name":"%s",' "$package"
      printf '"sha256_cert_fingerprints":%s}}]\n' "$(printf '%s\n' "$fps" | json_array)"
    } > "$tmp" && mv "$tmp" "$ASSETLINKS" && log "wrote $ASSETLINKS"
  fi
fi

exit 0
